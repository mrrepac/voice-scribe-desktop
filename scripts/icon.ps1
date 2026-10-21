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

# The same microphone, drawn on a 256-unit grid into any bitmap.
function Draw-Mic($graphics, $color, [double]$scale, [double]$x, [double]$y) {
  $graphics.ResetTransform()
  $graphics.TranslateTransform($x, $y)
  $graphics.ScaleTransform($scale, $scale)
  $micBrush = New-Object System.Drawing.SolidBrush $color
  $micPen = New-Object System.Drawing.Pen $micBrush,14
  $micPen.StartCap = 'Round'; $micPen.EndCap = 'Round'
  $graphics.FillEllipse($micBrush,101,43,54,54)
  $graphics.FillRectangle($micBrush,101,70,54,67)
  $graphics.FillEllipse($micBrush,101,109,54,54)
  $graphics.DrawArc($micPen,76,77,104,112,0,180)
  $graphics.DrawLine($micPen,128,190,128,214)
  $graphics.DrawLine($micPen,102,214,154,214)
  $micPen.Dispose(); $micBrush.Dispose()
}

# macOS: a rounded square on Apple's 1024 grid (824 body, 100 margin).
$mac = New-Object System.Drawing.Bitmap 1024,1024
$g = [System.Drawing.Graphics]::FromImage($mac)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
$body = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 370
$body.AddArc(100,100,$r,$r,180,90); $body.AddArc(924-$r,100,$r,$r,270,90)
$body.AddArc(924-$r,924-$r,$r,$r,0,90); $body.AddArc(100,924-$r,$r,$r,90,90); $body.CloseFigure()
$fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(48,48,48))
$g.FillPath($fill,$body)
Draw-Mic $g ([System.Drawing.Color]::FromArgb(248,248,248)) (824/256) 100 100
$mac.Save((Join-Path $dir 'icon-mac.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $fill.Dispose(); $body.Dispose(); $mac.Dispose()

# macOS menu bar: a black template image that the system recolors.
foreach ($size in 18,36) {
  $tray = New-Object System.Drawing.Bitmap $size,$size
  $g = [System.Drawing.Graphics]::FromImage($tray)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $scale = ($size - 2) / 190
  Draw-Mic $g ([System.Drawing.Color]::Black) $scale ($size/2 - 128*$scale) ($size/2 - 129*$scale)
  $name = if ($size -eq 18) { 'trayTemplate.png' } else { 'trayTemplate@2x.png' }
  $tray.Save((Join-Path $dir $name),[System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $tray.Dispose()
}
