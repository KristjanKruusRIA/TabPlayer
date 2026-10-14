param([Parameter(Mandatory=$true)][int]$AppProcessId)
$appProcess=Get-Process -Id $AppProcessId -ErrorAction Stop
if ($appProcess.ProcessName -ne 'tabplayer') { throw 'Only TabPlayer test dialogs may be controlled.' }
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
    public static bool Cancel(uint process) {
        IntPtr dialog=IntPtr.Zero;
        EnumWindows((hwnd,p)=> { uint id; GetWindowThreadProcessId(hwnd,out id);
            var name=new StringBuilder(256); GetClassName(hwnd,name,256);
            if(id==process && IsWindowVisible(hwnd) && name.ToString()=="#32770") dialog=hwnd;
            return true;
        },IntPtr.Zero);
        if(dialog==IntPtr.Zero) return false;
        SendMessage(dialog,0x111,new IntPtr(2),IntPtr.Zero);
        return true;
    }
}
'@
for($attempt=0;$attempt -lt 100;$attempt++) {
    if([TabPlayerDialogTest]::Cancel($AppProcessId)) { Write-Output 'Native dialog cancelled'; exit 0 }
    Start-Sleep -Milliseconds 50
}
throw 'No native TabPlayer dialog appeared.'
