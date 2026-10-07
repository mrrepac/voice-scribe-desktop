$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$helperPath = Join-Path $projectRoot 'native\bin\VoiceScribe.Native.exe'
if (-not (Test-Path -LiteralPath $helperPath)) { throw 'Build native/build.ps1 first.' }
& $helperPath --diagnostics
if ($LASTEXITCODE -ne 0) { throw 'ABI diagnostics failed.' }
& $helperPath --self-test
if ($LASTEXITCODE -ne 0) { throw 'Shortcut tests failed.' }

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $helperPath
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$null = $process.Start()
$pipeWriter = New-Object System.IO.StreamWriter($process.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding($false)))
$pipeWriter.AutoFlush = $true

function Read-NativeMessage {
    $readTask = $process.StandardOutput.ReadLineAsync()
    if (-not $readTask.Wait(4000)) { throw 'Native response timed out.' }
    if (-not $readTask.Result) { throw 'Native process closed stdout.' }
    return $readTask.Result | ConvertFrom-Json
}
try {
    $ready = Read-NativeMessage
    if ($ready.event -ne 'ready' -or $ready.protocol -ne 1) { throw 'Missing ready event.' }
    $pipeWriter.WriteLine('{"id":1,"command":"get-target"}')
    $target = Read-NativeMessage
    if ($target.id -ne 1 -or -not $target.ok -or $null -eq $target.target) { throw "get-target failed: $($target | ConvertTo-Json -Compress)" }
    $pipeWriter.WriteLine('{"id":2,"command":"set-active","active":false}')
    $active = Read-NativeMessage
    if ($active.id -ne 2 -or -not $active.ok) { throw 'set-active failed.' }
    # 1 is not a valid window; this verifies fallback without sending any keys.
    $pipeWriter.WriteLine('{"id":3,"command":"insert","target":"1","enter":true}')
    $insert = Read-NativeMessage
    if ($insert.id -ne 3 -or $insert.status -ne 'clipboard-only' -or $insert.entered -ne $false) { throw 'Safe insertion fallback failed.' }
    $pipeWriter.WriteLine('{"id":4,"command":"insert","target":"bad","enter":false}')
    $invalid = Read-NativeMessage
    if ($invalid.id -ne 4 -or $invalid.ok -ne $false -or $invalid.error -ne 'invalid-target') { throw 'Invalid-target validation failed.' }
    $pipeWriter.WriteLine('{"id":5,"command":"diagnostics"}')
    $diagnostics = Read-NativeMessage
    if ($diagnostics.id -ne 5 -or -not $diagnostics.inputLayoutValid -or -not $diagnostics.keyboardHookInstalled) { throw 'Live diagnostics failed.' }
    $pipeWriter.WriteLine('{"id":8,"command":"window-info","target":"' + $target.target + '"}')
    $info = Read-NativeMessage
    if ($target.target -ne '0' -and ($info.id -ne 8 -or -not $info.ok -or -not ($info.process -match '\.exe$'))) { throw "window-info failed: $($info | ConvertTo-Json -Compress)" }
    $pipeWriter.WriteLine('{"id":9,"command":"window-info","target":"bad"}')
    $badInfo = Read-NativeMessage
    if ($badInfo.id -ne 9 -or $badInfo.ok -ne $false -or $badInfo.error -ne 'invalid-target') { throw 'window-info validation failed.' }
    $pipeWriter.WriteLine('{"id":7,"command":"cancel-insert"}')
    $cancel = Read-NativeMessage
    if ($cancel.id -ne 7 -or -not $cancel.ok -or $cancel.cancelled -ne $false) { throw 'cancel-insert failed.' }
    $pipeWriter.WriteLine('{"id":6,"command":"quit"}')
    $quit = Read-NativeMessage
    if ($quit.id -ne 6 -or -not $quit.ok) { throw 'quit acknowledgement failed.' }
    if (-not $process.WaitForExit(4000)) { throw 'Helper did not exit.' }
    if ($process.ExitCode -ne 0) { throw 'Helper exited with an error.' }
    Write-Output 'Native smoke: 9 IPC checks passed; no clipboard or key injection performed.'
}
finally {
    if (-not $process.HasExited) { $process.Kill() }
    $pipeWriter.Dispose()
    $process.Dispose()
}
