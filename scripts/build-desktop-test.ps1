$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$testDirectory=Join-Path $taskRoot '.analysis/desktop-smoke'
New-Item -ItemType Directory -Force -Path $testDirectory | Out-Null
$testConfiguration=Join-Path $testDirectory 'tauri-test.json'
# Its own identifier keeps the test app apart from an installed or `tauri dev` TabPlayer: a shared one would hand the
# test launch to that app as a second instance, and share its app data.
@{identifier='dev.tabplayer.desktop-test';app=@{windows=@(@{label='main';title='TabPlayer Test';width=1440;height=900;minWidth=960;minHeight=600;additionalBrowserArgs='--remote-debugging-port=9223';dataDirectory=(Join-Path $testDirectory 'webview-profile')})}} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $testConfiguration
$previousTestFlag=$env:VITE_DESKTOP_TEST
try {
    $env:VITE_DESKTOP_TEST='1'
    Push-Location $taskRoot
    npm run tauri -- build --no-bundle --features desktop-test --config $testConfiguration
    if($LASTEXITCODE -ne 0){throw 'Desktop test build failed'}
    $cargo = if (Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe") { "$env:USERPROFILE\.cargo\bin\cargo.exe" } else { "cargo" }
    & $cargo build --release --locked --manifest-path (Join-Path $taskRoot 'src-tauri/Cargo.toml') -p tabplayer-plugin-host -p tabplayer-test-plugin
    if($LASTEXITCODE -ne 0){throw 'Plug-in helper and test plug-in build failed'}
    $destination=Join-Path $testDirectory 'tabplayer.exe'
    foreach($testProcess in @(Get-Process tabplayer -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $destination})){
        Stop-Process -Id $testProcess.Id
        $null=$testProcess.WaitForExit(5000)
    }
    Copy-Item -LiteralPath (Join-Path $taskRoot 'src-tauri/target/release/tabplayer.exe') -Destination $destination
    $helperDestination=Join-Path $testDirectory 'tabplayer-plugin-host.exe'
    foreach($helperProcess in @(Get-Process tabplayer-plugin-host -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $helperDestination})){
        Stop-Process -Id $helperProcess.Id
        $null=$helperProcess.WaitForExit(5000)
    }
    Copy-Item -LiteralPath (Join-Path $taskRoot 'src-tauri/target/release/tabplayer-plugin-host.exe') -Destination $helperDestination
    Copy-Item -LiteralPath (Join-Path $taskRoot 'src-tauri/target/release/tabplayer_test_plugin.dll') -Destination (Join-Path $testDirectory 'tabplayer_test_plugin.dll')
    node scripts/prepare-library.mjs --destination (Join-Path $testDirectory 'library')
    if($LASTEXITCODE -ne 0){throw 'Desktop test Library resources could not be prepared'}
    $testAudio=Join-Path $testDirectory 'audio'
    $preparedAudio=(Resolve-Path (Join-Path $taskRoot 'src-tauri/resources/audio')).Path
    if(-not (Test-Path -LiteralPath $testAudio)){
        New-Item -ItemType Junction -Path $testAudio -Target $preparedAudio | Out-Null
    } elseif ((Get-Item -LiteralPath $testAudio).Target -ne $preparedAudio) {
        throw 'Desktop test audio path must point to this worktree prepared resources'
    }
    $testCabinetIrs=Join-Path $testDirectory 'cabinet-irs'
    $bundledCabinetIrs=(Resolve-Path (Join-Path $taskRoot 'src-tauri/resources/cabinet-irs')).Path
    if(-not (Test-Path -LiteralPath $testCabinetIrs)){
        New-Item -ItemType Junction -Path $testCabinetIrs -Target $bundledCabinetIrs | Out-Null
    } elseif ((Get-Item -LiteralPath $testCabinetIrs).Target -ne $bundledCabinetIrs) {
        throw 'Desktop test cabinet IR path must point to this worktree bundled resources'
    }
} finally {Pop-Location;$env:VITE_DESKTOP_TEST=$previousTestFlag}
