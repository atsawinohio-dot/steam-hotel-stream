# Creates (or rotates) the upload token for channel 21 "Event".
#
# The same random value goes to two places: the worker's INGEST_TOKEN secret,
# and a file OUTSIDE the repo that start-event.ps1 reads. It is never printed.
# Rotating it just means running this again; the next start-event.ps1 run
# picks up the new file.

$ErrorActionPreference = 'Stop'
$TokenFile = 'E:\Steam Hotel\event-ingest-token.txt'

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

Set-Content -Path $TokenFile -Value $token -NoNewline -Encoding ascii
Push-Location $PSScriptRoot
try {
    # Feed the file through cmd's `<` rather than a PowerShell pipe: Windows
    # PowerShell appends CRLF to anything piped into a native program, and
    # wrangler stores the stray `\r` as part of the secret, so every upload
    # then fails with 401.
    cmd /c "npx wrangler secret put INGEST_TOKEN < `"$TokenFile`""
} finally {
    Pop-Location
}
Write-Host "Upload token saved to $TokenFile and set on the worker."
