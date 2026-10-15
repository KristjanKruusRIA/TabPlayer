param(
    [Parameter(Mandatory=$true)][int]$AppProcessId,
    [Parameter(Mandatory=$true)][string]$AppExecutable,
    [Parameter(Mandatory=$true)][string]$AppStartTicks,
    [Parameter(Mandatory=$true)][string]$SessionDirectory,
    [Parameter(Mandatory=$true)][long]$ExpectedGeneration,
    [Parameter(Mandatory=$true)][string]$ExpectedManifestSha256
)
$ErrorActionPreference='Stop'
if($AppStartTicks -notmatch '^\d+$' -or $ExpectedManifestSha256 -notmatch '^[a-f0-9]{64}$' -or $ExpectedGeneration -lt 1 -or $ExpectedGeneration -gt 9007199254740991){throw 'Invalid pinned recovery interruption identity'}
$startTicks=[long]::Parse($AppStartTicks,[Globalization.CultureInfo]::InvariantCulture)
if(-not [IO.Path]::IsPathRooted($SessionDirectory) -or -not [string]::Equals([IO.Path]::GetFullPath($SessionDirectory),$SessionDirectory,[StringComparison]::OrdinalIgnoreCase)){throw 'An absolute owned session directory is required'}
$ownedExecutable=(Resolve-Path -LiteralPath $AppExecutable).Path
if([IO.Path]::GetFileName($ownedExecutable) -ine 'tabplayer.exe'){throw 'Only the pinned TabPlayer diagnostic executable may be interrupted'}
$recoveryDirectory=[IO.Path]::Combine($SessionDirectory,'recovery-v1')
$manifestPath=[IO.Path]::Combine($recoveryDirectory,'manifest.json')
foreach($path in @($SessionDirectory,$recoveryDirectory,$manifestPath)){
    $item=Get-Item -LiteralPath $path -ErrorAction Stop
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Owned interruption paths must not be reparse points'}
}
if((Get-Item -LiteralPath $manifestPath).PSIsContainer){throw 'The owned manifest must be a regular file'}
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if($manifest.format -cne 'TabPlayerRecoveryManifest' -or $manifest.version -ne 1 -or $manifest.current.generation -ne $ExpectedGeneration){throw 'The expected acknowledged manifest generation changed before arming'}
Add-Type @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public sealed class TabPlayerRecoveryInterrupter : IDisposable {
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle,int flags,StringBuilder name,ref int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr handle,uint exitCode);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    readonly Process process;
    readonly IntPtr handle;
    readonly string executable,directory,manifest,manifestHash;
    readonly long startTicks,generation;
    readonly FileSystemWatcher watcher;
    readonly object gate=new object();
    readonly ManualResetEvent completed=new ManualResetEvent(false);
    bool finished;
    public bool Killed,TimedOut;
    public string TempPath,Error;
    public long TempBytes,ObservedAtUnixMs,KillAtUnixMs;
    static long Now(){return (DateTime.UtcNow.Ticks-621355968000000000L)/10000L;}
    public TabPlayerRecoveryInterrupter(int pid,string exe,long ticks,string root,string hash,long oldGeneration){
        executable=exe;startTicks=ticks;directory=root;manifest=Path.Combine(root,"manifest.json");manifestHash=hash;generation=oldGeneration;
        process=Process.GetProcessById(pid);handle=process.Handle;
        try{
            VerifyOwner();VerifyManifest();
            watcher=new FileSystemWatcher(directory,".checkpoint-*.json.*");
            watcher.IncludeSubdirectories=false;watcher.NotifyFilter=NotifyFilters.FileName|NotifyFilters.Size|NotifyFilters.LastWrite;
            watcher.Created+=OnChange;watcher.Changed+=OnChange;watcher.Renamed+=OnRename;
            watcher.EnableRaisingEvents=true;VerifyOwner();VerifyManifest();
        }catch{if(watcher!=null)watcher.Dispose();process.Dispose();throw;}
    }
    void VerifyOwner(){
        long created,exited,kernel,user;int size=32768;var path=new StringBuilder(size);
        if(WaitForSingleObject(handle,0)!=258 || !GetProcessTimes(handle,out created,out exited,out kernel,out user) || DateTime.FromFileTimeUtc(created).Ticks!=startTicks || !QueryFullProcessImageName(handle,0,path,ref size) || !String.Equals(path.ToString(),executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Cached process handle no longer matches the exact pinned live owner.");
    }
    void VerifyManifest(){
        byte[] bytes;
        using(var stream=new FileStream(manifest,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)){
            if(stream.Length>1048576)throw new InvalidOperationException("Unexpected owned manifest size.");
            using(var data=new MemoryStream()){stream.CopyTo(data);bytes=data.ToArray();}
        }
        using(var sha=SHA256.Create())if(!String.Equals(BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(),manifestHash,StringComparison.Ordinal))throw new InvalidOperationException("The acknowledged manifest changed before interruption; the write window was missed.");
    }
    void OnChange(object sender,FileSystemEventArgs e){Check(e.FullPath);}
    void OnRename(object sender,RenamedEventArgs e){Check(e.FullPath);}
    void Check(string path){
        lock(gate){
            if(finished)return;
            var match=Regex.Match(Path.GetFileName(path),@"^\.checkpoint-([1-9][0-9]*)\.json\.[A-Za-z0-9]{6}$");long next;
            if(!match.Success || !long.TryParse(match.Groups[1].Value,out next) || next<=generation || next>9007199254740991L || !String.Equals(Path.GetDirectoryName(path),directory,StringComparison.OrdinalIgnoreCase))return;
            try{
                var file=new FileInfo(path);
                if((file.Attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))!=0 || file.Length<=0)return;
                TempPath=path;TempBytes=file.Length;ObservedAtUnixMs=Now();
                VerifyManifest();VerifyOwner();
                if(!TerminateProcess(handle,137))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                KillAtUnixMs=Now();Killed=WaitForSingleObject(handle,5000)==0;
                if(!Killed)Error="The exact cached owner did not exit after termination.";
                finished=true;completed.Set();
            }catch(FileNotFoundException){}catch(DirectoryNotFoundException){}
            catch(Exception error){Error=error.Message;finished=true;completed.Set();}
        }
    }
    public void Wait(){
        var clock=Stopwatch.StartNew();
        while(clock.ElapsedMilliseconds<15000 && !completed.WaitOne(2)){
            foreach(var path in Directory.EnumerateFiles(directory,".checkpoint-*.json.*",SearchOption.TopDirectoryOnly))Check(path);
        }
        lock(gate){if(!finished){TimedOut=true;Error="No eligible positive-size checkpoint temp appeared in the bounded write window.";finished=true;}}
        watcher.EnableRaisingEvents=false;
    }
    public void Dispose(){watcher.EnableRaisingEvents=false;watcher.Dispose();lock(gate){finished=true;}completed.Dispose();process.Dispose();}
}
'@
$lease=New-Object TabPlayerRecoveryInterrupter($AppProcessId,$ownedExecutable,$startTicks,$recoveryDirectory,$ExpectedManifestSha256,$ExpectedGeneration)
try{
    @{kind='ready';helperPid=$PID;pid=$AppProcessId;executable=$ownedExecutable;utcStartTicks=$AppStartTicks;sessionDirectory=$SessionDirectory;expectedGeneration=$ExpectedGeneration;expectedManifestSha256=$ExpectedManifestSha256} | ConvertTo-Json -Compress | Write-Output
    [Console]::Out.Flush()
    $lease.Wait()
    @{kind='result';helperPid=$PID;pid=$AppProcessId;executable=$ownedExecutable;utcStartTicks=$AppStartTicks;sessionDirectory=$SessionDirectory;expectedGeneration=$ExpectedGeneration;expectedManifestSha256=$ExpectedManifestSha256;killed=$lease.Killed;timedOut=$lease.TimedOut;tempPath=$lease.TempPath;tempBytes=$lease.TempBytes;observedAtUnixMs=$lease.ObservedAtUnixMs;killAtUnixMs=$lease.KillAtUnixMs;error=$lease.Error} | ConvertTo-Json -Compress | Write-Output
}finally{$lease.Dispose()}
