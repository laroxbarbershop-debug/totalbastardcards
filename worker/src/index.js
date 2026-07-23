// CCTT worker: static assets + match relay + accounts API.
// - /ws            WebSocket match/trade relay (Room Durable Object, blind forwarder)
// - /api/*         accounts + collection API backed by D1 (env.DB)
// - anything else  static assets (the game itself lives at /t-vk8q2wm7/)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z2-9]{4,8}$/.test(room)) {
        return new Response("bad room code", { status: 400 });
      }
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(req);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, env, url);
    }

    // a bare hit on the root lands on the game
    if (url.pathname === "/") {
      return Response.redirect(new URL("/t-vk8q2wm7/", url).toString(), 302);
    }

    return new Response("CCTT relay up", {
      headers: { "access-control-allow-origin": "*" },
    });
  },
};

/* ============================ accounts API ============================ */

const SESSION_DAYS = 90;
const PBKDF2_ITER = 100000;
const AWARD_COOLDOWN_MS = 60000;   // a real Top Trumps match takes minutes

// authoritative card pool for reward rolls — MUST stay in sync with the
// CARDS array in cctt.html (each entry is a card's img identity)
const CARD_IDS = [
  "cctt-adamjohnson.png", "cctt-archer.png", "cctt-bones.png", "cctt-borisbecker.png",
  "cctt-boygeorge.png", "cctt-cash.png", "cctt-chuck.png", "cctt-diddy.png",
  "cctt-ghetts.png", "cctt-glitter.png", "cctt-jb.png", "cctt-kelly.png",
  "cctt-knight.png", "cctt-lohan.png", "cctt-markymark.png", "cctt-mcafee.png",
  "cctt-odb.png", "cctt-oj.png", "cctt-oscar.png", "cctt-ourgeorge.png",
  "cctt-peter.png", "cctt-rdj.png", "cctt-rolf.png", "cctt-savile.png",
  "cctt-hue.png", "cctt-spector.png", "cctt-tim allen.png", "cctt-tyson.png",
  "cctt-winona.png", "weinstein.png",
];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
const bad = (msg, status = 400) => json({ error: msg }, status);

async function handleApi(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  let body = {};
  if (req.method === "POST") {
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch { return bad("invalid json"); }
  }

  try {
    switch (`${req.method} ${url.pathname}`) {
      case "POST /api/signup":  return await apiSignup(env, body);
      case "POST /api/login":   return await apiLogin(env, body);
      case "POST /api/recover": return await apiRecover(env, body);
      case "POST /api/logout":  return await apiLogout(req, env);
      case "POST /api/collection/award": return await apiAward(req, env);
      case "GET /api/collection":        return await apiCollection(req, env);
      case "POST /api/trade/propose": return await apiTradePropose(req, env, body);
      case "GET /api/trade/pending":  return await apiTradePending(req, env);
      case "POST /api/trade/accept":  return await apiTradeAccept(req, env, body);
      case "POST /api/trade/decline": return await apiTradeRespond(req, env, body, "declined");
      case "POST /api/trade/cancel":  return await apiTradeCancel(req, env, body);
      default: return bad("not found", 404);
    }
  } catch (e) {
    console.error("api error", url.pathname, e);
    return bad("server error", 500);
  }
}

/* ---------- crypto helpers (Web Crypto only, no dependencies) ---------- */

function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function randomHex(bytes) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function hashSecret(secret, saltHex) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: PBKDF2_ITER },
    key, 256);
  return bytesToHex(new Uint8Array(bits));
}

// constant-time equality for equal-length hex strings
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// recovery codes use the same lookalike-free charset as room codes
function makeRecoveryCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const raw = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += A[raw[i] % A.length];
    if (i % 4 === 3 && i < 15) s += "-";
  }
  return s;                    // e.g. K7MP-2XWQ-9RTF-HA3B
}
const normCode = c => (c || "").toUpperCase().replace(/[^A-Z2-9]/g, "");

/* ---------- sessions ---------- */

async function createSession(env, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(token, userId, now, now + SESSION_DAYS * 86400000).run();
  return token;
}

