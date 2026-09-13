# ROYS Hotel · โปรแกรมควบคุมช่อง 21 "Event" — the desktop half of the remote control.
#
# It owns the control agent (../agent/agent.mjs) instead of leaving it in a
# console window that nobody is supposed to close: it starts the agent hidden,
# restarts it if it ever dies, shows what the channel / OBS / phone are doing,
# and sends the same six commands the phone page sends.
#
# Everything here is local. Buttons go through E:\Steam Hotel\event-agent-command.txt
# and the display comes from event-agent-status.json, both written by the agent,
# so the window costs nothing against the worker's daily request budget and keeps
# working when Cloudflare is unreachable. While the window is open the program
# touches event-agent-watch.txt, which is the agent's cue to re-read OBS every
# two seconds so the mic meter is live.
#
# Started by "ROYS Event Control.bat" or the desktop shortcut, both of which go
# through launch.vbs so no console window flashes up.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

# launch.vbs starts PowerShell with the window hidden so no console flashes up,
# and Windows applies that same "hidden" to the first window the process shows —
# which would be this program's own window. ShowWindow undoes it explicitly.
Add-Type -Namespace Roys -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@

$Root        = 'E:\Steam Hotel'
$AgentScript = (Resolve-Path (Join-Path $PSScriptRoot '..\agent\agent.mjs')).Path
$IconFile    = Join-Path $PSScriptRoot 'roys-event.ico'
$LaunchVbs   = Join-Path $PSScriptRoot 'launch.vbs'
$StatusFile  = Join-Path $Root 'event-agent-status.json'
$CommandFile = Join-Path $Root 'event-agent-command.txt'
$WatchFile   = Join-Path $Root 'event-agent-watch.txt'
$PasswordFile= Join-Path $Root 'event-control-password.txt'
$LogFile     = Join-Path $Root 'event-control.log'
$ControlUrl  = 'https://steam-hotel-event.tiny-hall-8718.workers.dev/control'
$StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'ROYS Event Control.lnk'

# One window only: two copies would each run an agent, and the two agents would
# fight over the RTMP port and OBS.
$isNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\ROYS-Event-Control', [ref]$isNew)
if (-not $isNew) {
    [Windows.Forms.MessageBox]::Show(
        'โปรแกรมควบคุมช่อง 21 เปิดอยู่แล้ว' + [Environment]::NewLine +
        'ถ้าไม่เห็นหน้าต่าง ให้คลิกไอคอน “21” ตรงมุมขวาล่างของจอ (ถาดระบบ) — อาจต้องกดลูกศร ^ เพื่อดูไอคอนที่ซ่อนอยู่',
        'ROYS Event', 'OK', 'Information') | Out-Null
    return
}

# ------------------------------------------------------------------ look ----

$cBg    = [Drawing.Color]::FromArgb(11, 16, 32)
$cCard  = [Drawing.Color]::FromArgb(21, 28, 51)
$cText  = [Drawing.Color]::FromArgb(232, 236, 247)
$cMuted = [Drawing.Color]::FromArgb(150, 160, 190)
$cBlue  = [Drawing.Color]::FromArgb(90, 150, 245)
$cRed   = [Drawing.Color]::FromArgb(228, 78, 78)
$cGreen = [Drawing.Color]::FromArgb(60, 190, 120)
$cAmber = [Drawing.Color]::FromArgb(232, 170, 60)
$cGrey  = [Drawing.Color]::FromArgb(110, 120, 145)

$fontName = if ([Drawing.FontFamily]::Families.Name -contains 'Leelawadee UI') { 'Leelawadee UI' } else { 'Tahoma' }
function New-Font([single]$size, [string]$style = 'Regular') {
    New-Object Drawing.Font($fontName, $size, [Enum]::Parse([Drawing.FontStyle], $style))
}

function New-Label([string]$text, [int]$x, [int]$y, [int]$w, [int]$h, [Drawing.Font]$font, [Drawing.Color]$color) {
    $l = New-Object Windows.Forms.Label
    $l.Text = $text; $l.ForeColor = $color; $l.Font = $font
    $l.Location = New-Object Drawing.Point($x, $y)
    $l.Size = New-Object Drawing.Size($w, $h)
    $l.BackColor = [Drawing.Color]::Transparent
    return $l
}

