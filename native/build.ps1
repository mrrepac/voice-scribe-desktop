param([switch]$Test)
$ErrorActionPreference = 'Stop'
$nativeRoot = $PSScriptRoot
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path -LiteralPath (Join-Path $frameworkRoot 'csc.exe'))) {
    $frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
}
$compiler = Join-Path $frameworkRoot 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw '.NET Framework 4.x compiler was not found. Enable .NET Framework 4.8 on Windows.'
}
$outputDirectory = Join-Path $nativeRoot 'bin'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$helperPath = Join-Path $outputDirectory 'VoiceScribe.Native.exe'
$sourcePath = Join-Path $nativeRoot 'VoiceScribe.Native.cs'
$serializerAssembly = Join-Path $frameworkRoot 'System.Web.Extensions.dll'
& $compiler /nologo /target:exe /platform:anycpu /optimize+ /warn:4 "/reference:$serializerAssembly" "/out:$helperPath" $sourcePath
if ($LASTEXITCODE -ne 0) { throw "Native helper compilation failed ($LASTEXITCODE)." }
Write-Output "Built $helperPath"
if ($Test) {
    & $helperPath --diagnostics
    if ($LASTEXITCODE -ne 0) { throw 'Native helper ABI diagnostics failed.' }
    & $helperPath --self-test
    if ($LASTEXITCODE -ne 0) { throw 'Native helper shortcut tests failed.' }
}
