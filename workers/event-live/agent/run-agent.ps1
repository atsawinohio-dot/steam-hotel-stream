# Launcher for the channel 21 control agent (called by "ROYS Event Control.bat").
#
# It exists so the agent's output is both visible in the window and written to
# E:\Steam Hotel\event-control.log in UTF-8 — Windows PowerShell 5.1's
# Tee-Object always writes UTF-16 and has no -Encoding switch, which makes the
# Thai log unreadable to anything that expects UTF-8.

$ErrorActionPreference = 'Continue'
$Log = 'E:\Steam Hotel\event-control.log'
$Agent = Join-Path $PSScriptRoot 'agent.mjs'

[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Content -Path $Log -Value ("=== {0} : {1} ===" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Agent) -Encoding UTF8

& node $Agent 2>&1 | ForEach-Object {
    $line = "$_"
    Write-Host $line
    Add-Content -Path $Log -Value $line -Encoding UTF8
}
