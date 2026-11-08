param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'dist' }
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($outputPath)
$manifest = [IO.File]::ReadAllText((Join-Path $repoRoot 'qishui-account/plugin.json')) | ConvertFrom-Json
$files = @(git -C $repoRoot ls-files -- qishui-account)
if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { throw 'Cannot list tracked plugin files.' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = Join-Path $outputPath 'plugin-windows-amd64.zip'
$stream = [IO.File]::Open($archivePath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
$zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in $files) {
        if (-not $file.StartsWith('qishui-account/') -or $file.Contains('..')) { throw 'Unexpected plugin path.' }
        $entry = $file.Substring('qishui-account/'.Length)
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $repoRoot $file), $entry, [IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $zip.Dispose(); $stream.Dispose() }
$check = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if (-not $check.GetEntry('plugin.json') -or -not $check.GetEntry($manifest.main)) { throw 'Missing plugin entry at archive root.' }
    if ($check.Entries.Count -ne $files.Count) { throw 'Archive file count mismatch.' }
} finally { $check.Dispose() }
$digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $outputPath 'SHA256SUMS'), "$digest  plugin-windows-amd64.zip`n", [Text.UTF8Encoding]::new($false))
[PSCustomObject]@{Version=$manifest.version; Files=$files.Count; Archive=$archivePath; SHA256=$digest} | ConvertTo-Json -Compress