function New-Button([string]$text, [int]$x, [int]$y, [int]$w, [int]$h, [Drawing.Color]$back, [Drawing.Color]$fore) {
    $b = New-Object Windows.Forms.Button
    $b.Text = $text
    $b.Location = New-Object Drawing.Point($x, $y)
    $b.Size = New-Object Drawing.Size($w, $h)
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
    $b.BackColor = $back; $b.ForeColor = $fore
    $b.Font = New-Font 10.5 'Bold'
    $b.Cursor = [Windows.Forms.Cursors]::Hand
    return $b
}

# A round dot in the tray, coloured by what the channel is doing: grey = the
# agent is not reporting, blue = ready, red = on air.
$iconCache = @{}
function Get-DotIcon([Drawing.Color]$color) {
    $key = $color.ToArgb().ToString()
    if ($iconCache.ContainsKey($key)) { return $iconCache[$key] }
    $bmp = New-Object Drawing.Bitmap(32, 32)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([Drawing.Color]::Transparent)
    $g.FillEllipse((New-Object Drawing.SolidBrush($color)), 2, 2, 27, 27)
    $g.Dispose()
    $icon = [Drawing.Icon]::FromHandle($bmp.GetHicon())
    $iconCache[$key] = $icon
    return $icon
}

# ----------------------------------------------------------- the window ----

$form = New-Object Windows.Forms.Form
$form.Text = 'ROYS Hotel · ควบคุมช่อง 21'
$form.ClientSize = New-Object Drawing.Size(440, 566)
$form.BackColor = $cBg
$form.ForeColor = $cText
$form.Font = New-Font 10
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
if (Test-Path $IconFile) { $form.Icon = New-Object Drawing.Icon($IconFile) }

$form.Controls.Add((New-Label 'ROYS Hotel · ช่อง 21 Event' 18 14 300 24 (New-Font 11 'Bold') $cMuted))

# --- what the channel is doing right now
$cardLive = New-Object Windows.Forms.Panel
$cardLive.Location = New-Object Drawing.Point(18, 46)
$cardLive.Size = New-Object Drawing.Size(404, 92)
$cardLive.BackColor = $cCard
$form.Controls.Add($cardLive)

$lblLive = New-Label 'กำลังเริ่มโปรแกรม…' 18 14 370 34 (New-Font 17 'Bold') $cText
$cardLive.Controls.Add($lblLive)
$lblLiveSub = New-Label '' 18 52 370 26 (New-Font 9.5) $cMuted
$cardLive.Controls.Add($lblLiveSub)

# --- the buttons that do something
$btnStart = New-Button '▶  เริ่มถ่ายทอดสด' 18 152 198 54 $cGreen ([Drawing.Color]::White)
$btnStop  = New-Button '■  หยุดถ่ายทอดสด' 224 152 198 54 $cRed ([Drawing.Color]::White)
$btnMic   = New-Button 'ปิดไมค์' 18 214 198 46 $cCard $cText
$btnScene = New-Button 'ภาพพักรอ' 224 214 198 46 $cCard $cText
$form.Controls.AddRange(@($btnStart, $btnStop, $btnMic, $btnScene))

# --- mic level
$form.Controls.Add((New-Label 'ระดับเสียงไมค์' 18 274 150 22 (New-Font 9.5) $cMuted))
$lblDb = New-Label '' 300 274 122 22 (New-Font 9.5) $cMuted
$lblDb.TextAlign = 'MiddleRight'
$form.Controls.Add($lblDb)

$meter = New-Object Windows.Forms.Panel
$meter.Location = New-Object Drawing.Point(18, 298)
$meter.Size = New-Object Drawing.Size(404, 14)
$meter.BackColor = $cCard
$form.Controls.Add($meter)

$meterFill = New-Object Windows.Forms.Panel
$meterFill.Location = New-Object Drawing.Point(0, 0)
$meterFill.Size = New-Object Drawing.Size(0, 14)
$meterFill.BackColor = $cGreen
$meter.Controls.Add($meterFill)

# --- the four things that can go wrong
$cardState = New-Object Windows.Forms.Panel
$cardState.Location = New-Object Drawing.Point(18, 326)
$cardState.Size = New-Object Drawing.Size(404, 128)
$cardState.BackColor = $cCard
$form.Controls.Add($cardState)

$rows = @{}
$rowNames = @(
    @('agent', 'ตัวควบคุมบนโน้ตบุ๊ก'),
    @('obs',   'OBS'),
    @('camo',  'กล้อง/ไมค์มือถือ'),
    @('cloud', 'เซิร์ฟเวอร์ + โควตาวันนี้')
)
$y = 12
foreach ($row in $rowNames) {
    $cardState.Controls.Add((New-Label $row[1] 16 $y 160 22 (New-Font 9.5) $cMuted))
    $value = New-Label '—' 176 $y 212 22 (New-Font 9.5 'Bold') $cText
    $value.TextAlign = 'MiddleRight'
    $cardState.Controls.Add($value)
    $rows[$row[0]] = $value
    $y += 28
}

