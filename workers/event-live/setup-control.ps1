# One-time setup for the channel 21 remote control (re-run to change the password).
#
# 1. Generates the control-page password, stores it as the worker secret
#    CONTROL_PASSWORD, and writes it to a file outside the repo.
# 2. Turns on OBS's built-in obs-websocket server (localhost only is used; the
#    existing auto-generated password is kept — the agent reads it from OBS's
#    own config file, so it never needs copying anywhere).
#
# OBS must be closed while this runs, or it will overwrite the websocket
# setting when it exits.

$ErrorActionPreference = 'Stop'
$PasswordFile = 'E:\Steam Hotel\event-control-password.txt'
$WsConfig = Join-Path $env:APPDATA 'obs-studio\plugin_config\obs-websocket\config.json'

if (Get-Process obs64 -ErrorAction SilentlyContinue) {
    throw 'Close OBS first, then run this again.'
}

# Readable password: three groups of four from an alphabet with no look-alike
# characters (no 0/o, 1/l/i), so it can be read off a screen and typed on a phone.
$alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'.ToCharArray()
$bytes = New-Object byte[] 12
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$chars = $bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] }
$password = (-join $chars[0..3]) + '-' + (-join $chars[4..7]) + '-' + (-join $chars[8..11])

Set-Content -Path $PasswordFile -Value $password -NoNewline -Encoding ascii
Push-Location $PSScriptRoot
try {
    # cmd's `<`, not a PowerShell pipe: Windows PowerShell appends CRLF to piped
    # input and wrangler would keep the `\r` as part of the secret.
    cmd /c "npx wrangler secret put CONTROL_PASSWORD < `"$PasswordFile`""
} finally {
    Pop-Location
}

$cfg = Get-Content $WsConfig -Raw | ConvertFrom-Json
$cfg.server_enabled = $true
$cfg.auth_required = $true
# Written without a BOM: Windows PowerShell's `-Encoding utf8` adds one, and a
# BOM in front of the JSON is enough for a strict parser to reject the file.
[System.IO.File]::WriteAllText($WsConfig, ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "Control page password: $password"
Write-Host "(also saved to $PasswordFile)"
Write-Host "obs-websocket enabled on port $($cfg.server_port)."
