# Builds shoptill.zip from plugin/shoptill, the way WordPress needs it:
# forward-slash entry names (the zip spec) and directory entries.
#
# Do not use ZipFile.CreateFromDirectory on Windows PowerShell 5.1 for this:
# .NET Framework writes the OS separator into entry names, Windows tools
# tolerate it, and WordPress's PclZip refuses the archive on upload.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File dev\zip.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'plugin\shoptill'
$out = Join-Path $root 'shoptill.zip'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-Rel([string]$path) {
  return 'shoptill' + $path.Substring($src.Length).Replace('\', '/')
}

Remove-Item $out -Force -ErrorAction SilentlyContinue
$fs = [System.IO.File]::Open($out, [System.IO.FileMode]::CreateNew)
$zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  # Directory entries first, so the archive matches what the shop has uploaded before.
  foreach ($dir in (Get-ChildItem $src -Recurse -Directory | Sort-Object FullName)) {
    $entry = $zip.CreateEntry((Get-Rel $dir.FullName) + '/')
    $entry.LastWriteTime = New-Object System.DateTimeOffset($dir.LastWriteTime)
  }

  foreach ($file in (Get-ChildItem $src -Recurse -File | Sort-Object FullName)) {
    $entry = $zip.CreateEntry((Get-Rel $file.FullName), [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = New-Object System.DateTimeOffset($file.LastWriteTime)
    $es = $entry.Open()
    $in = [System.IO.File]::OpenRead($file.FullName)
    try { $in.CopyTo($es) } finally { $in.Dispose(); $es.Dispose() }
  }
} finally {
  $zip.Dispose()
  $fs.Dispose()
}

# Fail the build if any entry name carries the OS separator: that archive would upload badly.
$check = [System.IO.Compression.ZipFile]::OpenRead($out)
try {
  $bad = @($check.Entries | Where-Object { $_.FullName -match '[\\/]' -and $_.FullName -match '\\' })
  if ($bad.Count) { throw "$($bad.Count) entries have backslash names" }
  Write-Output "shoptill.zip: $($check.Entries.Count) entries, forward-slash names, $((Get-Item $out).Length) bytes"
} finally {
  $check.Dispose()
}
