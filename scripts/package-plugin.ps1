$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pluginPath = Join-Path $projectRoot 'plugin'
$outputPath = Join-Path $projectRoot 'dist'
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $pluginPath 'manifest.json') | ConvertFrom-Json
$packageName = '{0}_{1}.ccx' -f $manifest.id, $manifest.host.app
$packagePath = Join-Path $outputPath $packageName
$temporaryZip = Join-Path $outputPath ($packageName + '.zip')

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
foreach ($path in @($packagePath, $temporaryZip)) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
    }
}

$files = Get-ChildItem -LiteralPath $pluginPath -File |
    Where-Object { -not $_.Name.StartsWith('.') -and $_.Extension -notin @('.ccx', '.xdx') } |
    Select-Object -ExpandProperty FullName
Compress-Archive -LiteralPath $files -DestinationPath $temporaryZip -CompressionLevel Optimal
Move-Item -LiteralPath $temporaryZip -Destination $packagePath

Write-Output "UXP installer package: $packagePath"
