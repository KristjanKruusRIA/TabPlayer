param([Parameter(Mandatory=$true)][int]$AppProcessId,[ValidateSet('inspect','choose','confirm','cancel','discard')][string]$Action='choose',[string]$SelectedPath)
$process=Get-Process -Id $AppProcessId -ErrorAction Stop
if($process.ProcessName -ne 'tabplayer'){throw 'Only an owned TabPlayer test dialog may be controlled.'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class TabPlayerPicker {
public delegate bool Callback(IntPtr h,IntPtr p);
[DllImport("user32.dll")]static extern bool EnumWindows(Callback cb,IntPtr p);
[DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("user32.dll")]static extern int GetClassName(IntPtr h,StringBuilder text,int n);
public static IntPtr Find(uint process){IntPtr result=IntPtr.Zero;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);var c=new StringBuilder(256);GetClassName(h,c,256);if(id==process&&c.ToString()=="#32770")result=h;return true;},IntPtr.Zero);return result;}}
'@
for($attempt=0;$attempt -lt 100;$attempt++) {
    $handle=[TabPlayerPicker]::Find($AppProcessId)
    if($handle -ne [IntPtr]::Zero){$dialog=[System.Windows.Automation.AutomationElement]::FromHandle($handle);break};Start-Sleep -Milliseconds 50
}
if(!$dialog){throw 'No native TabPlayer test dialog appeared.'}
$edits=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit))
if($Action -eq 'inspect') {$edits | ForEach-Object {$_.Current | Select-Object Name,AutomationId};$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)) | ForEach-Object {$_.Current | Select-Object Name,AutomationId};exit 0}
if($Action -eq 'choose') {
    if(!$SelectedPath){throw 'An explicit path is required.'}
    $field=$edits | Where-Object {$_.Current.Name -like '*File name*' -or $_.Current.AutomationId -eq '1148'} | Select-Object -First 1
    if(!$field){throw 'Could not identify the file-name field.'}
    ([System.Windows.Automation.ValuePattern]$field.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($SelectedPath)
}
$buttons=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button))
$id=switch($Action){'cancel' {'2'} 'confirm' {'6'} 'discard' {'7'} default {'1'}}
$button=$buttons | Where-Object {$_.Current.AutomationId -eq $id} | Select-Object -First 1
if(!$button){throw 'Could not identify the requested native button.'}
([System.Windows.Automation.InvokePattern]$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
Write-Output ('Native dialog action: '+$Action)
