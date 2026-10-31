param(
    [Parameter(Mandatory=$true)][int]$AppProcessId,
    [Parameter(Mandatory=$true)][string]$AppExecutable,
    [Parameter(Mandatory=$true)][ValidateSet('Save','Discard','Cancel')][string]$Decision,
    [long]$AppStartTicks=0
)
$ErrorActionPreference='Stop'
$ownedExecutable=(Resolve-Path -LiteralPath $AppExecutable).Path
if ([System.IO.Path]::GetFileName($ownedExecutable) -ine 'tabplayer.exe') { throw 'Only the owned TabPlayer executable may be controlled.' }
if ($AppStartTicks -lt 0) { throw 'The captured process start token must be positive.' }
$initialOwnedProcess=Get-Process -Id $AppProcessId -ErrorAction Stop
$ownedStartTicks=if($AppStartTicks -gt 0){$AppStartTicks}else{$initialOwnedProcess.StartTime.ToUniversalTime().Ticks}
function Assert-OwnedProcess {
    param([switch]$AllowExited)
    $appProcess=Get-Process -Id $AppProcessId -ErrorAction SilentlyContinue
    if ($null -eq $appProcess) {
        if ($AllowExited) { return $false }
        throw 'The owned process exited before the requested dialog action.'
    }
    if (-not [string]::Equals($appProcess.Path,$ownedExecutable,[StringComparison]::OrdinalIgnoreCase)) { throw 'The PID does not belong to the exact owned executable.' }
    if ($appProcess.StartTime.ToUniversalTime().Ticks -ne $ownedStartTicks) { throw 'The PID no longer belongs to the captured process instance.' }
    return $true
}
$null=Assert-OwnedProcess
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public static class TabPlayerUnsavedDialogTest {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint id);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int count);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
    public static IntPtr[] Find(uint process) {
        var dialogs=new List<IntPtr>();
        EnumWindows((hwnd,p)=> { uint id; GetWindowThreadProcessId(hwnd,out id);
            var title=new StringBuilder(512); GetWindowText(hwnd,title,512);
            if(id==process && IsWindowVisible(hwnd) && title.ToString()=="Unsaved score") dialogs.Add(hwnd);
            return true;
        },IntPtr.Zero);
        return dialogs.ToArray();
    }
    public static void Click(IntPtr dialog, IntPtr button, uint process, int buttonId) {
        uint dialogProcess, buttonProcess;
        GetWindowThreadProcessId(dialog,out dialogProcess); GetWindowThreadProcessId(button,out buttonProcess);
        var title=new StringBuilder(512); GetWindowText(dialog,title,512);
        var name=new StringBuilder(256); GetClassName(button,name,256);
        if(dialogProcess!=process || buttonProcess!=process || title.ToString()!="Unsaved score" || !IsWindowVisible(dialog) || !IsChild(dialog,button) || !IsWindowEnabled(button) || name.ToString()!="Button") throw new InvalidOperationException("Requested native dialog control ownership changed.");
        // TDM_CLICK_BUTTON: https://learn.microsoft.com/en-us/windows/win32/controls/tdm-click-button
        UIntPtr result;
        if(SendMessageTimeout(dialog,0x0400+102,new IntPtr(buttonId),IntPtr.Zero,2,3000,out result)==IntPtr.Zero) throw new InvalidOperationException("Owned task-dialog click did not complete.");
    }
}
'@
# Pinned rfd 0.16 custom task-dialog IDs, confirmed against the actual UIA tree.
$buttonId=@{Save=1004;Discard=1008;Cancel=1001}[$Decision]
for($attempt=0;$attempt -lt 200;$attempt++) {
    $null=Assert-OwnedProcess
    $dialogs=@([TabPlayerUnsavedDialogTest]::Find($AppProcessId))
    if ($dialogs.Count -gt 1) { throw 'More than one owned Unsaved score dialog appeared.' }
    if ($dialogs.Count -eq 1) {
        $dialog=[System.Windows.Automation.AutomationElement]::FromHandle($dialogs[0])
        if ($dialog.Current.ProcessId -ne $AppProcessId -or $dialog.Current.Name -cne 'Unsaved score') { throw 'Unsaved dialog ownership changed.' }
        $nameCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$Decision)
        $buttonCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,"CommandButton_$buttonId")
        $condition=New-Object System.Windows.Automation.AndCondition($nameCondition,$buttonCondition)
        $buttons=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
        if ($buttons.Count -gt 1) { throw "Expected exactly one $Decision button in owned Unsaved score dialog." }
        if ($buttons.Count -eq 0) { Start-Sleep -Milliseconds 50; continue }
        $button=$buttons.Item(0)
        if (-not $button.Current.IsEnabled -or $button.Current.ProcessId -ne $AppProcessId -or $button.Current.ClassName -cne 'CCPushButton') { throw 'Requested dialog button is not enabled or owned.' }
        $null=Assert-OwnedProcess
        [TabPlayerUnsavedDialogTest]::Click($dialogs[0],[IntPtr]$button.Current.NativeWindowHandle,$AppProcessId,$buttonId)
        for($dismissal=0;$dismissal -lt 100;$dismissal++) {
            if (-not (Assert-OwnedProcess -AllowExited) -or @([TabPlayerUnsavedDialogTest]::Find($AppProcessId)) -notcontains $dialogs[0]) {
                Write-Output "Owned Unsaved score dialog answered: $Decision"
                exit 0
            }
            Start-Sleep -Milliseconds 20
        }
        throw 'The requested Unsaved score dialog action did not dismiss its owned dialog.'
    }
    Start-Sleep -Milliseconds 50
}
throw 'No owned Unsaved score dialog appeared within 10 seconds.'
