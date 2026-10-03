param(
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$OutDir = "$env:TEMP\asar-out",
  [string]$Root = 'D:\Program Files\DeepSeek Harness\resources\app.asar'
)

$ErrorActionPreference = 'Stop'
$fs = [System.IO.File]::OpenRead($Root)
$br  = New-Object System.IO.BinaryReader($fs)
$null       = $br.ReadUInt32()   # [0]  4
$headerSize = $br.ReadUInt32()   # [1]  pickle payload size
$null       = $br.ReadUInt32()   # [2]  payload: uint32 + string
$jsonSize   = $br.ReadUInt32()   # [3]  actual JSON byte length
$header = [System.Text.Encoding]::UTF8.GetString($br.ReadBytes($jsonSize)) | ConvertFrom-Json
$dataOffset = 8 + $headerSize

function Resolve-Entry([string]$p) {
  $node = $null
  foreach ($seg in ($p -split '/')) {
    if ($null -eq $node) { $node = $header.files.$seg }
    else                { $node = $node.files.$seg }
  }
  return $node
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$dest = Join-Path $OutDir ($Path -replace '/', '\')
$dir  = Split-Path $dest -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$entry = Resolve-Entry $Path
if (-not $entry) { $br.Close(); $fs.Close(); throw "not found in asar: $Path" }

$fs.Position = $dataOffset + [int64]$entry.offset
[System.IO.File]::WriteAllBytes($dest, $br.ReadBytes([int]$entry.size))
$br.Close(); $fs.Close()
Write-Output ("{0}  ({1} bytes)" -f $dest, $entry.size)
