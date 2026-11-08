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
    Add-Type -AssemblyName System.Drawing
    Add-Type -ReferencedAssemblies System.dll,System.Windows.Forms.dll,System.Drawing.dll @'
using System;
using System.Diagnostics;
using System.Drawing;
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
public sealed class TabPlayerDropSource : ITabPlayerDropSource {
    readonly TabPlayerOwnedDrop owner;
    public TabPlayerDropSource(TabPlayerOwnedDrop value) {owner=value;}
    public int QueryContinueDrag(bool escape,uint keyState) {return owner.QueryContinue(escape,keyState);}
    public int GiveFeedback(uint effect) {return owner.Feedback(effect);}
}
// The OLE drag loop only runs on mouse messages delivered to a window of the thread that called DoDragDrop. A window-less
// helper gets none, so DoDragDrop never calls the source back. This small non-activating window is where the primary
// button goes down, exactly as in a real drag; the owned app window keeps the foreground.
public sealed class TabPlayerSourceWindow : Form {
    public Action Pressed;
    public TabPlayerSourceWindow() {
        Text="TabPlayer drop source";FormBorderStyle=FormBorderStyle.None;StartPosition=FormStartPosition.Manual;ShowInTaskbar=false;TopMost=true;BackColor=Color.FromArgb(255,196,64);
    }
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{CreateParams value=base.CreateParams;value.ExStyle|=0x08000000|0x00000080;return value;}}
    protected override void OnMouseDown(MouseEventArgs e) {base.OnMouseDown(e);if(e.Button==MouseButtons.Left && Pressed!=null)Pressed();}
}
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class TabPlayerOwnedDrop : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct NativePoint { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] struct NativeRect { public int Left,Top,Right,Bottom; }
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
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out NativeRect rectangle);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out NativeRect rectangle);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref NativePoint point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(NativePoint point);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out NativePoint point);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
    [DllImport("ole32.dll")] static extern int OleInitialize(IntPtr reserved);
    [DllImport("ole32.dll")] static extern void OleUninitialize();
    [DllImport("ole32.dll")] static extern int DoDragDrop([MarshalAs(UnmanagedType.Interface)] ComDataObject data,[MarshalAs(UnmanagedType.Interface)] ITabPlayerDropSource source,uint allowed,out uint effect);
    const int Drop=0x40100,Cancel=0x40101,DefaultCursors=0x40102;
    const int SourceSize=56,SourceInset=8,SourceClearance=24,BudgetMs=5000,WatchdogMs=8000,DwellMs=250;
    readonly Process process;
    readonly IntPtr processHandle,window;
    readonly string executable;
    readonly int pid,x,y;
    readonly long ticks;
    readonly Stopwatch clock=new Stopwatch();
    readonly object gate=new object();
    TabPlayerSourceWindow form;
    DataObject data;
    int cancelRequested,pressedFlag,releaseSent,releaseDone,releaseCommanded,dragStarted,complete,expX,expY,prevX,prevY,sourceCenterX,sourceCenterY;
    public string Error;
    public int QueryCount,FeedbackCount,HResult,MoveSteps,GuardPassCount,SendAttemptCount,InsertedCount,SendError,DropReturnCount,CancelReturnCount,Phase,DragCallStarted,DragCallReturned,ScreenX,ScreenY,SourceLeft,SourceTop;
    public uint LastFeedback,Effect;
    public TabPlayerOwnedDrop(int processId,string exe,long startTicks,long hwnd,int clientX,int clientY) {
        pid=processId;executable=exe;ticks=startTicks;window=new IntPtr(hwnd);x=clientX;y=clientY;
        process=Process.GetProcessById(pid);processHandle=process.Handle;
    }
    void Verify(bool cursor) {
        long created,exited,kernel,user;int size=32768;var image=new StringBuilder(size);uint owner;NativeRect rect;
        if(WaitForSingleObject(processHandle,0)!=258 || !GetProcessTimes(processHandle,out created,out exited,out kernel,out user) || DateTime.FromFileTimeUtc(created).Ticks!=ticks || !QueryFullProcessImageName(processHandle,0,image,ref size) || !String.Equals(image.ToString(),executable,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The cached live process no longer matches the exact executable and UTC start ticks.");
        GetWindowThreadProcessId(window,out owner);
        if(window==IntPtr.Zero || owner!=(uint)pid || GetAncestor(window,2)!=window || !IsWindowVisible(window) || !IsWindowEnabled(window) || IsIconic(window) || GetAncestor(GetForegroundWindow(),2)!=window) throw new InvalidOperationException("The exact owned visible main window must remain enabled and foreground.");
        var point=new NativePoint {X=x,Y=y};
        if(!GetClientRect(window,out rect) || x<rect.Left || y<rect.Top || x>=rect.Right || y>=rect.Bottom || !ClientToScreen(window,ref point) || GetAncestor(WindowFromPoint(point),2)!=window) throw new InvalidOperationException("The requested physical client point is outside or obscured by another window.");
        ScreenX=point.X;ScreenY=point.Y;
        if(cursor) {
            NativePoint actual;
            if(!GetCursorPos(out actual)) throw new InvalidOperationException("The pointer position could not be read.");
            bool onPath;lock(gate){onPath=(actual.X==expX && actual.Y==expY) || (actual.X==prevX && actual.Y==prevY);}
            if(!onPath) throw new InvalidOperationException("The pointer left the scripted drag path; user input cancels this automated source.");
        }
        foreach(int key in new int[]{2,4,5,6,16,17,18,27}) if(GetAsyncKeyState(key)<0) throw new InvalidOperationException("Other mouse buttons, modifiers and Escape must remain released; user input cancels this automated source.");
        // The primary button may be down only between this helper's own press and release.
        if(GetAsyncKeyState(1)<0 && (Volatile.Read(ref pressedFlag)==0 || Volatile.Read(ref releaseDone)!=0)) throw new InvalidOperationException("The primary button is down outside this helper's own press; user input cancels this automated source.");
    }
    void Reject(string message) {lock(gate){if(Error==null)Error=message;}Interlocked.Exchange(ref cancelRequested,1);}
    bool Admit() {
        try {
            Verify(true);
            if(clock.ElapsedMilliseconds>=BudgetMs) throw new TimeoutException("Five seconds elapsed; cancellation is requested pending an OLE callback.");
            Interlocked.Increment(ref GuardPassCount);
            return Volatile.Read(ref cancelRequested)==0;
        } catch(Exception error) {Reject(error.Message);return false;}
    }
    void Check() {if(!Admit())throw new InvalidOperationException(Error ?? "The drag was cancelled.");}
    static Input Absolute(int screenX,int screenY) {
        int vx=GetSystemMetrics(76),vy=GetSystemMetrics(77),vw=GetSystemMetrics(78),vh=GetSystemMetrics(79);
        // Ceiling keeps the integer pixel exact when Windows maps the normalized 0..65535 value back to a pixel.
        int ax=(int)Math.Ceiling((screenX-vx)*65536.0/vw),ay=(int)Math.Ceiling((screenY-vy)*65536.0/vh);
        return new Input {Type=0,Mouse=new MouseInput {X=ax,Y=ay,Flags=0x0001|0x2000|0x4000|0x8000}};
    }
    static Input Button(uint flags) {return new Input {Type=0,Mouse=new MouseInput {Flags=flags}};}
    void Send(params Input[] inputs) {
        Interlocked.Increment(ref SendAttemptCount);
        uint inserted=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));
        if(inserted==inputs.Length){Interlocked.Add(ref InsertedCount,inputs.Length);return;}
        int error=Marshal.GetLastWin32Error();Volatile.Write(ref SendError,error);
        throw new InvalidOperationException("Native input was not inserted (Win32 error "+error+").");
    }
    // Moves the pointer to an exact physical pixel. The path guard accepts the previous or the new position while the move lands.
    void Place(int screenX,int screenY,bool settle) {
        lock(gate){prevX=expX;prevY=expY;expX=screenX;expY=screenY;}
        Send(Absolute(screenX,screenY));
        Interlocked.Increment(ref MoveSteps);
        if(!settle)return;
        var end=clock.ElapsedMilliseconds+300;NativePoint actual;
        while(true) {
            if(GetCursorPos(out actual) && actual.X==screenX && actual.Y==screenY)break;
            if(clock.ElapsedMilliseconds>end) throw new InvalidOperationException("The pointer did not reach the scripted position.");
            Thread.Sleep(5);
        }
        lock(gate){prevX=expX;prevY=expY;}
    }
    // Idempotent. Runs from the normal release, the failure path, the watchdog and process exit, so a button this helper pressed is never left down.
    public void ReleaseLeft() {
        if(Volatile.Read(ref pressedFlag)==0 || Interlocked.Exchange(ref releaseSent,1)!=0)return;
        SendInput(1,new Input[]{Button(0x0004)},Marshal.SizeOf(typeof(Input)));
        var end=Environment.TickCount+500;
        while(GetAsyncKeyState(1)<0 && Environment.TickCount<end)Thread.Sleep(5);
        Volatile.Write(ref releaseDone,1);
        Console.Error.WriteLine("LEFT_BUTTON_RELEASED");
    }
    void CloseForm() {try{if(form!=null && form.IsHandleCreated)form.BeginInvoke(new Action(form.Close));}catch(Exception){}}
    void Watchdog(object ignored) {
        if(Interlocked.CompareExchange(ref complete,1,0)!=0)return;
        try{ReleaseLeft();}catch(Exception){}
        Console.Error.WriteLine("Native OLE helper watchdog (124): phase={0}; callStarted={1}; callReturned={2}; moveSteps={3}; guardPasses={4}; sendAttempts={5}; insertedEvents={6}; sendError={7}; queries={8}; feedback={9}; lastEffect={10}; dropReturns={11}; cancelReturns={12}; cancelRequested={13}; error={14}",
            Volatile.Read(ref Phase),Volatile.Read(ref DragCallStarted),Volatile.Read(ref DragCallReturned),Volatile.Read(ref MoveSteps),Volatile.Read(ref GuardPassCount),Volatile.Read(ref SendAttemptCount),Volatile.Read(ref InsertedCount),Volatile.Read(ref SendError),Volatile.Read(ref QueryCount),Volatile.Read(ref FeedbackCount),Volatile.Read(ref LastFeedback),Volatile.Read(ref DropReturnCount),Volatile.Read(ref CancelReturnCount),Volatile.Read(ref cancelRequested),(Volatile.Read(ref Error) ?? "").Replace("\r"," ").Replace("\n"," "));
        Environment.Exit(124);
    }
    public int QueryContinue(bool escape,uint keyState) {
        Interlocked.Increment(ref QueryCount);
        if(escape || (keyState&~1u)!=0)Reject("Escape or native modifier/secondary-button input cancelled the source.");
        if(Volatile.Read(ref cancelRequested)!=0 || !Admit()){Interlocked.Increment(ref CancelReturnCount);return Cancel;}
        if((keyState&1u)==0) {
            // The primary button went up. That is a drop only when this helper commanded the release.
            if(Volatile.Read(ref releaseCommanded)!=0){Interlocked.Increment(ref DropReturnCount);return Drop;}
            Reject("The primary button was released without the helper's release.");Interlocked.Increment(ref CancelReturnCount);return Cancel;
        }
        return 0;
    }
    public int Feedback(uint effect) {Interlocked.Increment(ref FeedbackCount);Volatile.Write(ref LastFeedback,effect);if(Volatile.Read(ref cancelRequested)==0)Admit();return DefaultCursors;}
    // Runs on the UI thread from the source window's primary-button press, so the OLE loop shares the thread that owns the mouse capture.
    void BeginDrag() {
        if(Interlocked.CompareExchange(ref dragStarted,1,0)!=0)return;
        try {
            Volatile.Write(ref Phase,3);Volatile.Write(ref DragCallStarted,1);
            uint effect;
            HResult=DoDragDrop((ComDataObject)data,new TabPlayerDropSource(this),1,out effect);
            Effect=effect;
            Volatile.Write(ref DragCallReturned,1);
        } catch(Exception error) {Reject(error.Message);}
        finally {Volatile.Write(ref Phase,6);CloseForm();}
    }
    void Script() {
        var oldDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            if(oldDpi==IntPtr.Zero)throw new InvalidOperationException("The input thread could not establish physical coordinate awareness.");
            NativeRect shown;
            if(!GetWindowRect(form.Handle,out shown))throw new InvalidOperationException("The source window rectangle is unavailable.");
            sourceCenterX=(shown.Left+shown.Right)/2;sourceCenterY=(shown.Top+shown.Bottom)/2;
            var top=new NativePoint {X=sourceCenterX,Y=sourceCenterY};
            if(GetAncestor(WindowFromPoint(top),2)!=form.Handle || !IsWindowVisible(form.Handle))throw new InvalidOperationException("The helper-owned source window is hidden or obscured.");
            Verify(false);
            // Put the pointer on the source window first; the press below repeats the same absolute move atomically.
            lock(gate){expX=prevX=sourceCenterX;expY=prevY=sourceCenterY;}
            Send(Absolute(sourceCenterX,sourceCenterY));
            var end=clock.ElapsedMilliseconds+300;NativePoint actual;
            while(!(GetCursorPos(out actual) && actual.X==sourceCenterX && actual.Y==sourceCenterY)) {
                if(clock.ElapsedMilliseconds>end)throw new InvalidOperationException("The pointer did not reach the helper-owned source window.");
                Thread.Sleep(5);
            }
            Check();
            // The move and the press are one SendInput call, so nothing can come between them: the press lands on the source window.
            Volatile.Write(ref Phase,2);Volatile.Write(ref pressedFlag,1);Console.Error.WriteLine("LEFT_BUTTON_PRESSED");
            Send(Absolute(sourceCenterX,sourceCenterY),Button(0x0002));
            end=clock.ElapsedMilliseconds+2000;
            while(Volatile.Read(ref DragCallStarted)==0) {
                if(clock.ElapsedMilliseconds>end)throw new InvalidOperationException("The press on the helper-owned source window did not start the OLE drag.");
                Thread.Sleep(5);
            }
            Thread.Sleep(60);Check();
            // Real pointer travel with the button held: this is what drives the OLE drag loop.
            int steps=Math.Max(20,Math.Min(60,(int)(Math.Sqrt(Math.Pow(ScreenX-sourceCenterX,2)+Math.Pow(ScreenY-sourceCenterY,2))/20)));
            for(int step=1;step<=steps;step++) {
                Check();
                Place(sourceCenterX+(int)((long)(ScreenX-sourceCenterX)*step/steps),sourceCenterY+(int)((long)(ScreenY-sourceCenterY)*step/steps),step==steps);
                Thread.Sleep(12);
            }
            Volatile.Write(ref Phase,4);
            int feedbackAtArrival=Volatile.Read(ref FeedbackCount);long arrived=clock.ElapsedMilliseconds;
            while(!(Volatile.Read(ref FeedbackCount)>=feedbackAtArrival+2 && (Volatile.Read(ref LastFeedback)&1u)!=0 && clock.ElapsedMilliseconds-arrived>=DwellMs)) {
                Check();Thread.Sleep(10);
            }
            Check();
            Volatile.Write(ref Phase,5);Volatile.Write(ref releaseCommanded,1);
            ReleaseLeft();
            end=clock.ElapsedMilliseconds+2000;
            while(Volatile.Read(ref DragCallReturned)==0) {
                if(clock.ElapsedMilliseconds>end)throw new InvalidOperationException("OLE did not return after the commanded release.");
                Thread.Sleep(5);
            }
        } catch(Exception error) {Reject(error.Message);}
        finally {
            try{ReleaseLeft();}catch(Exception error){Reject(error.Message);}
            if(Volatile.Read(ref DragCallStarted)==0)CloseForm();
            if(oldDpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(oldDpi);
        }
    }
    // The source window goes in a corner of the owned client area that stays clear of the drop point, so the drag path stays over the app.
    void Layout() {
        NativeRect client;var origin=new NativePoint();
        if(!GetClientRect(window,out client) || !ClientToScreen(window,ref origin))throw new InvalidOperationException("The owned client rectangle is unavailable.");
        int vx=GetSystemMetrics(76),vy=GetSystemMetrics(77),vw=GetSystemMetrics(78),vh=GetSystemMetrics(79);
        int width=client.Right-client.Left,height=client.Bottom-client.Top;
        int[][] corners=new int[][]{
            new int[]{SourceInset,SourceInset},
            new int[]{width-SourceInset-SourceSize,SourceInset},
            new int[]{SourceInset,height-SourceInset-SourceSize},
            new int[]{width-SourceInset-SourceSize,height-SourceInset-SourceSize}};
        foreach(int[] corner in corners) {
            int left=origin.X+corner[0],top=origin.Y+corner[1];
            bool onScreen=left>=vx && top>=vy && left+SourceSize<=vx+vw && top+SourceSize<=vy+vh;
            bool clearOfDrop=ScreenX<left-SourceClearance || ScreenX>=left+SourceSize+SourceClearance || ScreenY<top-SourceClearance || ScreenY>=top+SourceSize+SourceClearance;
            if(onScreen && clearOfDrop){SourceLeft=left;SourceTop=top;return;}
        }
        throw new InvalidOperationException("No on-screen corner of the owned client area is clear of the drop point for the helper-owned source window.");
    }
    public void VerifyCompletion() {
        var oldDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
        if(oldDpi==IntPtr.Zero)throw new InvalidOperationException("Physical client coordinate awareness could not be established.");
        try{Verify(true);}finally{SetThreadDpiAwarenessContext(oldDpi);}
    }
    public void Run(string[] paths) {
        if(Thread.CurrentThread.GetApartmentState()!=ApartmentState.STA)throw new InvalidOperationException("The OLE source requires STA.");
        var oldDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));
        if(oldDpi==IntPtr.Zero)throw new InvalidOperationException("Physical client coordinate awareness could not be established.");
        bool ole=false;Timer watchdog=null;
        EventHandler exitRelease=delegate(object sender,EventArgs e){try{ReleaseLeft();}catch(Exception){}};
        AppDomain.CurrentDomain.ProcessExit+=exitRelease;
        try {
            Verify(false);
            int initialized=OleInitialize(IntPtr.Zero);if(initialized<0)Marshal.ThrowExceptionForHR(initialized);ole=true;
            data=new DataObject();data.SetData(DataFormats.FileDrop,true,paths);
            Layout();
            form=new TabPlayerSourceWindow();
            form.Bounds=new Rectangle(SourceLeft,SourceTop,SourceSize,SourceSize);
            form.Pressed=BeginDrag;
            form.Shown+=delegate(object sender,EventArgs e){var thread=new Thread(Script);thread.IsBackground=true;thread.Start();};
            clock.Start();Volatile.Write(ref Phase,1);
            watchdog=new Timer(Watchdog,null,WatchdogMs,Timeout.Infinite);
            Application.Run(form);
            Volatile.Write(ref Phase,7);
            if(HResult!=Drop || Effect!=1 || Volatile.Read(ref Error)!=null)throw new InvalidOperationException(Volatile.Read(ref Error) ?? String.Format("Native OLE did not complete Copy (HRESULT 0x{0:X8}, effect {1}).",HResult,Effect));
        } finally {
            Volatile.Write(ref Phase,8);
            try{ReleaseLeft();}finally{
                AppDomain.CurrentDomain.ProcessExit-=exitRelease;
                try{if(form!=null)form.Dispose();}finally{
                    try{if(ole)OleUninitialize();}finally{SetThreadDpiAwarenessContext(oldDpi);Volatile.Write(ref Phase,9);Interlocked.Exchange(ref complete,1);if(watchdog!=null)watchdog.Dispose();}
                }
            }
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
        $receipt=@{kind='native-ole-source-completed';helperPid=$PID;pid=$AppProcessId;executable=$ownedExecutable;utcStartTicks=$AppStartTicks.ToString();window=$TargetWindowHandle.ToString();clientX=$ClientX;clientY=$ClientY;screenX=$drop.ScreenX;screenY=$drop.ScreenY;hresult=$drop.HResult;effect=$drop.Effect;phase=$drop.Phase;callStarted=$drop.DragCallStarted;callReturned=$drop.DragCallReturned;moveSteps=$drop.MoveSteps;guardPassCount=$drop.GuardPassCount;sendAttempts=$drop.SendAttemptCount;insertedEvents=$drop.InsertedCount;sendError=$drop.SendError;queryCount=$drop.QueryCount;feedbackCount=$drop.FeedbackCount;lastEffect=$drop.LastFeedback;dropReturns=$drop.DropReturnCount;cancelReturns=$drop.CancelReturnCount;files=$receipts;source=@{kind='helper-owned-non-activating-window';left=$drop.SourceLeft;top=$drop.SourceTop;width=56;height=56;input='injected primary-button press on the source window, absolute pointer path, release over the owned drop point'};acceptance='Source completion only: root must observe the actual Tauri Drop event and resulting workspace/errors.'}
        $json=$receipt | ConvertTo-Json -Depth 5 -Compress
        # Windows PowerShell writes a redirected stdout in the console code page, which drops non-ASCII path characters. Escape them so the receipt is exact.
        [regex]::Replace($json,'[^\x00-\x7F]',[Text.RegularExpressions.MatchEvaluator]{param($m) '\u{0:x4}' -f [int][char]$m.Value}) | Write-Output
    } finally {$drop.Dispose()}
} finally {foreach($stream in $streams){$stream.Dispose()}}
