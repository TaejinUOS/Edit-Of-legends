$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pluginPath = Join-Path $projectRoot 'plugin'
$outputPath = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$archivePath = Join-Path $outputPath 'EditOfLegends-0.1.0-source.zip'
if (Test-Path -LiteralPath $archivePath) {
    $archivePath = Join-Path $outputPath ('EditOfLegends-0.1.0-source-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip')
}
Compress-Archive -Path (Join-Path $pluginPath '*') -DestinationPath $archivePath
Write-Output "UXP Developer Tool source package: $archivePath"
Write-Output 'Load plugin/manifest.json in Adobe UXP Developer Tool. This ZIP is not a signed CCX installer.'