async function authUser(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  if (!m) return null;
  const row = await env.DB.prepare(
    "SELECT s.expires_at, u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1")
    .bind(m[1]).first();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username, token: m[1] };
}

/* ---------- routes ---------- */

async function apiSignup(env, { username, password }) {
  if (typeof username !== "string" || !/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return bad("username must be 3-20 letters, numbers or underscores");
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 100) {
    return bad("password must be at least 6 characters");
  }
  const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?1")
    .bind(username).first();
  if (existing) return bad("that name is taken", 409);

  const passSalt = randomHex(16);
  const recCode  = makeRecoveryCode();
  const recSalt  = randomHex(16);
  const [passHash, recHash] = await Promise.all([
    hashSecret(password, passSalt),
    hashSecret(normCode(recCode), recSalt),
  ]);

  const res = await env.DB.prepare(
    `INSERT INTO users (username, password_hash, password_salt, recovery_hash, recovery_salt, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(username, passHash, passSalt, recHash, recSalt, Date.now()).run();

  const token = await createSession(env, res.meta.last_row_id);
  // the recovery code is returned exactly once, here — only its hash is stored
  return json({ token, username, recoveryCode: recCode });
}

async function apiLogin(env, { username, password }) {
  if (typeof username !== "string" || typeof password !== "string") return bad("missing credentials");
  const user = await env.DB.prepare(
    "SELECT id, username, password_hash, password_salt FROM users WHERE username = ?1")
    .bind(username).first();
  // hash even when the user is unknown so the response time doesn't leak which names exist
  const hash = await hashSecret(password, user ? user.password_salt : randomHex(16));
  if (!user || !safeEqual(hash, user.password_hash)) return bad("wrong name or password", 401);
  const token = await createSession(env, user.id);
  return json({ token, username: user.username });
}

async function apiRecover(env, { username, recoveryCode, newPassword }) {
  if (typeof username !== "string" || typeof recoveryCode !== "string") return bad("missing details");
  if (typeof newPassword !== "string" || newPassword.length < 6 || newPassword.length > 100) {
    return bad("new password must be at least 6 characters");
  }
  const user = await env.DB.prepare(
    "SELECT id, username, recovery_hash, recovery_salt FROM users WHERE username = ?1")
    .bind(username).first();
  const hash = await hashSecret(normCode(recoveryCode), user ? user.recovery_salt : randomHex(16));
  if (!user || !safeEqual(hash, user.recovery_hash)) return bad("wrong name or recovery code", 401);

  const newSalt = randomHex(16);
  const newHash = await hashSecret(newPassword, newSalt);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?1, password_salt = ?2 WHERE id = ?3")
      .bind(newHash, newSalt, user.id),
    // recovering invalidates every existing session on the account
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(user.id),
  ]);
  const token = await createSession(env, user.id);
  return json({ token, username: user.username });
}

async function apiLogout(req, env) {
  const user = await authUser(req, env);
  if (user) await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(user.token).run();
  return json({ ok: true });
}

/* ---------- collection ---------- */

// The SERVER rolls the reward — the client only reports "I won a match"
// and learns which card it got. A cooldown blunts spam-claiming; the server
// can't verify a match actually happened (the game runs client-side), which
// is accepted for a friends-and-family game.
async function apiAward(req, env) {
  const user = await authUser(req, env);
  if (!user) return bad("not logged in", 401);

  const now = Date.now();
  const row = await env.DB.prepare("SELECT last_award_at FROM users WHERE id = ?1")
    .bind(user.id).first();
  if (row.last_award_at > now - AWARD_COOLDOWN_MS) return bad("too soon", 429);

  const img = CARD_IDS[crypto.getRandomValues(new Uint32Array(1))[0] % CARD_IDS.length];
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET last_award_at = ?1 WHERE id = ?2").bind(now, user.id),
    env.DB.prepare(
      `INSERT INTO collections (user_id, card_img, count) VALUES (?1, ?2, 1)
       ON CONFLICT(user_id, card_img) DO UPDATE SET count = count + 1`)
      .bind(user.id, img),
  ]);
  const owned = await env.DB.prepare(
    "SELECT count FROM collections WHERE user_id = ?1 AND card_img = ?2")
    .bind(user.id, img).first();
  return json({ img, count: owned.count });
}

async function apiCollection(req, env) {
  const user = await authUser(req, env);
  if (!user) return bad("not logged in", 401);
  const { results } = await env.DB.prepare(
    "SELECT card_img, count FROM collections WHERE user_id = ?1 AND count > 0")
    .bind(user.id).all();
  const collection = {};
  for (const r of results) collection[r.card_img] = r.count;
  return json({ collection });
}

/* ---------- trading ---------- */
// Hard rule enforced server-side on BOTH ends: you can only give away a card
// you hold as a duplicate (count > 1) — a trade never takes anyone to zero.

async function apiTradePropose(req, env, { toUsername, offerImg, wantImg }) {
  const user = await authUser(req, env);
  if (!user) return bad("not logged in", 401);
  if (!CARD_IDS.includes(offerImg) || !CARD_IDS.includes(wantImg)) return bad("unknown card");
  if (typeof toUsername !== "string") return bad("missing recipient");

  const to = await env.DB.prepare("SELECT id, username FROM users WHERE username = ?1")
    .bind(toUsername.trim()).first();
  if (!to) return bad("no player with that name", 404);
  if (to.id === user.id) return bad("you can't trade with yourself");

  const spare = await env.DB.prepare(
    "SELECT count FROM collections WHERE user_id = ?1 AND card_img = ?2")
    .bind(user.id, offerImg).first();
  if (!spare || spare.count <= 1) return bad("you can only offer a duplicate you own", 409);

  const dupe = await env.DB.prepare(
    `SELECT id FROM trades WHERE from_user = ?1 AND to_user = ?2
     AND offer_img = ?3 AND want_img = ?4 AND status = 'pending'`)
    .bind(user.id, to.id, offerImg, wantImg).first();
  if (dupe) return bad("that exact offer is already waiting for them", 409);

  await env.DB.prepare(
    `INSERT INTO trades (from_user, to_user, offer_img, want_img, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', ?5)`)
    .bind(user.id, to.id, offerImg, wantImg, Date.now()).run();
  return json({ ok: true });
}

async function apiTradePending(req, env) {
  const user = await authUser(req, env);
  if (!user) return bad("not logged in", 401);
  const q = `SELECT t.id, t.offer_img, t.want_img, t.created_at,
                    uf.username AS from_name, ut.username AS to_name
             FROM trades t
             JOIN users uf ON uf.id = t.from_user
             JOIN users ut ON ut.id = t.to_user
             WHERE t.status = 'pending' AND (t.to_user = ?1 OR t.from_user = ?1)
             ORDER BY t.created_at DESC`;
  const { results } = await env.DB.prepare(q).bind(user.id).all();
  const incoming = [], outgoing = [];
  for (const r of results) {
    (r.to_name === user.username ? incoming : outgoing).push({
      id: r.id, from: r.from_name, to: r.to_name,
      offerImg: r.offer_img, wantImg: r.want_img,
    });
  }
  return json({ incoming, outgoing });
}

async function apiTradeAccept(req, env, { tradeId }) {
  const user = await authUser(req, env);
  if (!user) return bad("not logged in", 401);
  const t = await env.DB.prepare(
    "SELECT id, from_user, to_user, offer_img, want_img, status FROM trades WHERE id = ?1")
    .bind(tradeId).first();
  if (!t || t.to_user !== user.id) return bad("no such trade", 404);
  if (t.status !== "pending") return bad("that trade was already settled", 409);

  // txguard rows are NOT NULL — each guard INSERTs a NULL only when its
  // precondition FAILS, turning failure into a SQL error that rolls back
  // the entire batch. All-or-nothing without real transactions.
  const g = (cond, ...binds) => env.DB.prepare(
    `INSERT INTO txguard (x) SELECT NULL WHERE NOT EXISTS (${cond})`).bind(...binds);
  try {
    await env.DB.batch([
      g("SELECT 1 FROM trades WHERE id = ?1 AND status = 'pending'", t.id),
      g("SELECT 1 FROM collections WHERE user_id = ?1 AND card_img = ?2 AND count > 1",
        t.from_user, t.offer_img),
      g("SELECT 1 FROM collections WHERE user_id = ?1 AND card_img = ?2 AND count > 1",
        t.to_user, t.want_img),
      env.DB.prepare("UPDATE trades SET status = 'accepted' WHERE id = ?1").bind(t.id),
      env.DB.prepare(
        "UPDATE collections SET count = count - 1 WHERE user_id = ?1 AND card_img = ?2")
        .bind(t.from_user, t.offer_img),
      env.DB.prepare(
        `INSERT INTO collections (user_id, card_img, count) VALUES (?1, ?2, 1)
         ON CONFLICT(user_id, card_img) DO UPDATE SET count = count + 1`)
        .bind(t.from_user, t.want_img),
      env.DB.prepare(
        "UPDATE collections SET count = count - 1 WHERE user_id = ?1 AND card_img = ?2")
        .bind(t.to_user, t.want_img),
      env.DB.prepare(
        `INSERT INTO collections (user_id, card_img, count) VALUES (?1, ?2, 1)
         ON CONFLICT(user_id, card_img) DO UPDATE SET count = count + 1`)
        .bind(t.to_user, t.offer_img),
    ]);
  } catch (e) {
    // a guard fired: someone's spare vanished since the offer was made
    return bad("trade no longer possible — one side no longer has a spare of that card", 409);
  }
  return json({ ok: true, gained: t.offer_img, gave: t.want_img });
}

async function apiTradeRespond(req, env, { tradeId }, status) {
  const user = await authUser(req, env);
  if (!user) return bad("not logged in", 401);
  const res = await env.DB.prepare(
    "UPDATE trades SET status = ?1 WHERE id = ?2 AND to_user = ?3 AND status = 'pending'")
    .bind(status, tradeId, user.id).run();
  if (!res.meta.changes) return bad("no such trade", 404);
  return json({ ok: true });
}

async function apiTradeCancel(req, env, { tradeId }) {
  const user = await authUser(req, env);
  if (!user) return bad("not logged in", 401);
  const res = await env.DB.prepare(
    "UPDATE trades SET status = 'cancelled' WHERE id = ?1 AND from_user = ?2 AND status = 'pending'")
    .bind(tradeId, user.id).run();
  if (!res.meta.changes) return bad("no such trade", 404);
  return json({ ok: true });
}

/* ============================ match relay ============================ */
// One Durable Object per room code. Two seats: host and guest.
// The worker just passes messages between the two players —
// all game logic lives in the game file (host runs the game).

export class Room {
  constructor() {
    this.sides = { host: null, guest: null };
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(req.url);
    const role = url.searchParams.get("role") === "host" ? "host" : "guest";
    const other = role === "host" ? "guest" : "host";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // seat rules: host must be first in, guest needs a waiting host
    let reject = null;
    if (this.sides[role]) reject = role === "host" ? "code_taken" : "seat_taken";
    else if (role === "guest" && !this.sides.host) reject = "no_match";
    if (reject) {
      server.send(JSON.stringify({ t: "err", code: reject }));
      server.close(1000, reject);
      return new Response(null, { status: 101, webSocket: client });
    }

    this.sides[role] = server;

    server.addEventListener("message", (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (d.t === "ping") {
        try { server.send('{"t":"pong"}'); } catch {}
        return;
      }
      const peer = this.sides[other];
      if (peer) { try { peer.send(ev.data); } catch {} }
    });

    const drop = () => {
      if (this.sides[role] === server) this.sides[role] = null;
      const peer = this.sides[other];
      if (peer) { try { peer.send('{"t":"peer_gone"}'); } catch {} }
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    if (role === "guest") {
      try { this.sides.host.send('{"t":"joined"}'); } catch {}
    }

    return new Response(null, { status: 101, webSocket: client });
  }
}
