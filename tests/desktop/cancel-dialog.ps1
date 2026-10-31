param(
    [Parameter(Mandatory=$true)][int]$AppProcessId,
    [string]$AppExecutable,
    [long]$AppStartTicks=0
)
$ErrorActionPreference='Stop'
if ($AppStartTicks -lt 0) { throw 'The captured process start token must be positive.' }
$initialOwnedProcess=Get-Process -Id $AppProcessId -ErrorAction Stop
$ownedExecutable=if($AppExecutable){(Resolve-Path -LiteralPath $AppExecutable).Path}else{$initialOwnedProcess.Path}
if ([System.IO.Path]::GetFileName($ownedExecutable) -ine 'tabplayer.exe') { throw 'Only the owned TabPlayer executable may be controlled.' }
$ownedStartTicks=if($AppStartTicks -gt 0){$AppStartTicks}else{$initialOwnedProcess.StartTime.ToUniversalTime().Ticks}
function Assert-OwnedProcess {
    $appProcess=Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue
    if ($null -eq $appProcess) { throw 'The owned process exited before the requested dialog action.' }
    if (-not [string]::Equals($appProcess.Path,$ownedExecutable,[StringComparison]::OrdinalIgnoreCase)) { throw 'The PID does not belong to the exact owned executable.' }
    if ($appProcess.StartTime.ToUniversalTime().Ticks -ne $ownedStartTicks) { throw 'The PID no longer belongs to the captured process instance.' }
    return $true
}
$null=Assert-OwnedProcess
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TabPlayerDialogTest {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint id);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    public static IntPtr Find(uint process) {
        IntPtr dialog=IntPtr.Zero;
        EnumWindows((hwnd,p)=> { uint id; GetWindowThreadProcessId(hwnd,out id);
            var name=new StringBuilder(256); GetClassName(hwnd,name,256);
            if(id==process && IsWindowVisible(hwnd) && name.ToString()=="#32770") dialog=hwnd;
            return true;
        },IntPtr.Zero);
        return dialog;
    }
    public static void Cancel(IntPtr dialog, uint process) {
        uint id; GetWindowThreadProcessId(dialog,out id);
        var name=new StringBuilder(256); GetClassName(dialog,name,256);
        if(id!=process || !IsWindowVisible(dialog) || name.ToString()!="#32770") throw new InvalidOperationException("Requested native dialog ownership changed.");
        SendMessage(dialog,0x111,new IntPtr(2),IntPtr.Zero);
    }
}
'@
for($attempt=0;$attempt -lt 100;$attempt++) {
    $null=Assert-OwnedProcess
    $dialog=[TabPlayerDialogTest]::Find($AppProcessId)
    if($dialog -ne [IntPtr]::Zero) {
        $null=Assert-OwnedProcess
        [TabPlayerDialogTest]::Cancel($dialog,$AppProcessId)
        Write-Output 'Native dialog cancelled'
        exit 0
    }
    Start-Sleep -Milliseconds 50
}
throw 'No native TabPlayer dialog appeared.'
