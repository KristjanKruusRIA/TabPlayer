param(
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$AppProcessId,
    [Parameter(Mandatory=$true)][string]$AppExecutable,
    [Parameter(Mandatory=$true)][ValidateRange(1,[long]::MaxValue)][long]$AppStartTicks,
    [Parameter(Mandatory=$true)][string]$OwnedDirectory,
    [Parameter(Mandatory=$true)][string]$FolderPath
)
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use Windows PowerShell 5.1 for this diagnostic helper.' }
$ownedExecutable=(Get-Item -LiteralPath $AppExecutable -Force -ErrorAction Stop).FullName
if ([IO.Path]::GetFileName($ownedExecutable) -ine 'tabplayer.exe') { throw 'Only the exact owned TabPlayer executable may be controlled.' }
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class TabPlayerOwnedFolderPicker : IDisposable {
    delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,int flags,StringBuilder name,ref int size);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,EnumProc callback,IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder text,int capacity);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int capacity);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent,IntPtr child);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint thread,uint other,bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr SetText(IntPtr window,uint message,IntPtr w,string text,uint flags,uint timeout,out UIntPtr result);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr ReadText(IntPtr window,uint message,IntPtr capacity,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
    [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",SetLastError=true)] static extern IntPtr Send(IntPtr window,uint message,IntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
    readonly Process process;
    readonly IntPtr processHandle;
    readonly uint pid;
    readonly long startTicks;
    readonly string executable,ownedDirectory,folder;
    int completed;
    public long DialogHandle,EditHandle,ButtonHandle;

    public TabPlayerOwnedFolderPicker(int processId,string exe,long ticks,string owned,string selected) {
        executable=exe;startTicks=ticks;pid=(uint)processId;
        ownedDirectory=DirectoryPath(owned);folder=DirectoryPath(selected);
        if(!folder.StartsWith(ownedDirectory.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The selected folder must be inside the explicitly owned fixture directory.");
        process=Process.GetProcessById(processId);processHandle=process.Handle;
    }
    static string DirectoryPath(string path) {
        if(String.IsNullOrEmpty(path) || path.Length>32000 || path.Length<3 || !Char.IsLetter(path[0]) || path[1]!=':' || path[2]!='\\' || path.Substring(2).IndexOf(':')>=0 || !String.Equals(Path.GetFullPath(path),path,StringComparison.Ordinal)) throw new InvalidOperationException("A normalized absolute local Windows directory is required.");
        foreach(char value in path) if(value<32) throw new InvalidOperationException("Control characters are not allowed in the literal directory path.");
        var directory=new DirectoryInfo(path);
        for(var current=directory;current!=null;current=current.Parent) if(!current.Exists || (current.Attributes&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("Owned fixture directories must exist and must not traverse reparse points.");
        return directory.FullName;
    }
    void VerifyProcess() {
        long created,exited,kernel,user;int capacity=32768;var image=new StringBuilder(capacity);
        if(WaitForSingleObject(processHandle,0)!=258 || !GetProcessTimes(processHandle,out created,out exited,out kernel,out user) || DateTime.FromFileTimeUtc(created).Ticks!=startTicks || !QueryFullProcessImageName(processHandle,0,image,ref capacity) || !String.Equals(image.ToString(),executable,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The live process no longer matches the exact executable and captured UTC start ticks.");
        DirectoryPath(ownedDirectory);DirectoryPath(folder);
    }
    static string ClassName(IntPtr window) {var text=new StringBuilder(256);GetClassName(window,text,text.Capacity);return text.ToString();}
    static string Caption(IntPtr window) {var text=new StringBuilder(512);GetWindowText(window,text,text.Capacity);return text.ToString();}
    bool IsOwnedDialog(IntPtr window) {uint owner;GetWindowThreadProcessId(window,out owner);return owner==pid && IsWindowVisible(window) && ClassName(window)=="#32770";}
    IntPtr[] Dialogs() {
        var found=new List<IntPtr>();
        EnumWindows((window,parameter)=>{if(IsOwnedDialog(window))found.Add(window);return true;},IntPtr.Zero);
        return found.ToArray();
    }
    // A dialog opened by a hidden or background app does not receive the foreground from Windows' foreground lock. Ask for it once
    // the sole owned dialog is identified; VerifyDialog below still requires that it really is the foreground window.
    void Raise(IntPtr dialog) {
        var clock=Stopwatch.StartNew();
        while(clock.ElapsedMilliseconds<3000) {
            VerifyProcess();var dialogs=Dialogs();
            if(dialogs.Length!=1 || dialogs[0]!=dialog) return;
            if(GetAncestor(GetForegroundWindow(),2)==dialog) return;
            uint ignored;uint current=GetCurrentThreadId();uint holder=GetWindowThreadProcessId(GetForegroundWindow(),out ignored);
            bool attached=holder!=0 && holder!=current && AttachThreadInput(current,holder,true);
            try {BringWindowToTop(dialog);SetForegroundWindow(dialog);} finally {if(attached)AttachThreadInput(current,holder,false);}
            Thread.Sleep(100);
        }
    }
    void VerifyDialog(IntPtr dialog) {
        VerifyProcess();var dialogs=Dialogs();
        if(dialogs.Length!=1 || dialogs[0]!=dialog || !IsWindowEnabled(dialog) || GetAncestor(GetForegroundWindow(),2)!=dialog) throw new InvalidOperationException("The sole visible owned folder dialog must remain enabled and foreground.");
    }
    void VerifyControl(IntPtr dialog,IntPtr control,int id,string type) {
        uint owner;GetWindowThreadProcessId(control,out owner);
        if(owner!=pid || !IsChild(dialog,control) || GetAncestor(control,2)!=dialog || GetDlgCtrlID(control)!=id || ClassName(control)!=type || !IsWindowVisible(control) || !IsWindowEnabled(control)) throw new InvalidOperationException("The exact owned folder dialog control changed.");
    }
    IntPtr Control(IntPtr dialog,int id,string type) {
        var found=new List<IntPtr>();
        EnumChildWindows(dialog,(window,parameter)=>{if(GetDlgCtrlID(window)==id && ClassName(window)==type && IsWindowVisible(window))found.Add(window);return true;},IntPtr.Zero);
        if(found.Count!=1) throw new InvalidOperationException("The expected unique standard folder dialog control is unavailable; no input was sent.");
        VerifyControl(dialog,found[0],id,type);return found[0];
    }
    public void Run() {
        using(var watchdog=new Timer(ignored=>{if(Interlocked.CompareExchange(ref completed,1,0)==0){Console.Error.WriteLine("Owned folder picker helper timed out; terminating only this helper (124).");Environment.Exit(124);}},null,20000,Timeout.Infinite)) {
            try {
                var clock=Stopwatch.StartNew();IntPtr dialog=IntPtr.Zero;
                while(clock.ElapsedMilliseconds<10000) {
                    VerifyProcess();var dialogs=Dialogs();
                    if(dialogs.Length>1)throw new InvalidOperationException("More than one visible owned native dialog appeared.");
                    if(dialogs.Length==1){dialog=dialogs[0];break;}Thread.Sleep(50);
                }
                if(dialog==IntPtr.Zero)throw new TimeoutException("No owned native folder picker appeared within ten seconds.");
                Raise(dialog);VerifyDialog(dialog);
                // Standard common-item Folder edit (edt1) and English Select Folder/IDOK only.
                // Unsupported UI trees fail closed; there is no keyboard/address-bar fallback.
                var edit=Control(dialog,1152,"Edit");var button=Control(dialog,1,"Button");
                if(Caption(button).Replace("&","")!="Select Folder")throw new InvalidOperationException("The owned dialog is not the supported English Select Folder picker.");
                VerifyDialog(dialog);VerifyControl(dialog,edit,1152,"Edit");VerifyControl(dialog,button,1,"Button");
                UIntPtr result;
                if(SetText(edit,0x000C,IntPtr.Zero,folder,2,1000,out result)==IntPtr.Zero || result==UIntPtr.Zero)throw new InvalidOperationException("The exact folder edit did not accept the literal path.");
                var readback=new StringBuilder(folder.Length+1);
                VerifyDialog(dialog);VerifyControl(dialog,edit,1152,"Edit");
                if(ReadText(edit,0x000D,new IntPtr(readback.Capacity),readback,2,1000,out result)==IntPtr.Zero || readback.ToString()!=folder)throw new InvalidOperationException("The exact folder edit did not retain the literal path.");
                VerifyDialog(dialog);VerifyControl(dialog,edit,1152,"Edit");VerifyControl(dialog,button,1,"Button");
                if(Caption(button).Replace("&","")!="Select Folder")throw new InvalidOperationException("The exact Select Folder action changed before selection.");
                DialogHandle=dialog.ToInt64();EditHandle=edit.ToInt64();ButtonHandle=button.ToInt64();
                if(Send(button,0x00F5,IntPtr.Zero,IntPtr.Zero,2,1000,out result)==IntPtr.Zero)throw new InvalidOperationException("The exact Select Folder click did not complete.");
                clock.Restart();
                while(clock.ElapsedMilliseconds<5000){VerifyProcess();if(!IsOwnedDialog(dialog))return;Thread.Sleep(50);}
                throw new TimeoutException("The owned folder picker did not dismiss after one Select Folder action; no second action was sent.");
            } finally {Interlocked.Exchange(ref completed,1);}
        }
    }
    public void Dispose(){process.Dispose();}
}
'@
$picker=New-Object TabPlayerOwnedFolderPicker($AppProcessId,$ownedExecutable,$AppStartTicks,$OwnedDirectory,$FolderPath)
try {
    $picker.Run()
    @{kind='owned-native-folder-picker-dismissed';pid=$AppProcessId;executable=$ownedExecutable;utcStartTicks=$AppStartTicks.ToString();ownedDirectory=$OwnedDirectory;folder=$FolderPath;dialog=$picker.DialogHandle.ToString();edit=$picker.EditHandle.ToString();button=$picker.ButtonHandle.ToString();editId=1152;buttonId=1;acceptance='Dialog dismissal only: root must observe the exact selected folder in the native Library catalog.'} | ConvertTo-Json -Compress | Write-Output
} finally {$picker.Dispose()}
