param([string]$OutputDirectory = '', [string]$NativeDirectory = '')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'dist' }
if (-not $NativeDirectory) { $NativeDirectory = Join-Path $repoRoot 'dist/login-helper' }
# Go's ZIP writer preserves Unix executable bits even when packaging on Windows.
& go -C (Join-Path $repoRoot 'login-helper') run ./cmd/package -root $repoRoot -native $NativeDirectory -out $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Plugin packaging failed. Run node scripts/build-login-helper.mjs first.' }
