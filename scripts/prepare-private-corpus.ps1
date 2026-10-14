param([Parameter(Mandatory=$true)][string]$SourceDirectory)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$destination=Join-Path $PSScriptRoot '../.analysis/user-files'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$items=@()
foreach($file in (Get-ChildItem -LiteralPath $SourceDirectory -Recurse -File -Filter '*.gp')) {
    $hash=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $name=$hash+'.gp'
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $destination $name)
    $zip=[System.IO.Compression.ZipFile]::OpenRead($file.FullName)
    try {
        $reader=[System.IO.StreamReader]::new($zip.GetEntry('Content/score.gpif').Open())
        try { $xml=[xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
        $tracks=$xml.SelectNodes('/GPIF/Tracks/Track')
        $tunings=@(foreach($track in $tracks) {
            $property=$track.SelectSingleNode('.//Property[@name="Tuning"]')
            if($track.InstrumentSet.Type -eq 'drumKit') { ,@() }
            elseif($property) { $pitches=@($property.Pitches -split ' ' | Where-Object {$_ -ne ''} | ForEach-Object {[int]$_}); [array]::Reverse($pitches); ,$pitches }
            else { ,@() }
        })
        $meters=@($xml.SelectNodes('/GPIF/MasterBars/MasterBar') | ForEach-Object { $_.Time })
        $items+=@{file=$name;sha256=$hash;source=$file.FullName;trackCount=$tracks.Count;meters=$meters;tunings=$tunings}
    } finally { $zip.Dispose() }
}
ConvertTo-Json -InputObject $items -Depth 8 | Set-Content -LiteralPath (Join-Path $destination 'manifest.json') -Encoding utf8
Write-Output ('Prepared '+$items.Count+' private scores; independent GPIF expectations remain ignored.')