$lblError = New-Label '' 18 458 404 34 (New-Font 9) $cAmber
$form.Controls.Add($lblError)

# --- footer: the phone page, the log, and whether to start with Windows
$btnLink = New-Button 'คัดลอกลิงก์หน้ามือถือ' 18 496 136 30 $cCard $cText
$btnPw   = New-Button 'คัดลอกรหัสผ่าน' 160 496 126 30 $cCard $cText
$btnLog  = New-Button 'เปิดบันทึก' 292 496 130 30 $cCard $cText
$btnLink.Font = New-Font 9; $btnPw.Font = New-Font 9; $btnLog.Font = New-Font 9
$form.Controls.AddRange(@($btnLink, $btnPw, $btnLog))

$chkAuto = New-Object Windows.Forms.CheckBox
$chkAuto.Text = 'เปิดโปรแกรมนี้อัตโนมัติเมื่อเปิดเครื่อง'
$chkAuto.Location = New-Object Drawing.Point(18, 532)
$chkAuto.Size = New-Object Drawing.Size(404, 24)
$chkAuto.ForeColor = $cMuted
$chkAuto.Font = New-Font 9
$chkAuto.Checked = (Test-Path $StartupLink)
$form.Controls.Add($chkAuto)

# ------------------------------------------------------------- the agent ----

$script:agent = $null
$script:restarts = 0
$script:pendingAction = $null
$script:pendingSince = Get-Date
$script:wasLive = $false

# The agent's own children go with it — the RTMP receiver (ffmpeg) would
# otherwise be orphaned still holding port 1935 and still streaming. OBS is
# spared on purpose: the agent starts it, so it counts as a child, but closing
# it would throw away whatever the operator has open on screen.
function Stop-AgentTree([int]$agentPid) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $agentPid" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne 'obs64.exe' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
    try { Stop-Process -Id $agentPid -Force -ErrorAction Stop } catch {}
}

function Stop-StrayAgents {
    # Another agent (a leftover console window, a crashed copy of this program)
    # would fight this one over RTMP 1935 and OBS.
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*agent.mjs*' } |
        ForEach-Object {
            if (-not $script:agent -or $_.ProcessId -ne $script:agent.Id) { Stop-AgentTree $_.ProcessId }
        }
}

function Start-Agent {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = 'node.exe'
    $psi.Arguments = '"' + $AgentScript + '"'
    $psi.WorkingDirectory = Split-Path $AgentScript
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true        # the agent writes event-control.log itself
    $script:agent = [Diagnostics.Process]::Start($psi)
}

function Stop-Agent {
    if ($script:agent -and -not $script:agent.HasExited) { Stop-AgentTree $script:agent.Id }
    $script:agent = $null
}

function Send-Command([string]$action) {
    try {
        $tmp = $CommandFile + '.tmp'
        [IO.File]::WriteAllText($tmp, $action, (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $CommandFile -Force
        $script:pendingAction = $action
        $script:pendingSince = Get-Date
    } catch {
        [Windows.Forms.MessageBox]::Show('สั่งงานไม่สำเร็จ: ' + $_.Exception.Message, 'ROYS Event', 'OK', 'Warning') | Out-Null
    }
}

function Read-Status {
    try {
        if (-not (Test-Path $StatusFile)) { return $null }
        $raw = [IO.File]::ReadAllText($StatusFile, [Text.Encoding]::UTF8)
        if (-not $raw) { return $null }
        return ($raw | ConvertFrom-Json)
    } catch { return $null }
}

# --------------------------------------------------------------- the tray ----

$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = Get-DotIcon $cGrey
$tray.Text = 'ROYS ช่อง 21'
$tray.Visible = $true

$menu = New-Object Windows.Forms.ContextMenuStrip
$miShow    = $menu.Items.Add('เปิดหน้าต่าง')
$null      = $menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$miStart   = $menu.Items.Add('เริ่มถ่ายทอดสด')
$miStop    = $menu.Items.Add('หยุดถ่ายทอดสด')
$null      = $menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$miQuit    = $menu.Items.Add('ออกจากโปรแกรม')
$tray.ContextMenuStrip = $menu

function Show-Window {
    $form.Show()
    $form.WindowState = 'Normal'
    [void][Roys.Native]::ShowWindow($form.Handle, 5)   # SW_SHOW, in case Windows started us hidden
    [void][Roys.Native]::SetForegroundWindow($form.Handle)
    $form.Activate()
}

$miShow.Add_Click({ Show-Window })
$miStart.Add_Click({ Send-Command 'start' })
$miStop.Add_Click({ Send-Command 'stop' })
$tray.Add_DoubleClick({ Show-Window })
# One click is what most people try first.
$tray.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [Windows.Forms.MouseButtons]::Left) { Show-Window }
})

