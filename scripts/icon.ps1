Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'assets'
[System.IO.Directory]::CreateDirectory($dir) | Out-Null
$bmp = New-Object System.Drawing.Bitmap 256,256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::FromArgb(48,48,48))
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(248,248,248))
$pen = New-Object System.Drawing.Pen $brush,14
$pen.StartCap = 'Round'; $pen.EndCap = 'Round'
$g.FillEllipse($brush,101,43,54,54)
$g.FillRectangle($brush,101,70,54,67)
$g.FillEllipse($brush,101,109,54,54)
$g.DrawArc($pen,76,77,104,112,0,180)
$g.DrawLine($pen,128,190,128,214)
$g.DrawLine($pen,102,214,154,214)
$png = Join-Path $dir 'icon.png'
$bmp.Save($png,[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $pen.Dispose(); $brush.Dispose(); $bmp.Dispose()
$bytes = [System.IO.File]::ReadAllBytes($png)
$stream = [System.IO.File]::Create((Join-Path $dir 'icon.ico'))
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$bytes.Length); $writer.Write([UInt32]22)
$writer.Write($bytes); $writer.Dispose()
