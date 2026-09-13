# Read and set the USB camera's own picture controls (white balance, exposure,
# brightness…) — the ones behind OBS's "Configure Video" button, which
# obs-websocket cannot reach. They live in the camera driver, not in OBS, so
# they survive scene edits and apply to whatever opens the camera next.
#
#   .\camera-settings.ps1                       show every control, its range and value
#   .\camera-settings.ps1 -WhiteBalance 4600    fix white balance (manual)
#   .\camera-settings.ps1 -WhiteBalanceAuto     hand white balance back to the camera
#   .\camera-settings.ps1 -Exposure -6          fix exposure (log2 seconds: -6 = 1/64s)
#   .\camera-settings.ps1 -ExposureAuto
#
# OBS must be CLOSED: Windows lets only one process hold a capture device, and
# these calls bind the same filter OBS binds.

param(
    [string] $Device = 'USB 2.0 Camera',
    [int]    $WhiteBalance,
    [switch] $WhiteBalanceAuto,
    [int]    $Exposure,
    [switch] $ExposureAuto,
    [int]    $Hue,
    [int]    $Brightness,
    [int]    $Contrast,
    [int]    $Saturation,
    [int]    $Gain
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class Cam {
    [ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ICreateDevEnum {
        [PreserveSig] int CreateClassEnumerator([In] ref Guid pType, [Out] out IEnumMoniker ppEnumMoniker, [In] int dwFlags);
    }

    [ComImport, Guid("C6E13360-30AC-11d0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAMVideoProcAmp {
        [PreserveSig] int GetRange(int prop, out int min, out int max, out int step, out int def, out int flags);
        [PreserveSig] int Set(int prop, int value, int flags);
        [PreserveSig] int Get(int prop, out int value, out int flags);
    }

    // Declared here because .NET Framework's ComTypes does not ship it.
    [ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyBag {
        [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Struct)] out object value, IntPtr errorLog);
        [PreserveSig] int Write([MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.Struct)] ref object value);
    }

    [ComImport, Guid("C6E13370-30AC-11d0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAMCameraControl {
        [PreserveSig] int GetRange(int prop, out int min, out int max, out int step, out int def, out int flags);
        [PreserveSig] int Set(int prop, int value, int flags);
        [PreserveSig] int Get(int prop, out int value, out int flags);
    }

    static readonly Guid CLSID_SystemDeviceEnum = new Guid("62BE5D10-60EB-11d0-BD3B-00A0C911CE86");
    static readonly Guid CLSID_VideoInputDeviceCategory = new Guid("860BB310-5D01-11d0-BD3B-00A0C911CE86");
    static readonly Guid IID_IBaseFilter = new Guid("56a86895-0ad4-11ce-b03a-0020af0ba770");

    // Property numbers from the DirectShow headers.
    public static readonly string[] ProcAmpNames = {
        "Brightness", "Contrast", "Hue", "Saturation", "Sharpness", "Gamma",
        "ColorEnable", "WhiteBalance", "BacklightCompensation", "Gain"
    };
    public static readonly string[] CameraNames = { "Pan", "Tilt", "Roll", "Zoom", "Exposure", "Iris", "Focus" };

    static object BindFilter(string wanted, out string found) {
        found = null;
        Type t = Type.GetTypeFromCLSID(CLSID_SystemDeviceEnum);
        ICreateDevEnum devEnum = (ICreateDevEnum)Activator.CreateInstance(t);
        IEnumMoniker monikers;
        Guid cat = CLSID_VideoInputDeviceCategory;
        if (devEnum.CreateClassEnumerator(ref cat, out monikers, 0) != 0 || monikers == null) return null;

        IMoniker[] one = new IMoniker[1];
        IntPtr fetched = IntPtr.Zero;
        while (monikers.Next(1, one, fetched) == 0) {
            object bagObj;
            Guid bagId = typeof(IPropertyBag).GUID;
            one[0].BindToStorage(null, null, ref bagId, out bagObj);
            IPropertyBag bag = (IPropertyBag)bagObj;
            object nameObj = null;
            try { bag.Read("FriendlyName", out nameObj, IntPtr.Zero); } catch { }
            string name = nameObj as string;
            if (name != null && name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0) {
                object filter;
                Guid iid = IID_IBaseFilter;
                one[0].BindToObject(null, null, ref iid, out filter);
                found = name;
                return filter;
            }
        }
        return null;
    }

    public class Control {
        public string Name; public int Min; public int Max; public int Step; public int Default;
        public int Value; public string Mode; public bool Supported;
    }

    public static List<Control> Read(string device, out string deviceName) {
        var list = new List<Control>();
        object filter = BindFilter(device, out deviceName);
        if (filter == null) return list;
        var amp = filter as IAMVideoProcAmp;
        var cc = filter as IAMCameraControl;
        for (int i = 0; i < ProcAmpNames.Length; i++) {
            var c = new Control { Name = ProcAmpNames[i] };
            int min, max, step, def, flags, val, vflags;
            if (amp != null && amp.GetRange(i, out min, out max, out step, out def, out flags) == 0) {
                c.Supported = true; c.Min = min; c.Max = max; c.Step = step; c.Default = def;
                if (amp.Get(i, out val, out vflags) == 0) { c.Value = val; c.Mode = (vflags & 1) != 0 ? "auto" : "manual"; }
            }
            list.Add(c);
        }
        for (int i = 0; i < CameraNames.Length; i++) {
            var c = new Control { Name = "cam:" + CameraNames[i] };
            int min, max, step, def, flags, val, vflags;
            if (cc != null && cc.GetRange(i, out min, out max, out step, out def, out flags) == 0) {
                c.Supported = true; c.Min = min; c.Max = max; c.Step = step; c.Default = def;
                if (cc.Get(i, out val, out vflags) == 0) { c.Value = val; c.Mode = (vflags & 1) != 0 ? "auto" : "manual"; }
            }
            list.Add(c);
        }
        Marshal.ReleaseComObject(filter);
        return list;
    }

    // flags: 1 = auto, 2 = manual
    public static string Set(string device, string which, int index, int value, int flags) {
        string name;
        object filter = BindFilter(device, out name);
        if (filter == null) return "camera not found";
        int hr;
        if (which == "amp") {
            var amp = filter as IAMVideoProcAmp;
            if (amp == null) return "this camera exposes no picture controls";
            hr = amp.Set(index, value, flags);
        } else {
            var cc = filter as IAMCameraControl;
            if (cc == null) return "this camera exposes no camera controls";
            hr = cc.Set(index, value, flags);
        }
        Marshal.ReleaseComObject(filter);
        return hr == 0 ? "ok" : ("failed, hr=0x" + hr.ToString("X8"));
    }
}
'@ -ReferencedAssemblies System.Runtime.InteropServices

if (Get-Process obs64 -ErrorAction SilentlyContinue) {
    Write-Warning 'OBS is open — it holds the camera, so these calls will fail. Close OBS and run this again.'
}

function Show-Controls {
    $name = ''
    $controls = [Cam]::Read($Device, [ref]$name)
    if (-not $controls -or $controls.Count -eq 0) { Write-Error "ไม่พบกล้องชื่อที่มี '$Device'"; return }
    Write-Host "กล้อง: $name" -ForegroundColor Cyan
    $controls | Where-Object { $_.Supported } | ForEach-Object {
        '{0,-28} {1,7}  (ช่วง {2} … {3}, ค่าเริ่มต้น {4}, โหมด {5})' -f $_.Name, $_.Value, $_.Min, $_.Max, $_.Default, $_.Mode
    }
    $un = $controls | Where-Object { -not $_.Supported } | ForEach-Object { $_.Name }
    if ($un) { Write-Host ("ไม่รองรับ: " + ($un -join ', ')) -ForegroundColor DarkGray }
}

$did = $false
if ($PSBoundParameters.ContainsKey('WhiteBalance')) { "WhiteBalance -> $WhiteBalance : " + [Cam]::Set($Device, 'amp', 7, $WhiteBalance, 2); $did = $true }
if ($WhiteBalanceAuto)                              { "WhiteBalance -> auto : "       + [Cam]::Set($Device, 'amp', 7, 0, 1); $did = $true }
if ($PSBoundParameters.ContainsKey('Hue'))          { "Hue -> $Hue : "                 + [Cam]::Set($Device, 'amp', 2, $Hue, 2); $did = $true }
if ($PSBoundParameters.ContainsKey('Brightness'))   { "Brightness -> $Brightness : "   + [Cam]::Set($Device, 'amp', 0, $Brightness, 2); $did = $true }
if ($PSBoundParameters.ContainsKey('Contrast'))     { "Contrast -> $Contrast : "       + [Cam]::Set($Device, 'amp', 1, $Contrast, 2); $did = $true }
if ($PSBoundParameters.ContainsKey('Saturation'))   { "Saturation -> $Saturation : "   + [Cam]::Set($Device, 'amp', 3, $Saturation, 2); $did = $true }
if ($PSBoundParameters.ContainsKey('Gain'))         { "Gain -> $Gain : "               + [Cam]::Set($Device, 'amp', 9, $Gain, 2); $did = $true }
if ($PSBoundParameters.ContainsKey('Exposure'))     { "Exposure -> $Exposure : "       + [Cam]::Set($Device, 'cam', 4, $Exposure, 2); $did = $true }
if ($ExposureAuto)                                  { "Exposure -> auto : "            + [Cam]::Set($Device, 'cam', 4, 0, 1); $did = $true }

if ($did) { Write-Host ''; Write-Host 'ค่าหลังตั้ง:' -ForegroundColor Cyan }
Show-Controls
