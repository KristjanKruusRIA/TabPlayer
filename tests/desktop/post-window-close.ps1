param(
    [Parameter(Mandatory=$true)][int]$AppProcessId,
    [Parameter(Mandatory=$true)][string]$AppExecutable,
    [Parameter(Mandatory=$true)][long]$AppStartTicks,
    [string]$WindowTitle='TabPlayer Test',
    [ValidateSet('Close','List')][string]$Mode='Close'
)
$ErrorActionPreference='Stop'
$ownedExecutable=(Resolve-Path -LiteralPath $AppExecutable).Path
if ([System.IO.Path]::GetFileName($ownedExecutable) -ine 'tabplayer.exe') { throw 'Only the owned TabPlayer executable may be controlled.' }
if ($AppStartTicks -le 0) { throw 'The captured process start token must be positive.' }
function Assert-OwnedProcess {
    $appProcess=Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue
    if ($null -eq $appProcess) { throw 'The owned process exited before the requested window message.' }
    if (-not [string]::Equals($appProcess.Path,$ownedExecutable,[StringComparison]::OrdinalIgnoreCase)) { throw 'The PID does not belong to the exact owned executable.' }
    if ($appProcess.StartTime.ToUniversalTime().Ticks -ne $AppStartTicks) { throw 'The PID no longer belongs to the captured process instance.' }
}
Assert-OwnedProcess
Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class TabPlayerWindowCloseTest {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint id);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
    public class Entry { public IntPtr Handle; public string Title; public string Class; public bool Visible; public bool Owned; }
    // Every top-level window of one process, including hidden ones: the test app is launched hidden, and the single-instance
    // plugin adds its own hidden helper window, which is what Process.CloseMainWindow() can end up addressing.
    public static List<Entry> Windows(uint process) {
        var windows=new List<Entry>();
        EnumWindows((hwnd,p)=> { uint id; GetWindowThreadProcessId(hwnd,out id);
            if(id!=process) return true;
            var title=new StringBuilder(512); GetWindowText(hwnd,title,512);
            var name=new StringBuilder(256); GetClassName(hwnd,name,256);
            windows.Add(new Entry{Handle=hwnd,Title=title.ToString(),Class=name.ToString(),Visible=IsWindowVisible(hwnd),Owned=GetWindow(hwnd,4)!=IntPtr.Zero});
            return true;
        },IntPtr.Zero);
        return windows;
    }
    public static void Close(IntPtr hwnd, uint process) {
        uint owner; GetWindowThreadProcessId(hwnd,out owner);
        if(!IsWindow(hwnd) || owner!=process) throw new InvalidOperationException("Requested window ownership changed.");
        // WM_CLOSE is posted, not sent: the app answers it from its own message loop exactly as it does for the title-bar Close button.
        if(!PostMessage(hwnd,0x0010,IntPtr.Zero,IntPtr.Zero)) throw new InvalidOperationException("PostMessage(WM_CLOSE) failed: "+Marshal.GetLastWin32Error());
    }
}
'@
$windows=@([TabPlayerWindowCloseTest]::Windows([uint32]$AppProcessId))
$description=($windows | ForEach-Object { '{0}|{1}|visible={2}|owned={3}' -f $_.Class,$_.Title,$_.Visible,$_.Owned }) -join '; '
if ($Mode -eq 'List') { Write-Output "Owned top-level windows: $description"; exit 0 }
$main=@($windows | Where-Object { $_.Title -ceq $WindowTitle -and -not $_.Owned })
if ($main.Count -ne 1) { throw "Expected exactly one unowned top-level '$WindowTitle' window of the owned process; found: $description" }
Assert-OwnedProcess
[TabPlayerWindowCloseTest]::Close($main[0].Handle,[uint32]$AppProcessId)
Write-Output "Owned WM_CLOSE posted to $($main[0].Class) '$($main[0].Title)'"
