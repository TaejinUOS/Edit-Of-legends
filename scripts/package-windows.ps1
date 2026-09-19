param(
    [string]$InnoCompiler = '',
    [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$distPath = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
$stagingPath = [IO.Path]::GetFullPath((Join-Path $distPath 'windows-staging'))
$packageMetadata = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$packageVersion = $packageMetadata.version
$stagingPrefix = $distPath.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $stagingPath.StartsWith($stagingPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe staging path: $stagingPath"
}

if (Test-Path -LiteralPath $stagingPath) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
}
$appPath = New-Item -ItemType Directory -Path (Join-Path $stagingPath 'app') -Force
$runtimePath = New-Item -ItemType Directory -Path (Join-Path $stagingPath 'runtime') -Force
$licensesPath = New-Item -ItemType Directory -Path (Join-Path $stagingPath 'licenses') -Force

Copy-Item -LiteralPath (Join-Path $projectRoot 'engine') -Destination $appPath -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $appPath
Copy-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Destination $appPath

& npm.cmd ci --omit=dev --prefix $appPath
if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }

# ffprobe-static ships every platform. Keep only the Windows x64 binary used by this installer.
$unusedFfprobePaths = @(
    (Join-Path $appPath 'node_modules\ffprobe-static\bin\darwin'),
    (Join-Path $appPath 'node_modules\ffprobe-static\bin\linux'),
    (Join-Path $appPath 'node_modules\ffprobe-static\bin\win32\ia32')
)
foreach ($unusedPath in $unusedFfprobePaths) {
    $resolvedUnusedPath = [IO.Path]::GetFullPath($unusedPath)
    if (-not $resolvedUnusedPath.StartsWith($stagingPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe dependency cleanup path: $resolvedUnusedPath"
    }
    if (Test-Path -LiteralPath $resolvedUnusedPath) {
        Remove-Item -LiteralPath $resolvedUnusedPath -Recurse -Force
    }
}

$nodeCommand = Get-Command node -ErrorAction Stop
Copy-Item -LiteralPath $nodeCommand.Source -Destination (Join-Path $runtimePath 'node.exe')
$nodeVersion = (& node -p 'process.version').Trim()
$nodeLicenseUrl = "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE"
Invoke-WebRequest -UseBasicParsing -Uri $nodeLicenseUrl -OutFile (Join-Path $licensesPath 'Node.js-LICENSE.txt')

$ffmpegPackage = Join-Path $appPath 'node_modules\ffmpeg-static'
$ffprobePackage = Join-Path $appPath 'node_modules\ffprobe-static'
Copy-Item -LiteralPath (Join-Path $ffmpegPackage 'LICENSE') -Destination (Join-Path $licensesPath 'ffmpeg-static-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $ffprobePackage 'LICENSE') -Destination (Join-Path $licensesPath 'ffprobe-static-LICENSE.txt')
@'
EditOfLegends bundles Node.js and separate FFmpeg/ffprobe executables.

Node.js: https://nodejs.org/
FFmpeg project and source: https://ffmpeg.org/
ffmpeg-static binary package: https://www.npmjs.com/package/ffmpeg-static
ffprobe-static binary package: https://www.npmjs.com/package/ffprobe-static

The corresponding license texts are installed beside this notice. FFmpeg and
ffprobe remain separate executables invoked by the EditOfLegends engine.
'@ | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $licensesPath 'THIRD-PARTY-NOTICES.txt')

$launcherSource = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot 'companion\windows\EditOfLegendsLauncher.cs')
$launcherPath = Join-Path $stagingPath 'EditOfLegendsLauncher.exe'
Add-Type -TypeDefinition $launcherSource -OutputAssembly $launcherPath -OutputType WindowsApplication

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'package-plugin.ps1')
if ($LASTEXITCODE -ne 0) { throw 'UXP package creation failed.' }

if ($SkipInstaller) {
    Write-Output "Windows staging package: $stagingPath"
    exit 0
}

if (-not $InnoCompiler) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )
    $InnoCompiler = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}
if (-not $InnoCompiler -or -not (Test-Path -LiteralPath $InnoCompiler)) {
    throw 'Inno Setup 6 is required. Install it or pass -InnoCompiler.'
}

& $InnoCompiler "/DAppVersion=$packageVersion" (Join-Path $projectRoot 'companion\windows\installer.iss')
if ($LASTEXITCODE -ne 0) { throw 'Windows installer creation failed.' }

$releaseFiles = @(
    (Join-Path $distPath "EditOfLegends-Engine-Setup-$packageVersion-win-x64.exe"),
    (Join-Path $distPath 'com.taejinuos.editoflegends_premierepro.ccx')
)
$checksumLines = foreach ($releaseFile in $releaseFiles) {
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $releaseFile
    '{0} *{1}' -f $hash.Hash, (Split-Path -Leaf $releaseFile)
}
$checksumLines | Set-Content -Encoding ASCII -LiteralPath (Join-Path $distPath 'SHA256SUMS.txt')

Write-Output "Windows installer written to: $distPath"
