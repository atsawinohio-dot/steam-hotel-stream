# ตรวจความพร้อมช่อง 21 ก่อนงานจริง — อ่านอย่างเดียว ไม่แตะอะไรทั้งนั้น
#
# มีไว้เพราะสิ่งที่พังในโปรเจกต์นี้พังแบบเงียบ ๆ: กล้องถูกถอดทิ้งไว้ข้ามคืน,
# ค่าที่ล็อกในกล้องหลุดกลับเป็น auto เอง (เฟรมเรตตกโดยไม่มีใครรู้), โปรแกรม
# ควบคุมถูกปิด, Camo แย่งกล้อง USB — ทุกอย่างนี้ดูปกติจนกว่าจะกดเริ่มถ่ายทอดสด
# แล้วถึงรู้ว่าไม่มีภาพ
#
#   .\preflight.ps1           รายงานแบบอ่านง่าย
#   .\preflight.ps1 -Quiet    พิมพ์เฉพาะบรรทัดสรุป (ให้บอทเรียกใช้)
#
# exit code: 0 = พร้อม, 1 = มีคำเตือน, 2 = ใช้งานไม่ได้

param([switch]$Quiet)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$CameraName  = 'USB 2.0 Camera'
$MicName     = 'Realtek USB2.0 MIC'
$StatusUrl   = 'https://steam-hotel-event.tiny-hall-8718.workers.dev/status'
$StatusFile  = 'E:\Steam Hotel\event-agent-status.json'
$Settings    = Join-Path $PSScriptRoot 'camera-settings.ps1'

$problems = @()   # ใช้งานไม่ได้จนกว่าจะแก้
$warnings = @()   # ใช้ได้ แต่ควรรู้ไว้
$lines    = @()

function Add-Line([string]$mark, [string]$text) { $script:lines += "$mark $text" }

# --- กล้อง: มีตัวตนอยู่ในเครื่องไหม -------------------------------------------
$cam = Get-PnpDevice -Class Camera -ErrorAction SilentlyContinue |
       Where-Object { $_.FriendlyName -eq $CameraName }
if (-not $cam) {
    $problems += "ไม่พบกล้อง '$CameraName' ในเครื่องเลย"
    Add-Line '[X]' "กล้อง USB: ไม่พบอุปกรณ์"
} elseif (-not $cam.Present) {
    # นี่คือเคสที่เจอเช้า 2026-09-14: สายถูกถอดไว้ตั้งแต่เมื่อคืน
    $problems += "กล้อง '$CameraName' ถูกถอดสายอยู่ (Present=False) — เสียบสาย USB กลับก่อน"
    Add-Line '[X]' "กล้อง USB: ถอดสายอยู่"
} elseif ($cam.Status -ne 'OK') {
    $problems += "กล้อง '$CameraName' สถานะ $($cam.Status)"
    Add-Line '[X]' "กล้อง USB: สถานะ $($cam.Status)"
} else {
    Add-Line '[/]' "กล้อง USB: ต่ออยู่ ปกติ"
}

# --- ไมค์ของกล้อง (อุปกรณ์ตัวเดียวกัน คนละครึ่ง) ------------------------------
$mic = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -like "*$MicName*" }
if ($mic) { Add-Line '[/]' "ไมค์ในกล้อง: พบอุปกรณ์" }
elseif ($cam -and $cam.Present) { $warnings += "ไม่พบไมค์ '$MicName' ทั้งที่กล้องต่ออยู่" ; Add-Line '[!]' "ไมค์ในกล้อง: ไม่พบ" }

# --- ค่าที่ล็อกในกล้อง: ตัวเลขถูกไม่พอ ต้องเป็น manual ด้วย --------------------
if ($cam -and $cam.Present) {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $Settings 2>&1
    $want = @{ WhiteBalance = 5100; Gain = 96 }
    foreach ($name in 'WhiteBalance', 'Gain') {
        $line = $out | Where-Object { $_ -match "^$name\s" } | Select-Object -First 1
        if (-not $line) { $warnings += "อ่านค่า $name จากกล้องไม่ได้"; continue }
        $value = [int](($line -split '\s+')[1])
        $auto  = $line -match 'auto'
        if ($auto) { $problems += "$name หลุดกลับเป็น auto (ค่าที่ล็อกไว้ไม่มีผลแล้ว)" ; Add-Line '[X]' "$name : auto — ต้องล็อกกลับ" }
        elseif ($value -ne $want[$name]) { $warnings += "$name = $value (เอกสารระบุ $($want[$name]))" ; Add-Line '[!]' "$name : $value (ต่างจากเอกสาร)" }
        else { Add-Line '[/]' "$name : $value manual" }
    }
    foreach ($name in 'cam:Exposure', 'cam:Focus') {
        $line = $out | Where-Object { $_ -match "^$([regex]::Escape($name))\s" } | Select-Object -First 1
        if (-not $line) { continue }
        $short = $name -replace 'cam:', ''
        if ($line -match 'auto') {
            # exposure ที่เป็น auto = เฟรมเรตตกเหลือ ~12 fps เงียบ ๆ
            $problems += "$short หลุดกลับเป็น auto"
            Add-Line '[X]' "$short : auto — ต้องล็อกกลับ"
        } else {
            Add-Line '[/]' "$short : $(($line -split '\s+')[1]) manual"
        }
    }
}

