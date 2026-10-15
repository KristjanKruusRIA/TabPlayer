param(
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$AppProcessId,
    [Parameter(Mandatory=$true)][string]$AppExecutable,
    [Parameter(Mandatory=$true)][ValidateRange(1,[long]::MaxValue)][long]$AppStartTicks,
    [Parameter(Mandatory=$true)][long]$TargetWindowHandle,
    [Parameter(Mandatory=$true)][ValidateRange(0,32767)][int]$ClientX,
    [Parameter(Mandatory=$true)][ValidateRange(0,32767)][int]$ClientY,
    [Parameter(Mandatory=$true)][string]$OwnedDirectory,
    [Parameter(Mandatory=$true)][string]$FilePathsJson
)
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Use Windows PowerShell 5.1 for the built-in .NET Framework OLE data object.' }
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') { throw 'Run this diagnostic helper with powershell.exe -STA.' }
function Get-OwnedLiteralPath([string]$Path,[switch]$Directory) {
    if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.IndexOf([char]0) -ge 0 -or $Path.Length -gt 32767 -or [IO.Path]::GetFullPath($Path) -cne $Path) { throw 'A normalized absolute local Windows path is required.' }
    $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -ne [bool]$Directory) { throw 'An owned path has the wrong file type.' }
    $cursor=$item
    while ($null -ne $cursor) {
        if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Owned diagnostic paths must not traverse reparse points.' }
        $cursor=if($cursor.PSIsContainer){$cursor.Parent}else{$cursor.Directory}
    }
    return $item.FullName
}
$ownedExecutable=Get-OwnedLiteralPath $AppExecutable
if ([IO.Path]::GetFileName($ownedExecutable) -ine 'tabplayer.exe') { throw 'Only the exact owned TabPlayer diagnostic executable may receive this drop.' }
$ownedRoot=(Get-OwnedLiteralPath $OwnedDirectory -Directory).TrimEnd('\')+'\'
if (-not $FilePathsJson.TrimStart().StartsWith('[')) { throw 'Supply an explicit JSON array of owned literal file paths.' }
$paths=ConvertFrom-Json -InputObject $FilePathsJson
if ($paths.Count -lt 1 -or $paths.Count -gt 32) { throw 'Supply an explicit JSON array containing 1 to 32 owned literal file paths.' }
$streams=New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
$receipts=@()
try {
    $nativePaths=@(); $characters=1
    foreach ($path in $paths) {
        if ($path -isnot [string]) { throw 'Every file-drop member must be a literal path string.' }
        $literal=Get-OwnedLiteralPath $path
        if (-not $literal.StartsWith($ownedRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Every dropped file must be inside the explicitly supplied owned fixture directory.' }
        $characters+=$literal.Length+1
        if ($characters -gt 65536) { throw 'The bounded native file-drop path vector is too large.' }
        $stream=[IO.File]::Open($literal,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $streams.Add($stream)
        $sha=[Security.Cryptography.SHA256]::Create()
        try {$digest=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant(); $stream.Position=0} finally {$sha.Dispose()}
        $nativePaths+=$literal
        $receipts+=@{path=$literal;bytes=$stream.Length;sha256=$digest}
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -ReferencedAssemblies System.dll,System.Windows.Forms.dll @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using ComDataObject=System.Runtime.InteropServices.ComTypes.IDataObject;
using Timer=System.Threading.Timer;

[ComVisible(true), Guid("00000121-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITabPlayerDropSource {
    [PreserveSig] int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escape, uint keyState);
    [PreserveSig] int GiveFeedback(uint effect);
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class TabPlayerOwnedDrop : ITabPlayerDropSource, IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left,Top,Right,Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type;public MouseInput Mouse; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle,int flags,StringBuilder name,ref int size);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rectangle);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,ref Input input,int size);
    [DllImport("ole32.dll")] static extern int OleInitialize(IntPtr reserved);
    [DllImport("ole32.dll")] static extern void OleUninitialize();
    [DllImport("ole32.dll")] static extern int DoDragDrop([MarshalAs(UnmanagedType.Interface)] ComDataObject data,[MarshalAs(UnmanagedType.Interface)] ITabPlayerDropSource source,uint allowed,out uint effect);
    const int Drop=0x40100,Cancel=0x40101,DefaultCursors=0x40102;
    readonly Process process;
    readonly IntPtr processHandle,window;
    readonly string executable;
    readonly int pid,x,y;
    readonly long ticks;
    readonly Stopwatch clock=new Stopwatch();
    readonly object pulseGate=new object();
    int active,complete,cancelRequested;
    public string Error;
    public int QueryCount,FeedbackCount,HResult,PulseCount,GuardPassCount,SendAttemptCount,InsertedCount,SendError,DropReturnCount,CancelReturnCount,Phase,DragCallStarted,DragCallReturned;
    public uint LastFeedback,Effect;
    public int ScreenX,ScreenY;
    public TabPlayerOwnedDrop(int processId,string exe,long startTicks,long hwnd,int clientX,int clientY) {
        pid=processId;executable=exe;ticks=startTicks;window=new IntPtr(hwnd);x=clientX;y=clientY;
        process=Process.GetProcessById(pid);processHandle=process.Handle;
    }
    void Verify(bool cursor) {
        long created,exited,kernel,user;int size=32768;var image=new StringBuilder(size);uint owner;Rect rect;
        if(WaitForSingleObject(processHandle,0)!=258 || !GetProcessTimes(processHandle,out created,out exited,out kernel,out user) || DateTime.FromFileTimeUtc(created).Ticks!=ticks || !QueryFullProcessImageName(processHandle,0,image,ref size) || !String.Equals(image.ToString(),executable,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The cached live process no longer matches the exact executable and UTC start ticks.");
        GetWindowThreadProcessId(window,out owner);
        if(window==IntPtr.Zero || owner!=(uint)pid || GetAncestor(window,2)!=window || !IsWindowVisible(window) || !IsWindowEnabled(window) || IsIconic(window) || GetAncestor(GetForegroundWindow(),2)!=window) throw new InvalidOperationException("The exact owned visible main window must remain enabled and foreground.");
        var point=new Point {X=x,Y=y};
        if(!GetClientRect(window,out rect) || x<rect.Left || y<rect.Top || x>=rect.Right || y>=rect.Bottom || !ClientToScreen(window,ref point) || GetAncestor(WindowFromPoint(point),2)!=window) throw new InvalidOperationException("The requested physical client point is outside or obscured by another window.");
        ScreenX=point.X;ScreenY=point.Y;
        Point actual;
        if(cursor && (!GetCursorPos(out actual) || actual.X!=point.X || actual.Y!=point.Y)) throw new InvalidOperationException("The pointer moved away from the exact owned drop point.");
        foreach(int key in new int[]{1,2,4,5,6,16,17,18,27}) if(GetAsyncKeyState(key)<0) throw new InvalidOperationException("Mouse buttons, modifiers and Escape must remain released; user input cancels this automated source.");
    }
    void Reject(string message) {lock(pulseGate){Interlocked.CompareExchange(ref Error,message,null);Interlocked.Exchange(ref cancelRequested,1);}}
    bool Admit() {
        try {Verify(true);if(clock.ElapsedMilliseconds>=4000)throw new TimeoutException("Four seconds elapsed; cancellation is requested pending an OLE callback.");return Volatile.Read(ref cancelRequested)==0;}
        catch(Exception error){Reject(error.Message);return false;}
    }
    void Pulse(object ignored) {
        Interlocked.Increment(ref PulseCount);
        lock(pulseGate) {
            if(Volatile.Read(ref active)==0 || Volatile.Read(ref complete)!=0 || Volatile.Read(ref cancelRequested)!=0)return;
            var oldDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
            if(oldDpi==IntPtr.Zero){Reject("The input timer could not establish physical coordinate awareness.");return;}
            try {
                if(!Admit())return;
                Interlocked.Increment(ref GuardPassCount);
                if(Volatile.Read(ref active)==0 || Volatile.Read(ref complete)!=0 || Volatile.Read(ref cancelRequested)!=0)return;
                // Relative zero motion only: no coordinate displacement, key, wheel or button flags.
                var input=new Input {Type=0,Mouse=new MouseInput {Flags=0x2001}};
                Interlocked.Increment(ref SendAttemptCount);
                uint inserted=SendInput(1,ref input,Marshal.SizeOf(typeof(Input)));
                int error=inserted==1 ? 0 : Marshal.GetLastWin32Error();
                Volatile.Write(ref SendError,error);
                if(inserted==1)Interlocked.Increment(ref InsertedCount);else Reject("Native zero-motion input was not inserted (Win32 error "+error+").");
            }catch(Exception error){Reject(error.Message);}
            finally{SetThreadDpiAwarenessContext(oldDpi);}
        }
    }
    void Watchdog(object ignored) {
        if(Interlocked.CompareExchange(ref complete,1,0)!=0)return;
        Console.Error.WriteLine("Native OLE helper watchdog (124): phase={0}; callStarted={1}; callReturned={2}; pulses={3}; guardPasses={4}; sendAttempts={5}; insertedEvents={6}; sendError={7}; queries={8}; feedback={9}; lastEffect={10}; dropReturns={11}; cancelReturns={12}; cancelRequested={13}; error={14}",
            Volatile.Read(ref Phase),Volatile.Read(ref DragCallStarted),Volatile.Read(ref DragCallReturned),Volatile.Read(ref PulseCount),Volatile.Read(ref GuardPassCount),Volatile.Read(ref SendAttemptCount),Volatile.Read(ref InsertedCount),Volatile.Read(ref SendError),Volatile.Read(ref QueryCount),Volatile.Read(ref FeedbackCount),Volatile.Read(ref LastFeedback),Volatile.Read(ref DropReturnCount),Volatile.Read(ref CancelReturnCount),Volatile.Read(ref cancelRequested),(Volatile.Read(ref Error) ?? "").Replace("\r"," ").Replace("\n"," "));
        Environment.Exit(124);
    }
    public int QueryContinueDrag(bool escape,uint keyState) {
        Interlocked.Increment(ref QueryCount);
        lock(pulseGate) {
            if(escape || keyState!=0)Reject("Escape or native button/modifier input cancelled the source.");
            if(Volatile.Read(ref cancelRequested)!=0 || !Admit()){Interlocked.Increment(ref CancelReturnCount);return Cancel;}
            if(Volatile.Read(ref FeedbackCount)>0 && (Volatile.Read(ref LastFeedback)&1)!=0 && clock.ElapsedMilliseconds>=250){Interlocked.Increment(ref DropReturnCount);return Drop;}
            return 0;
        }
    }
    public int GiveFeedback(uint effect) {Interlocked.Increment(ref FeedbackCount);Volatile.Write(ref LastFeedback,effect);if(Volatile.Read(ref cancelRequested)==0)Admit();return DefaultCursors;}
    public void VerifyCompletion() {
        var oldDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
        if(oldDpi==IntPtr.Zero)throw new InvalidOperationException("Physical client coordinate awareness could not be established.");
        try{Verify(true);}finally{SetThreadDpiAwarenessContext(oldDpi);}
    }
    public void Run(string[] paths) {
        if(Thread.CurrentThread.GetApartmentState()!=ApartmentState.STA)throw new InvalidOperationException("The OLE source requires STA.");
        var oldDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
        if(oldDpi==IntPtr.Zero)throw new InvalidOperationException("Physical client coordinate awareness could not be established.");
        bool ole=false;Timer watchdog=null,pulse=null;
        try {
            Verify(false);
            int initialized=OleInitialize(IntPtr.Zero);if(initialized<0)Marshal.ThrowExceptionForHR(initialized);ole=true;
            var data=new DataObject();data.SetData(DataFormats.FileDrop,true,paths);
            Verify(false);if(!SetCursorPos(ScreenX,ScreenY))throw new InvalidOperationException("The owned drop point could not receive the cursor.");Verify(true);
            clock.Start();Volatile.Write(ref active,1);Volatile.Write(ref Phase,1);
            watchdog=new Timer(Watchdog,null,6000,Timeout.Infinite);
            pulse=new Timer(Pulse,null,50,50);
            Volatile.Write(ref Phase,2);Volatile.Write(ref DragCallStarted,1);
            HResult=DoDragDrop((ComDataObject)data,this,1,out Effect);
            Volatile.Write(ref DragCallReturned,1);Volatile.Write(ref Phase,3);
            lock(pulseGate){Volatile.Write(ref active,0);}Verify(true);
            if(HResult!=Drop || Effect!=1 || Volatile.Read(ref Error)!=null)throw new InvalidOperationException(Volatile.Read(ref Error) ?? String.Format("Native OLE did not complete Copy (HRESULT 0x{0:X8}, effect {1}).",HResult,Effect));
        } finally {
            Volatile.Write(ref Phase,4);lock(pulseGate){Volatile.Write(ref active,0);}
            if(pulse!=null){using(var drained=new ManualResetEvent(false)){if(pulse.Dispose(drained))drained.WaitOne();}}
            try{if(ole)OleUninitialize();}finally{SetThreadDpiAwarenessContext(oldDpi);Volatile.Write(ref Phase,5);Interlocked.Exchange(ref complete,1);if(watchdog!=null)watchdog.Dispose();}
        }
    }
    public void Dispose(){process.Dispose();}
}
'@
    $drop=New-Object TabPlayerOwnedDrop($AppProcessId,$ownedExecutable,$AppStartTicks,$TargetWindowHandle,$ClientX,$ClientY)
    try {
        $drop.Run([string[]]$nativePaths)
        for ($index=0; $index -lt $streams.Count; $index++) {
            $null=Get-OwnedLiteralPath $nativePaths[$index]
            $streams[$index].Position=0; $sha=[Security.Cryptography.SHA256]::Create()
            try {$digest=[BitConverter]::ToString($sha.ComputeHash($streams[$index])).Replace('-','').ToLowerInvariant()} finally {$sha.Dispose()}
            if ($digest -cne $receipts[$index].sha256) { throw 'A source file changed during the owned native drop.' }
        }
        $drop.VerifyCompletion()
        @{kind='native-ole-source-completed';helperPid=$PID;pid=$AppProcessId;executable=$ownedExecutable;utcStartTicks=$AppStartTicks.ToString();window=$TargetWindowHandle.ToString();clientX=$ClientX;clientY=$ClientY;screenX=$drop.ScreenX;screenY=$drop.ScreenY;hresult=$drop.HResult;effect=$drop.Effect;phase=$drop.Phase;callStarted=$drop.DragCallStarted;callReturned=$drop.DragCallReturned;pulseCount=$drop.PulseCount;guardPassCount=$drop.GuardPassCount;sendAttempts=$drop.SendAttemptCount;insertedEvents=$drop.InsertedCount;sendError=$drop.SendError;queryCount=$drop.QueryCount;feedbackCount=$drop.FeedbackCount;lastEffect=$drop.LastFeedback;dropReturns=$drop.DropReturnCount;cancelReturns=$drop.CancelReturnCount;files=$receipts;acceptance='Source completion only: root must observe the actual Tauri Drop event and resulting workspace/errors.'} | ConvertTo-Json -Depth 5 -Compress | Write-Output
    } finally {$drop.Dispose()}
} finally {foreach($stream in $streams){$stream.Dispose()}}
