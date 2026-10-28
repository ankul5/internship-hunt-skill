<#
.SYNOPSIS
  Prepare a local checkout: expose skills to each harness and create the private data folder.
.DESCRIPTION
  Links (junctions) each folder in skills\ into .claude\skills and .agents\skills.
  Falls back to copying if a link cannot be created. Creates the private data
  folder from templates\data without overwriting existing files.
.PARAMETER Copy
  Copy skills instead of linking them.
.PARAMETER DataDir
  Private data location. Default: $env:INTERNSHIP_AGENT_HOME, else <repo>\private.
#>
param([switch]$Copy, [string]$DataDir)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$skills = Join-Path $root 'skills'

foreach ($rel in '.claude\skills', '.agents\skills') {
  $destDir = Join-Path $root $rel
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  foreach ($s in Get-ChildItem -Path $skills -Directory) {
    $dest = Join-Path $destDir $s.Name
    if (Test-Path -LiteralPath $dest) {
      $item = Get-Item -LiteralPath $dest -Force
      if ($item.LinkType) { $item.Delete() } else { Remove-Item -LiteralPath $dest -Recurse -Force }
    }
    if ($Copy) { Copy-Item -LiteralPath $s.FullName -Destination $dest -Recurse; continue }
    try { New-Item -ItemType Junction -Path $dest -Target $s.FullName | Out-Null }
    catch { Write-Warning "Link failed for $dest; copying instead."; Copy-Item -LiteralPath $s.FullName -Destination $dest -Recurse }
  }
  Write-Host "skills -> $rel"
}

if ($DataDir) { $data = $DataDir }
elseif ($env:INTERNSHIP_AGENT_HOME) { $data = $env:INTERNSHIP_AGENT_HOME }
else { $data = Join-Path $root 'private' }
foreach ($sub in '', 'resumes', 'tailored', 'drafts', 'email-exports', 'backups') {
  New-Item -ItemType Directory -Force -Path (Join-Path $data $sub) | Out-Null
}
foreach ($f in Get-ChildItem -Path (Join-Path $root 'templates\data') -File) {
  $target = Join-Path $data $f.Name
  if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath $f.FullName -Destination $target }
}
Write-Host "private data -> $data"
if ($data -notlike "$root*") { Write-Host "Set INTERNSHIP_AGENT_HOME=$data so the skills can find it." }