# --- โปรแกรมควบคุม + ตัวควบคุม ------------------------------------------------
$program = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -like '*roys-event*control.ps1*' -and $_.ProcessId -ne $PID }
$agent = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -like '*agent.mjs*' }
if ($program) { Add-Line '[/]' 'โปรแกรมควบคุม: เปิดอยู่' }
else { $warnings += 'โปรแกรมควบคุมไม่ได้เปิด (สั่งจากมือถือได้ถ้าตัวควบคุมยังรัน แต่ไม่มียามเฝ้าและไม่มีหน้าต่างให้กด)'; Add-Line '[!]' 'โปรแกรมควบคุม: ปิดอยู่' }
if ($agent) { Add-Line '[/]' 'ตัวควบคุม (agent): รันอยู่' }
else { $problems += 'ตัวควบคุมไม่ได้รัน — สั่งงานจากมือถือจะไม่มีอะไรเกิดขึ้น'; Add-Line '[X]' 'ตัวควบคุม (agent): ไม่ได้รัน' }

# --- Camo แย่งกล้อง USB -------------------------------------------------------
if (Get-Process CamoStudio -ErrorAction SilentlyContinue) {
    $warnings += 'Camo Studio เปิดอยู่ — ถ้าใช้กล้อง USB มันจะแย่งกล้อง (ตัวควบคุมจะปิดให้ตอนกดเริ่ม)'
    Add-Line '[!]' 'Camo Studio: เปิดอยู่'
}

# --- ฝั่งเซิร์ฟเวอร์ + โควตา ---------------------------------------------------
try {
    $st = Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 20
    $pct = if ($st.dailyBudget) { [math]::Round(100 * $st.requestsToday / $st.dailyBudget) } else { 0 }
    if ($st.offAirForBudget) { $problems += 'โควตาวันนี้หมดแล้ว ช่อง 21 ออกอากาศไม่ได้จนถึง 07:00' }
    elseif ($pct -ge 70) { $warnings += "โควตาใช้ไปแล้ว $pct%" }
    Add-Line '[/]' ("เซิร์ฟเวอร์: ตอบปกติ · โควตา {0:N0}/{1:N0} ({2}%)" -f $st.requestsToday, $st.dailyBudget, $pct)
    if ($st.live) { Add-Line '[!]' 'ช่อง 21: กำลังออกอากาศอยู่ตอนนี้' }
} catch {
    $problems += "ติดต่อเซิร์ฟเวอร์ช่อง 21 ไม่ได้: $($_.Exception.Message)"
    Add-Line '[X]' 'เซิร์ฟเวอร์: ติดต่อไม่ได้'
}

# --- สรุป ---------------------------------------------------------------------
$verdict = if ($problems.Count) { 'ยังใช้งานไม่ได้' } elseif ($warnings.Count) { 'พร้อมใช้งาน (มีข้อควรรู้)' } else { 'พร้อมใช้งาน' }
$code    = if ($problems.Count) { 2 } elseif ($warnings.Count) { 1 } else { 0 }

if (-not $Quiet) {
    Write-Host ''
    Write-Host '  ตรวจความพร้อมช่อง 21' -ForegroundColor Cyan
    Write-Host ''
    $lines | ForEach-Object { Write-Host "  $_" }
    Write-Host ''
    if ($problems.Count) {
        Write-Host '  ต้องแก้ก่อนใช้งาน:' -ForegroundColor Red
        $problems | ForEach-Object { Write-Host "   - $_" }
        Write-Host ''
    }
    if ($warnings.Count) {
        Write-Host '  ข้อควรรู้:' -ForegroundColor Yellow
        $warnings | ForEach-Object { Write-Host "   - $_" }
        Write-Host ''
    }
    Write-Host "  => $verdict" -ForegroundColor $(if ($code -eq 2) { 'Red' } elseif ($code -eq 1) { 'Yellow' } else { 'Green' })
    Write-Host ''
}

$summary = "$verdict"
if ($problems.Count) { $summary += ' | ' + ($problems -join ' | ') }
elseif ($warnings.Count) { $summary += ' | ' + ($warnings -join ' | ') }
Write-Output $summary
exit $code
