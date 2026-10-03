param(
  [string]$Filter = '',
  [string]$Root = 'D:\Program Files\DeepSeek Harness\resources\app.asar'
)
$ErrorActionPreference = 'Stop'
$fs = [System.IO.File]::OpenRead($Root)
$br  = New-Object System.IO.BinaryReader($fs)
$null = $br.ReadUInt32(); $null = $br.ReadUInt32(); $null = $br.ReadUInt32(); $jsonSize = $br.ReadUInt32()
$h = ([System.Text.Encoding]::UTF8.GetString($br.ReadBytes($jsonSize))) | ConvertFrom-Json
$br.Close(); $fs.Close()

$out = New-Object System.Collections.Generic.List[string]
function Walk($files, [string]$path) {
  foreach ($p in $files.PSObject.Properties) {
    $c = $p.Value
    $full = if ($path) { "$path/$($p.Name)" } else { $p.Name }
    if ($null -ne $c.files) { Walk $c.files $full } else { $out.Add($full) }
  }
}
Walk $h.files ''
if ($Filter) { $out | Where-Object { $_ -match $Filter } } else { $out }
