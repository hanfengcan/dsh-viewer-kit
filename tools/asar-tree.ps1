param(
  [string]$Prefix = '',
  [int]$MaxDepth = 3,
  [string]$Filter = '',
  [string]$Root = 'D:\Program Files\DeepSeek Harness\resources\app.asar'
)
$ErrorActionPreference = 'Stop'
$fs = [System.IO.File]::OpenRead($Root)
$br  = New-Object System.IO.BinaryReader($fs)
$null = $br.ReadUInt32(); $headerSize = $br.ReadUInt32(); $null = $br.ReadUInt32(); $jsonSize = $br.ReadUInt32()
$h = ([System.Text.Encoding]::UTF8.GetString($br.ReadBytes($jsonSize))) | ConvertFrom-Json
$br.Close(); $fs.Close()

function Walk($files, [string]$path, [int]$d) {
  if ($d -gt $MaxDepth) { return }
  foreach ($p in $files.PSObject.Properties) {
    $c = $p.Value
    $full = if ($path) { "$path/$($p.Name)" } else { $p.Name }
    if ($null -ne $c.files) {
      if (-not $Filter -or $full -match $Filter) { Write-Output ("$full/") }
      Walk $c.files $full ($d + 1)
    } else {
      if (-not $Filter -or $full -match $Filter) { Write-Output ("$full  ($($c.size))") }
    }
  }
}

if ($Prefix) {
  $n = $h.files
  foreach ($s in ($Prefix -split '/')) { $n = $n.$s }
  Walk $n.files $Prefix 0
} else {
  Walk $h.files '' 0
}