# ------------------------------------------------------------- the wiring ----

$btnStart.Add_Click({ Send-Command 'start' })
$btnStop.Add_Click({ Send-Command 'stop' })
$btnMic.Add_Click({ Send-Command $(if ($script:micMuted) { 'unmute' } else { 'mute' }) })
$btnScene.Add_Click({ Send-Command $(if ($script:onStandby) { 'camera' } else { 'standby' }) })

$btnLink.Add_Click({
    [Windows.Forms.Clipboard]::SetText($ControlUrl)
    $tray.ShowBalloonTip(3000, 'คัดลอกแล้ว', 'ลิงก์หน้าควบคุมอยู่ในคลิปบอร์ดแล้ว', 'Info')
})
$btnPw.Add_Click({
    # Copied, never shown: the password should not end up in a screenshot.
    try {
        [Windows.Forms.Clipboard]::SetText(((Get-Content $PasswordFile -Raw).Trim()))
        $tray.ShowBalloonTip(3000, 'คัดลอกแล้ว', 'รหัสผ่านอยู่ในคลิปบอร์ดแล้ว — วางในหน้าเว็บบนมือถือได้เลย', 'Info')
    } catch {
        [Windows.Forms.MessageBox]::Show('อ่านไฟล์รหัสผ่านไม่ได้: ' + $PasswordFile, 'ROYS Event', 'OK', 'Warning') | Out-Null
    }
})
$btnLog.Add_Click({ if (Test-Path $LogFile) { Start-Process notepad.exe $LogFile } })

$chkAuto.Add_Click({
    try {
        if ($chkAuto.Checked) {
            $ws = New-Object -ComObject WScript.Shell
            $lnk = $ws.CreateShortcut($StartupLink)
            $lnk.TargetPath = 'wscript.exe'
            $lnk.Arguments = '"' + $LaunchVbs + '"'
            $lnk.WorkingDirectory = $Root
            $lnk.Description = 'ROYS Hotel - ควบคุมช่อง 21'
            if (Test-Path $IconFile) { $lnk.IconLocation = $IconFile }
            $lnk.Save()
        } elseif (Test-Path $StartupLink) {
            Remove-Item -LiteralPath $StartupLink -Force
        }
    } catch {
        [Windows.Forms.MessageBox]::Show('ตั้งค่าไม่สำเร็จ: ' + $_.Exception.Message, 'ROYS Event', 'OK', 'Warning') | Out-Null
        $chkAuto.Checked = (Test-Path $StartupLink)
    }
})

# The X button hides to the tray — closing the window must not take the channel
# off air in the middle of an event. Only "ออกจากโปรแกรม" in the tray menu sets
# the flag that lets the window actually close (checking CloseReason instead is
# not enough: Windows reports UserClosing for the tray menu's exit as well).
$script:reallyQuit = $false
$form.Add_FormClosing({
    param($sender, $e)
    if (-not $script:reallyQuit) {
        $e.Cancel = $true
        $form.Hide()
        $tray.ShowBalloonTip(4000, 'ยังทำงานอยู่', 'โปรแกรมย่อลงถาดระบบแล้ว — ช่อง 21 ยังทำงานตามปกติ', 'Info')
    }
})

