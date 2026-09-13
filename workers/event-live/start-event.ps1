# Broadcasts OBS to channel 21 "Event".
#
#   OBS  --RTMP-->  ffmpeg (this script, localhost only)  --HLS over HTTPS PUT-->  steam-hotel-event worker
#
# OBS settings (Settings -> Stream): Service "Custom...", Server
# rtmp://127.0.0.1:1935/live, Stream Key "event". In Settings -> Output use a
# keyframe interval of 2s and a bitrate around 2500 Kbps (see AGENTS.md).
#
# ffmpeg only copies OBS's video/audio into 6s HLS segments (no re-encoding),
# so this adds almost no CPU load. When OBS stops streaming, ffmpeg exits,
# the channel is cleared, and the script waits for OBS again — leave the
# window open for the whole event and close it afterwards.
#
#   -Test   Loop "Steam Hotel.mp4" instead of waiting for OBS, to check the
#           whole chain end to end without a camera.

param([switch]$Test)

$ErrorActionPreference = 'Stop'
$TokenFile = 'E:\Steam Hotel\event-ingest-token.txt'
$TestClip = 'E:\Steam Hotel\Steam Hotel.mp4'
$Base = 'https://steam-hotel-event.tiny-hall-8718.workers.dev/live'

if (-not (Test-Path $TokenFile)) {
    throw "Missing $TokenFile - run setup-token.ps1 first."
}
$token = (Get-Content $TokenFile -Raw).Trim()
$authHeaders = @{ Authorization = "Bearer $token" }

function Clear-Channel {
    try {
        Invoke-RestMethod -Method Delete -Uri "$Base/" -Headers $authHeaders | Out-Null
    } catch {
        Write-Warning "Could not clear the channel: $($_.Exception.Message)"
    }
}

# From here on only ffmpeg runs. Windows PowerShell turns every line a native
# program writes to stderr into an error record once output is redirected,
# and with 'Stop' the first harmless ffmpeg warning would kill the broadcast.
$ErrorActionPreference = 'Continue'

$hlsOut = @(
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '6',
    '-method', 'PUT',
    '-http_persistent', '1',
    '-headers', "Authorization: Bearer $token`r`n",
    '-hls_segment_filename', "$Base/seg_%06d.ts",
    "$Base/index.m3u8"
)

if ($Test) {
    Clear-Channel
    Write-Host "TEST: looping $TestClip to channel 21. Ctrl+C to stop."
    # Re-encode to what OBS would send (720p, 2.5 Mbps, keyframe every 2s).
    & ffmpeg -hide_banner -loglevel warning -re -stream_loop -1 -i $TestClip `
        -map 0:v:0 -map 0:a:0 -vf scale=1280:720 -r 30 -c:v libx264 -preset veryfast -b:v 2500k -maxrate 2500k -bufsize 5000k `
        -g 60 -keyint_min 60 -sc_threshold 0 -c:a aac -b:a 128k -ar 48000 @hlsOut
    Clear-Channel
    exit
}

while ($true) {
    Clear-Channel
    Write-Host ""
    Write-Host "Waiting for OBS on rtmp://127.0.0.1:1935/live (key: event) ... press Start Streaming in OBS."
    & ffmpeg -hide_banner -loglevel warning -listen 1 -i 'rtmp://127.0.0.1:1935/live/event' -c copy @hlsOut
    Write-Host "OBS stopped streaming - channel 21 is off air."
    Start-Sleep -Seconds 2
}
