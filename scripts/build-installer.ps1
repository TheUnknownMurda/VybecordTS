# Build VybecordTS.exe + Windows installer (Inno Setup)
# Usage: npm run build:installer

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

Write-Host '=== VybecordTS installer build ===' -ForegroundColor Cyan

Push-Location $Root
try {
  npm run build:exe
  if ($LASTEXITCODE -ne 0) { throw 'build:exe failed' }

  $iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $iscc) {
    Write-Host ''
    Write-Host 'Inno Setup not found.' -ForegroundColor Yellow
    Write-Host 'Install from https://jrsoftware.org/isdl.php then run: npm run build:installer'
    Write-Host 'Or distribute the folder: build\VybecordTS (zip it manually).'
    exit 1
  }

  & $iscc (Join-Path $Root 'installer\VybecordTS.iss')
  if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compile failed' }

  $setup = Join-Path $Root 'build\VybecordTS-Setup-1.0.0.exe'
  Write-Host ''
  Write-Host "Done: $setup" -ForegroundColor Green
  Write-Host 'Users can double-click the Setup.exe like any desktop app.' -ForegroundColor Green
}
finally {
  Pop-Location
}