$miQuit.Add_Click({
    if ($script:wasLive) {
        $answer = [Windows.Forms.MessageBox]::Show(
            'ตอนนี้ช่อง 21 กำลังออกอากาศอยู่ ถ้าออกจากโปรแกรม การถ่ายทอดสดจะหยุด ยืนยันไหม?',
            'ROYS Event', 'YesNo', 'Warning')
        if ($answer -ne 'Yes') { return }
        Send-Command 'stop'
        # Give the agent a moment to close the stream cleanly before it is killed.
        for ($i = 0; $i -lt 16; $i++) {
            [Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 500
            $s = Read-Status
            if ($s -and $s.status -and -not $s.status.streaming) { break }
        }
    }
    $script:reallyQuit = $true
    Stop-Agent
    $tray.Visible = $false
    [Windows.Forms.Application]::Exit()
})

# ---------------------------------------------------------------- refresh ----

function Set-Row([string]$key, [string]$text, [Drawing.Color]$color) {
    $rows[$key].Text = $text
    $rows[$key].ForeColor = $color
}

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  try {
    # 1. keep the agent alive
    if (-not $script:agent -or $script:agent.HasExited) {
        $script:restarts++
        Start-Agent
        if ($script:restarts -gt 1) {
            $tray.ShowBalloonTip(5000, 'เปิดตัวควบคุมใหม่แล้ว',
                'ตัวควบคุมบนโน้ตบุ๊กหยุดไปเอง โปรแกรมเปิดให้ใหม่แล้ว', 'Warning')
        }
    }

    # 2. tell the agent someone is watching, so it re-reads OBS every 2s
    if ($form.Visible) {
        try { [IO.File]::WriteAllText($WatchFile, (Get-Date).ToString('s')) } catch {}
    }

    # 3. repaint from what the agent last wrote
    $data = Read-Status
    $fresh = $data -and ((New-TimeSpan -Start ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$data.at).LocalDateTime) -End (Get-Date)).TotalSeconds -lt 75)
    $st = if ($fresh) { $data.status } else { $null }
    $ch = if ($fresh) { $data.channel } else { $null }

    $live = [bool]($ch -and $ch.live) -or [bool]($st -and $st.streaming)
    $script:wasLive = $live
    $script:micMuted = [bool]($st -and $st.micMuted)
    $script:onStandby = [bool]($st -and $st.scene -eq 'พักรอ')

    if (-not $fresh) {
        $lblLive.Text = 'ยังไม่ทราบสถานะ'
        $lblLive.ForeColor = $cMuted
        $lblLiveSub.Text = 'กำลังรอตัวควบคุมรายงาน… (ถ้าค้างนานกว่านี้ ลองปิดแล้วเปิดโปรแกรมใหม่)'
        $tray.Icon = Get-DotIcon $cGrey
        $tray.Text = 'ROYS ช่อง 21 · ไม่ทราบสถานะ'
    } elseif ($live) {
        $mins = if ($st -and $st.streamSeconds) { [int][Math]::Floor($st.streamSeconds / 60) } else { 0 }
        $lblLive.Text = '● กำลังออกอากาศ'
        $lblLive.ForeColor = $cRed
        $lblLiveSub.Text = "ทีวีทุกห้องเห็นภาพนี้อยู่ · ออกอากาศมาแล้ว $mins นาที"
        $tray.Icon = Get-DotIcon $cRed
        $tray.Text = 'ROYS ช่อง 21 · ออกอากาศอยู่'
    } else {
        $lblLive.Text = 'ไม่ได้ออกอากาศ'
        $lblLive.ForeColor = $cText
        $lblLiveSub.Text = 'ช่อง 21 บนทีวีจะขึ้นว่าไม่มีสัญญาณ จนกว่าจะกดเริ่มถ่ายทอดสด'
        $tray.Icon = Get-DotIcon $cBlue
        $tray.Text = 'ROYS ช่อง 21 · พร้อมใช้งาน'
    }

    # buttons follow the state they would change — a red "stop" button with
    # nothing to stop reads as an alarm, so colour follows enabled.
    $btnStart.Enabled = $fresh -and -not $live
    $btnStop.Enabled = $fresh -and $live
    $btnStart.BackColor = if ($btnStart.Enabled) { $cGreen } else { $cCard }
    $btnStart.ForeColor = if ($btnStart.Enabled) { [Drawing.Color]::White } else { $cGrey }
    $btnStop.BackColor = if ($btnStop.Enabled) { $cRed } else { $cCard }
    $btnStop.ForeColor = if ($btnStop.Enabled) { [Drawing.Color]::White } else { $cGrey }
    $btnMic.Text = if ($script:micMuted) { 'เปิดไมค์' } else { 'ปิดไมค์' }
    $btnMic.ForeColor = if ($script:micMuted) { $cAmber } else { $cText }
    $btnScene.Text = if ($script:onStandby) { 'กลับไปที่กล้อง' } else { 'ภาพพักรอ' }
    $btnScene.ForeColor = if ($script:onStandby) { $cAmber } else { $cText }
    $btnMic.Enabled = [bool]($st -and $st.obs -and $st.obs.connected)
    $btnScene.Enabled = $btnMic.Enabled

    # mic meter: peak dB since the agent's last look, -60 dB .. 0 dB
    $db = if ($st -and $st.micDb -ne $null) { [double]$st.micDb } else { -100 }
    if ($db -le -60 -or $script:micMuted) {
        $meterFill.Width = 0
        $lblDb.Text = if ($script:micMuted) { 'ปิดไมค์อยู่' } else { 'เงียบ' }
    } else {
        $frac = [Math]::Min(1.0, ($db + 60) / 60)
        $meterFill.Width = [int]($meter.ClientSize.Width * $frac)
        $meterFill.BackColor = if ($db -gt -6) { $cRed } elseif ($db -gt -30) { $cGreen } else { $cAmber }
        $lblDb.Text = ('{0:N1} dB' -f $db)
    }

    # the four rows
    if ($fresh) { Set-Row 'agent' 'ทำงานปกติ' $cGreen } else { Set-Row 'agent' 'ไม่ตอบสนอง' $cRed }

    if ($st -and $st.obs -and $st.obs.connected) { Set-Row 'obs' 'เชื่อมต่อแล้ว' $cGreen }
    elseif ($st -and $st.obs -and $st.obs.running) { Set-Row 'obs' 'เปิดอยู่ แต่ยังไม่เชื่อม' $cAmber }
    else { Set-Row 'obs' 'ยังไม่เปิด (กดเริ่มแล้วเปิดเอง)' $cMuted }

    if ($st -and $st.camo -and $st.camo.connected) {
        $dev = if ($st.camo.device) { $st.camo.device } else { 'มือถือ' }
        Set-Row 'camo' ('เชื่อมแล้ว · ' + $dev) $cGreen
    } elseif ($st -and $st.camo -and $st.camo.running) { Set-Row 'camo' 'มือถือยังไม่ต่อ' $cAmber }
    else { Set-Row 'camo' 'ยังไม่ได้เปิด Camo' $cMuted }

    if ($fresh -and $data.online -and $ch) {
        $used = [int]$ch.requestsToday; $budget = [int]$ch.dailyBudget
        $pct = if ($budget -gt 0) { [int](100 * $used / $budget) } else { 0 }
        $color = if ($pct -ge 90) { $cRed } elseif ($pct -ge 70) { $cAmber } else { $cGreen }
        Set-Row 'cloud' ("ปกติ · ใช้ไป {0:N0}/{1:N0} ({2}%)" -f $used, $budget, $pct) $color
    } elseif ($fresh -and -not $data.online) { Set-Row 'cloud' 'ติดต่อเซิร์ฟเวอร์ไม่ได้' $cRed }
    else { Set-Row 'cloud' '—' $cMuted }

    # "sending…" clears as soon as the agent reports back after the button was
    # pressed (it reports every couple of seconds while this window is open),
    # and in any case after 25 seconds.
    if ($script:pendingAction) {
        $reportedAt = if ($data) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$data.at).LocalDateTime } else { [DateTime]::MinValue }
        $waited = (New-TimeSpan -Start $script:pendingSince -End (Get-Date)).TotalSeconds
        if ($reportedAt -gt $script:pendingSince.AddSeconds(2) -or $waited -gt 25) { $script:pendingAction = $null }
    }

    $msg = ''
    if ($st -and $st.lastError) { $msg = $st.lastError }
    elseif ($st -and $st.reconnecting) { $msg = 'OBS กำลังเชื่อมต่อใหม่…' }
    elseif ($script:pendingAction) { $msg = 'กำลังสั่งงาน…' }
    elseif ($live -and $st -and $st.camo -and -not $st.camo.connected) { $msg = 'มือถือหลุดจาก Camo — ภาพที่ออกอากาศอาจเป็นจอเปล่า' }
    $lblError.Text = $msg
  } catch {
    # A failed repaint must never take the window down: the agent is what keeps
    # the broadcast alive, and it is supervised from this same tick.
    $lblError.Text = 'อัปเดตหน้าจอไม่สำเร็จ: ' + $_.Exception.Message
  }
})

# ------------------------------------------------------------------ start ----

# From here on an unexpected error must not stop the program — the window is
# what keeps the agent running.
$ErrorActionPreference = 'Continue'

Stop-StrayAgents
Start-Agent
$timer.Start()
$form.Add_Shown({ Show-Window })
[Windows.Forms.Application]::Run($form)

$timer.Stop()
Stop-Agent
$tray.Visible = $false
$tray.Dispose()
$mutex.ReleaseMutex()
