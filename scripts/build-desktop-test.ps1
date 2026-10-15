$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$testDirectory=Join-Path $taskRoot '.analysis/desktop-smoke'
New-Item -ItemType Directory -Force -Path $testDirectory | Out-Null
$testConfiguration=Join-Path $testDirectory 'tauri-test.json'
@{app=@{windows=@(@{label='main';title='TabPlayer Test';width=1440;height=900;minWidth=960;minHeight=600;additionalBrowserArgs='--remote-debugging-port=9223';dataDirectory=(Join-Path $testDirectory 'webview-profile')})}} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $testConfiguration
$previousTestFlag=$env:VITE_DESKTOP_TEST
try {
    $env:VITE_DESKTOP_TEST='1'
    Push-Location $taskRoot
    npm run tauri -- build --no-bundle --features desktop-test --config $testConfiguration
    if($LASTEXITCODE -ne 0){throw 'Desktop test build failed'}
    $destination=Join-Path $testDirectory 'tabplayer.exe'
    foreach($testProcess in @(Get-Process tabplayer -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $destination})){
        Stop-Process -Id $testProcess.Id
        $null=$testProcess.WaitForExit(5000)
    }
    Copy-Item -LiteralPath (Join-Path $taskRoot 'src-tauri/target/release/tabplayer.exe') -Destination $destination
    node scripts/prepare-library.mjs --destination (Join-Path $testDirectory 'library')
    if($LASTEXITCODE -ne 0){throw 'Desktop test Library resources could not be prepared'}
    $testAudio=Join-Path $testDirectory 'audio'
    $preparedAudio=(Resolve-Path (Join-Path $taskRoot 'src-tauri/resources/audio')).Path
    if(-not (Test-Path -LiteralPath $testAudio)){
        New-Item -ItemType Junction -Path $testAudio -Target $preparedAudio | Out-Null
    } elseif ((Get-Item -LiteralPath $testAudio).Target -ne $preparedAudio) {
        throw 'Desktop test audio path must point to this worktree prepared resources'
    }
} finally {Pop-Location;$env:VITE_DESKTOP_TEST=$previousTestFlag}
