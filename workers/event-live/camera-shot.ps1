# ส่องดูว่ากล้องช่อง 21 กำลังมองอะไรอยู่ + บอกว่าสว่างพอออกอากาศไหม
#
# ใช้ตอนเล็งกล้อง: หันกล้อง -> กดดู -> หันใหม่ -> กดดู จนกว่าจะได้มุมที่พอใจ
# ไม่ต้องเปิด OBS ไม่ต้องออกอากาศ ไม่กินโควตา
#
# ถ้า OBS เปิดอยู่จะแย่งกล้องกัน — สคริปต์จะบอกให้ปิด OBS ก่อน

param(
    [string] $Device = 'USB 2.0 Camera',
    [switch] $NoOpen          # ไม่ต้องเปิดรูปให้ดู เอาแค่ตัวเลข
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Say($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

if (Get-Process obs64 -ErrorAction SilentlyContinue) {
    Say 'OBS เปิดอยู่ — มันจองกล้องไว้ ปิด OBS ก่อนแล้วรันใหม่'
    Say '(หรือถ้า OBS เปิดอยู่แล้วอยากดูภาพ ให้ใช้ tune-image.mjs แทน)'
    exit 1
}

$shot = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'roys-camera.jpg'
$clip = Join-Path $env:TEMP 'roys-camera-shot.mkv'

Say 'กำลังดึงภาพจากกล้อง…'
# อัด 2 วินาทีแล้วเอาเฟรมท้าย ๆ เพราะเฟรมแรก ๆ ของกล้องตัวนี้ยังปรับตัวไม่เสร็จ
cmd /c "ffmpeg -hide_banner -loglevel error -y -f dshow -video_size 1920x1080 -rtbufsize 100M -i video=`"$Device`" -t 2 `"$clip`" 2>&1" | Out-Null
if (-not (Test-Path $clip)) {
    Say "เปิดกล้อง '$Device' ไม่ได้ — เช็กสาย USB หรือปิด Camo Studio ก่อน"
    exit 1
}

cmd /c "ffmpeg -hide_banner -loglevel error -y -i `"$clip`" -vf `"select=eq(n\,40)`" -vframes 1 `"$shot`" 2>&1" | Out-Null

# วัดความสว่างจากทั้งคลิป ไม่ใช่เฟรมเดียว
$statsDir = $env:TEMP
Push-Location $statsDir
cmd /c "ffmpeg -hide_banner -loglevel quiet -i `"$clip`" -vf `"signalstats,metadata=print:file=roys-cam-stats.txt`" -f null - 2>&1" | Out-Null
Pop-Location

$t = Get-Content (Join-Path $statsDir 'roys-cam-stats.txt') -ErrorAction SilentlyContinue
function Avg($key) {
    $v = $t | Select-String "signalstats.$key=" | ForEach-Object { [double](($_ -split '=')[-1]) }
    if ($v) { [math]::Round(($v | Measure-Object -Average).Average, 1) } else { $null }
}
$yavg = [int][math]::Round((Avg 'YAVG'), 0)

# มีตัวเลขเดียวเท่านั้นบนจอ เพราะเคยพิมพ์ "จุดสว่างที่สุด" ไว้ข้าง ๆ แล้วอ่านสลับกัน
# (จุดสว่างที่สุดมักเป็น 180+ แม้ทั้งภาพจะมืดสนิท มันคือแสงสะท้อนจุดเดียว)
# เกณฑ์มาจากที่วัดมาแล้ว: ต่ำกว่า ~25 ดันด้วยฟิลเตอร์ไม่ขึ้น ได้แต่ภาพเกรน
if     ($yavg -lt 25)  { $verdict = 'มืดเกินไป ใช้ไม่ได้'; $advice = 'ไฟส่องไม่ถึงตรงนี้ — ต้องเอาไฟมาส่องบริเวณที่กล้องจับ หรือหันกล้องไปทางที่ไฟส่องถึง' }
elseif ($yavg -lt 60)  { $verdict = 'ยังมืดอยู่';          $advice = 'จูนขึ้นได้บ้างแต่ภาพจะมีจุดสีรบกวน ถ้าเพิ่มไฟได้จะดีกว่ามาก' }
elseif ($yavg -lt 100) { $verdict = 'พอใช้ได้';            $advice = 'จูนแล้วน่าจะออกมาดี' }
else                   { $verdict = 'สว่างดี ใช้ได้เลย';   $advice = 'มุมนี้พร้อมจูนแล้ว' }

$line = '=' * 52
Write-Host ''
Write-Host $line
Write-Host ("   ความสว่างเฉลี่ย  {0}/255   ->   {1}" -f $yavg, $verdict)
Write-Host $line
Write-Host ''
Write-Host "   $advice"
Write-Host ''
Write-Host '   เกณฑ์:  ต่ำกว่า 25 = ใช้ไม่ได้ | 60 ขึ้นไป = พอจูนได้ | 100 ขึ้นไป = ดี'
Write-Host ''

Say "รูปอยู่ที่: $shot"
if (-not $NoOpen) { Start-Process $shot }
if ($yavg -ge 60) { Say 'พอใจมุมนี้แล้ว บอก Claude ให้จูนภาพต่อได้เลย' }
else { Say 'ยังไม่ต้องเรียกจูน — จูนตอนนี้ได้ภาพเกรนแน่นอน แก้ที่ไฟก่อน' }
