# วัดระดับเสียงไมค์ช่อง 21 แบบไม่ต้องออกอากาศ (ไม่กินโควตา)
#
# ต่างจาก check-audio.ps1 ตรงที่ตัวนั้นวัดจาก "ช่องจริง" ซึ่งต้องเปิดไลฟ์ก่อน
# ตัวนี้อัดจากไมค์ตรง ๆ แล้วจำลองสายสัญญาณของ OBS ให้ จึงทดสอบได้ทุกเมื่อ
#
# วิธีใช้: ดับเบิลคลิก "Test Mic.bat" แล้ว "พูดใกล้กล้องตามปกติ" ตลอดเวลาที่อัด
#
# เป้าหมาย: mean -30..-20 dB, max ต่ำกว่า -3 dB
#
# ค่ากำลังขยายอ่านสดจากไฟล์ฉาก OBS ทุกครั้ง สคริปต์จึงไม่มีวันบอกค่าเก่า

param(
    [int]    $Seconds = 12,
    [string] $Device  = 'Microphone (Realtek USB2.0 MIC)',
    [double] $TargetMean = -25.0,
    [string] $File = ''          # วิเคราะห์ไฟล์เสียงที่อัดไว้แล้วแทนการอัดใหม่
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Say($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }
function Db([double]$linear) {
    if ($linear -le 0) { return -100.0 }
    return [math]::Round(20 * [math]::Log10($linear), 1)
}

# ---- 1. อ่านสายสัญญาณจริงจากไฟล์ฉาก OBS -------------------------------------
$sceneFile = Join-Path $env:APPDATA 'obs-studio\basic\scenes\ROYS_Event.json'
$sourceName = 'ไมค์กล้อง USB'
$gainDb = 0.0; $faderDb = 0.0; $limitDb = -1.0; $hasRnnoise = $false

if (Test-Path $sceneFile) {
    $scene = Get-Content $sceneFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $src = $scene.sources | Where-Object { $_.name -eq $sourceName }
    if ($src) {
        $faderDb = Db $src.volume
        foreach ($f in $src.filters) {
            switch ($f.id) {
                'gain_filter'           { $gainDb  = [double]$f.settings.db }
                'limiter_filter'        { $limitDb = [double]$f.settings.threshold }
                'noise_suppress_filter' { $hasRnnoise = $true }
            }
        }
        if ($src.muted) { Say 'เตือน: ไมค์ตัวนี้ถูกปิดเสียงอยู่ในฉาก OBS — ออกอากาศจะเงียบสนิท' }
    } else {
        Say "หา source '$sourceName' ในไฟล์ฉากไม่เจอ — ใช้ค่า 0 dB แทน"
    }
} else {
    Say 'หาไฟล์ฉาก OBS ไม่เจอ — ใช้ค่า 0 dB แทน'
}

$netDb = $gainDb + $faderDb
Say ("สายสัญญาณตอนนี้: ฟิลเตอร์เพิ่มเสียง {0:+#.#;-#.#;0} dB, ตัวเลื่อนระดับ {1:+#.#;-#.#;0} dB  =>  รวม {2:+#.#;-#.#;0} dB" -f $gainDb, $faderDb, $netDb)
Say ("กันเสียงแตกที่ {0} dB  |  ตัดเสียงรบกวน RNNoise: {1}" -f $limitDb, $(if ($hasRnnoise) { 'เปิด' } else { 'ปิด' }))

# ---- 2. อัดเสียงจากไมค์ -----------------------------------------------------
$work = Join-Path $env:TEMP ('roys-mic-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
$raw = Join-Path $work 'raw.wav'

if ($File) {
    if (-not (Test-Path $File)) { Say "หาไฟล์ '$File' ไม่เจอ"; exit 1 }
    Copy-Item $File $raw -Force
    Say "ใช้ไฟล์เสียงที่มีอยู่แล้ว: $File"
} else {
    Say ''
    Say "*** พูดใกล้กล้องตามปกติ $Seconds วินาที เริ่มเดี๋ยวนี้ ***"
    cmd /c "ffmpeg -hide_banner -loglevel error -y -f dshow -i audio=`"$Device`" -t $Seconds `"$raw`" 2>&1" | Out-Null

    if (-not (Test-Path $raw)) {
        Say "อัดเสียงไม่สำเร็จ — เปิดไมค์ '$Device' ไม่ได้ (Camo หรือ OBS อาจยึดอุปกรณ์อยู่)"
        exit 1
    }
    Say 'อัดเสร็จ กำลังวัด…'
}

# ---- 3. วัดระดับ ------------------------------------------------------------
function Percentile([double[]]$values, [double]$p) {
    $s = $values | Sort-Object
    $i = [int][math]::Floor(($s.Count - 1) * $p)
    return $s[$i]
}

function Measure-Level([string]$file) {
    # ระดับรวมทั้งคลิป (เทียบกับเกณฑ์เดิมใน check-audio.ps1 ได้ตรง ๆ)
    $out = cmd /c "ffmpeg -hide_banner -loglevel info -i `"$file`" -af volumedetect -f null - 2>&1"
    $mean = $null; $max = $null
    foreach ($line in $out) {
        if ($line -match 'mean_volume:\s*(-?[\d.]+)') { $mean = [double]$Matches[1] }
        if ($line -match 'max_volume:\s*(-?[\d.]+)')  { $max  = [double]$Matches[1] }
    }

    # ระดับรายช่วงสั้น ๆ เอาไว้แยก "ตอนพูด" ออกจาก "ตอนเงียบ"
    $rmsFile = "$file.rms.txt"
    $dir = Split-Path $file -Parent
    Push-Location $dir
    cmd /c "ffmpeg -hide_banner -loglevel quiet -i `"$file`" -af `"astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=$(Split-Path $rmsFile -Leaf)`" -f null - 2>&1" | Out-Null
    Pop-Location

    $speech = $null; $floor = $null
    if (Test-Path $rmsFile) {
        $vals = @(Get-Content $rmsFile |
                  Select-String 'RMS_level=(-?[\d.]+)' |
                  ForEach-Object { [double]$_.Matches[0].Groups[1].Value } |
                  Where-Object { $_ -gt -120 })
        if ($vals.Count -ge 5) {
            $speech = [math]::Round((Percentile $vals 0.90), 1)   # ช่วงที่ดังที่สุด = ตอนพูด
            $floor  = [math]::Round((Percentile $vals 0.10), 1)   # ช่วงที่เงียบที่สุด = พื้นเสียงห้อง
        }
    }
    return [pscustomobject]@{ Mean = $mean; Max = $max; Speech = $speech; Floor = $floor }
}

# จำลอง OBS: ฟิลเตอร์เพิ่มเสียง -> กันเสียงแตก -> ตัวเลื่อนระดับ
$air = Join-Path $work 'air.wav'
$chain = "volume=${gainDb}dB,alimiter=limit=$([math]::Pow(10, $limitDb / 20)),volume=${faderDb}dB"
cmd /c "ffmpeg -hide_banner -loglevel error -y -i `"$raw`" -af `"$chain`" `"$air`" 2>&1" | Out-Null

$rawLvl = Measure-Level $raw
$airLvl = Measure-Level $air

Say ''
Say '================ ผลการวัด ================'
Say ("เสียงดิบจากไมค์      mean {0,6:N1} dB   max {1,6:N1} dB" -f $rawLvl.Mean, $rawLvl.Max)
Say ("ที่จะออกอากาศจริง    mean {0,6:N1} dB   max {1,6:N1} dB" -f $airLvl.Mean, $airLvl.Max)
if ($null -ne $airLvl.Speech) {
    Say ("   แยกเป็น  ตอนพูด {0,6:N1} dB   พื้นเสียงห้อง {1,6:N1} dB   ห่างกัน {2:N1} dB" -f $airLvl.Speech, $airLvl.Floor, ($airLvl.Speech - $airLvl.Floor))
}
Say ''

# ---- กันผลลวง: ถ้าไม่มีใครพูด ตัวเลขข้างบนคือเสียงห้องเปล่า ๆ ----------------
$gap = if ($null -ne $airLvl.Speech) { $airLvl.Speech - $airLvl.Floor } else { 99 }
if ($gap -lt 8) {
    Say 'ตรวจไม่พบเสียงพูด — เสียงดังสม่ำเสมอทั้งคลิป เหมือนเป็นเสียงห้องล้วน ๆ'
    Say 'ตัวเลขข้างบนจึงยังตัดสินไม่ได้ว่าระดับเสียงพูดเหมาะหรือยัง'
    Say ''
    Say ("พื้นเสียงห้องที่จะออกอากาศอยู่ที่ {0:N1} dB " -f $airLvl.Mean)
    if ($airLvl.Mean -gt -30) {
        Say 'ซึ่งถือว่าดังอยู่ — ถ้า RNNoise กดไม่ลง ผู้ชมจะได้ยินเสียงฮัมตลอดเวลา'
    }
    Say ''
    Say 'รันใหม่แล้ว "พูดใกล้กล้องตามปกติ" ตลอดเวลาที่อัด จึงจะสรุปได้'
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

# ---- 4. สรุป + คำแนะนำ ------------------------------------------------------
# ตัดสินจาก "ระดับตอนพูด" ไม่ใช่ค่าเฉลี่ยรวม เพราะค่าเฉลี่ยขึ้นกับว่าหยุดพูดนานแค่ไหน
$judge = if ($null -ne $airLvl.Speech) { $airLvl.Speech } else { $airLvl.Mean }
Say ("ตัดสินจากระดับตอนพูด {0:N1} dB (เกณฑ์ -30..-20 dB)" -f $judge)
Say 'ถ้าเมื่อกี้ไม่ได้พูดจริง ให้รันใหม่ — ตัวเลขจะเป็นเสียงห้องเปล่า ๆ'
Say ''

$ok = $true
if ($judge -gt -20) { Say 'ดังเกินไป'; $ok = $false }
elseif ($judge -lt -30) { Say 'เบาเกินไป'; $ok = $false }
else { Say 'ระดับเสียงอยู่ในเกณฑ์ดี' }

if ($airLvl.Max -gt -3) { Say ("เตือน: ยอดคลื่นสูงถึง {0:N1} dB เสี่ยงเสียงแตก" -f $airLvl.Max); $ok = $false }

if (-not $ok) {
    $needed = $TargetMean - $judge
    $newGain = [math]::Round($gainDb + $needed, 0)
    $newMax = $airLvl.Max + $needed
    Say ''
    Say ("แก้ยังไง: ใน OBS คลิกขวา source '$sourceName' -> ฟิลเตอร์ -> 'เพิ่มเสียง'")
    Say ("          เปลี่ยนจาก {0:+#.#;-#.#;0} dB เป็น {1:+#.#;-#.#;0} dB  (ขยับ {2:+#.#;-#.#;0} dB)" -f $gainDb, $newGain, $needed)
    if ($faderDb -lt -1) {
        Say ("หมายเหตุ: ตัวเลื่อนระดับของ source นี้ถูกดึงลงไว้ {0:N1} dB ซึ่งหักล้างฟิลเตอร์เพิ่มเสียงเกือบหมด" -f $faderDb)
        Say ("          ถ้าอยากให้ตรงกับที่เอกสารเขียนไว้ ให้ลากตัวเลื่อนในหน้าต่างผสมเสียงกลับไปที่ 0 dB")
        Say ("          แล้วตั้งฟิลเตอร์เพิ่มเสียงเป็น {0:+#.#;-#.#;0} dB แทน" -f [math]::Round($newGain + $faderDb, 0))
    }
    if ($newMax -gt -3) {
        Say ("          (ที่ค่าใหม่นี้ยอดคลื่นจะอยู่ราว {0:N1} dB — กันเสียงแตกจะทำงานบ่อย ลองลดลงอีกสัก 3 dB)" -f $newMax)
    }
}

if ($hasRnnoise) {
    Say ''
    Say 'หมายเหตุ: ตัวเลขนี้ยังไม่รวมผลของ RNNoise ที่ตัดเสียงรบกวน'
    Say '          ของจริงพื้นเสียงจะเงียบกว่านี้ ส่วนระดับเสียงพูดใกล้เคียงเดิม'
}

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Say ''
Say 'เสร็จแล้ว'
