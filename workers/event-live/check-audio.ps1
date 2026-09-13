# Measure how loud channel 21 actually sounds, from the viewer's side.
#
# Run it WHILE the broadcast is live and someone is talking near the phone —
# the numbers are meaningless in an empty room, because the mic chain ends in a
# +20 dB gain filter that lifts the room's noise floor with it.
#
#   mean_volume  -30 .. -20 dB  speech is at a sensible level
#   max_volume   below about -3 dB  (no clipping; the limiter should hold -1 dB)
#
# Too quiet -> raise the "เพิ่มเสียง +20 dB" filter on the mic input in OBS.
# Too loud / mean above about -15 dB -> lower it.

param(
    [int] $Seconds = 15,
    [string] $Url = 'https://steam-hotel-event.tiny-hall-8718.workers.dev/live/index.m3u8'
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Base = ($Url -replace '/live/index\.m3u8$', '')
function Say($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

try {
    $st = Invoke-RestMethod -Uri "$Base/status" -TimeoutSec 30
    Say ("status: " + ($st | ConvertTo-Json -Compress))
    if (-not $st.live) {
        Say 'ช่อง 21 ยังไม่ออกอากาศ — เริ่มถ่ายทอดสดก่อน แล้วรันไฟล์นี้อีกครั้ง'
        exit 1
    }
} catch {
    Say ('เช็คสถานะไม่ได้: ' + $_.Exception.Message)
}

Say "กำลังอัดเสียงจากช่อง $Seconds วินาที แล้ววัดระดับ… (ให้คนพูดใกล้มือถือระหว่างนี้)"
# ffmpeg's own stderr is merged by cmd: a PowerShell redirect would turn every
# harmless ffmpeg warning into a terminating error.
$out = cmd /c "ffmpeg -hide_banner -loglevel info -i `"$Url`" -t $Seconds -af volumedetect -f null - 2>&1"
foreach ($line in $out) {
    if ($line -match 'mean_volume|max_volume|Audio:|n_samples') { Say ('ffmpeg | ' + $line) }
}
