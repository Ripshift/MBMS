# Copies HMBC.jar (the Bedrock Console Bridge) into the app's assets, with its SHA256 next to it.
# BABS copies it into files/bridge/ on first start, and again whenever the SHA256 changes.
#
#   powershell -ExecutionPolicy Bypass -File scripts\fetch-bridge.ps1 [-Jar path\to\HMBC.jar]
#
# By default it takes the jar built in ..\HMBS (.\gradlew.bat :bootstrap-standalone:build -x test there).

param(
    [string]$Jar = (Join-Path $PSScriptRoot "..\..\HMBS\bootstrap\standalone\build\libs\HMBC.jar")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Jar)) {
    throw "HMBC.jar not found at $Jar. Build it in HMBS first, or pass -Jar."
}

$dest = Join-Path $PSScriptRoot "..\app\src\main\assets\bridge"
New-Item -ItemType Directory -Force $dest | Out-Null

Copy-Item -LiteralPath $Jar -Destination (Join-Path $dest "HMBC.jar") -Force
$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $dest "HMBC.jar")).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $dest "HMBC.sha256"), "$sha`n")

$size = [math]::Round((Get-Item -LiteralPath (Join-Path $dest "HMBC.jar")).Length / 1MB, 1)
Write-Host "Copied HMBC.jar ($size MB, sha256 $sha) into app\src\main\assets\bridge"
