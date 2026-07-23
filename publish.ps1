# CCTT — publish the game to the unlisted web address.
# Run this after any change to cctt.html or the card pictures:
#   right-click this file -> Run with PowerShell
# Live address: https://cctt.laroxbarbershop.workers.dev/t-vk8q2wm7/

$src = $PSScriptRoot
$dst = Join-Path $src "worker\public\t-vk8q2wm7"

Copy-Item (Join-Path $src "cctt.html") (Join-Path $dst "index.html") -Force
Copy-Item (Join-Path $src "*.png") $dst -Exclude "cctt-connor.png","cctt-jimmycarr.png" -Force
Copy-Item (Join-Path $src "*.mp3") $dst -Force
Copy-Item (Join-Path $src "manifest.json") $dst -Force

Set-Location (Join-Path $src "worker")
npx wrangler deploy
