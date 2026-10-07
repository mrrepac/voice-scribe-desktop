param([string]$OutputPath = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputPath) { $OutputPath = Join-Path $projectRoot 'artifacts\fixture-ru.wav' }
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $voice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'ru' } | Select-Object -First 1
    if (-not $voice) { throw 'No installed Russian Windows speech voice is available.' }
    $speaker.SelectVoice($voice.VoiceInfo.Name)
    $speaker.Rate = 0
    $speaker.SetOutputToWaveFile($OutputPath)
    $speaker.Speak('Сегодня мы обсудим план работы на следующий квартал. Голос становится текстом.')
    $speaker.SetOutputToNull()
    $result = Get-Item -LiteralPath $OutputPath
    if ($result.Length -le 44) { throw 'Speech synthesis did not produce audio samples.' }
    Write-Output "Created $OutputPath ($($result.Length) bytes) using $($voice.VoiceInfo.Name)."
}
finally { $speaker.Dispose() }
