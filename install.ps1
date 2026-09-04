#requires -Version 5.1
<#
.SYNOPSIS
  One-line installer for omp-antigravity-pro.
  Works seamlessly on Windows without requiring Bun beforehand.

.DESCRIPTION
  Installs or updates the omp-antigravity-pro extension for Oh My Pi (OMP).
  - If Bun is installed, uses OMP's native plugin installer.
  - If Bun is missing but Node.js / npm is available, installs directly into OMP's
    plugins directory via npm, eliminating "bun is not recognized" errors.
  - If neither is present, automatically bootstraps Bun and completes the install.

.EXAMPLE
  irm https://raw.githubusercontent.com/ART1KZ/omp-antigravity-pro/main/install.ps1 | iex
#>

$ErrorActionPreference = 'Stop'

function Write-Info([string]$Message) {
    Write-Host "[omp-antigravity-pro] $Message" -ForegroundColor Cyan
}

function Write-Success([string]$Message) {
    Write-Host "[omp-antigravity-pro] $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "[omp-antigravity-pro] WARNING: $Message" -ForegroundColor Yellow
}

function Write-Err([string]$Message) {
    Write-Host "[omp-antigravity-pro] ERROR: $Message" -ForegroundColor Red
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "         Oh My Pi Antigravity Pro - One-Line Installer          " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Resolve OMP directories
$OmpDir = Join-Path $HOME ".omp"
$PluginsDir = Join-Path $OmpDir "plugins"

if (-not (Test-Path $PluginsDir)) {
    Write-Info "Creating OMP plugins directory at '$PluginsDir'..."
    New-Item -ItemType Directory -Path $PluginsDir -Force | Out-Null
}

$PkgJsonPath = Join-Path $PluginsDir "package.json"
if (-not (Test-Path $PkgJsonPath)) {
    $initialPkg = @{
        name = "omp-plugins"
        private = $true
        dependencies = @{}
    }
    $initialPkg | ConvertTo-Json | Set-Content -Path $PkgJsonPath -Encoding UTF8
}

# 2. Determine installation strategy
$HasBun = [bool](Get-Command bun -ErrorAction SilentlyContinue)
$HasNpm = [bool](Get-Command npm -ErrorAction SilentlyContinue)
$HasOmp = [bool](Get-Command omp -ErrorAction SilentlyContinue)
$InstallSuccess = $false

if ($HasBun -and $HasOmp) {
    Write-Info "Bun detected. Installing via 'omp plugin install'..."
    try {
        $null | & omp plugin install github:ART1KZ/omp-antigravity-pro --force
        if ($LASTEXITCODE -eq 0) {
            $InstallSuccess = $true
        }
    } catch {
        Write-Warn "Native OMP installer encountered an issue, falling back to direct npm install..."
    }
}

if (-not $InstallSuccess -and $HasNpm) {
    Write-Info "Using npm to install directly into '$PluginsDir' (no Bun required)..."
    try {
        $null | & npm.cmd --prefix "$PluginsDir" install github:ART1KZ/omp-antigravity-pro --no-fund --no-audit
        if ($LASTEXITCODE -eq 0) {
            $InstallSuccess = $true
        } else {
            throw "npm install exited with code $LASTEXITCODE"
        }
    } catch {
        Write-Warn "npm install from GitHub failed: $_"
    }
}

if (-not $InstallSuccess -and (-not $HasBun) -and (-not $HasNpm)) {
    Write-Info "Neither Bun nor npm detected. Bootstrapping Bun automatically..."
    try {
        Invoke-Expression (Invoke-RestMethod -Uri "https://bun.sh/install.ps1")
        $BunBin = Join-Path $HOME ".bun\bin"
        if (Test-Path $BunBin) {
            $env:PATH = "$BunBin;$env:PATH"
            $env:Path = "$BunBin;$env:Path"
        }
        if (Get-Command bun -ErrorAction SilentlyContinue) {
            Write-Info "Bun successfully installed. Running plugin installation..."
            if ($HasOmp) {
                & omp plugin install github:ART1KZ/omp-antigravity-pro --force
            } else {
                $null | & bun install --cwd "$PluginsDir" github:ART1KZ/omp-antigravity-pro
            }
            if ($LASTEXITCODE -eq 0) {
                $InstallSuccess = $true
            }
        }
    } catch {
        Write-Err "Automatic Bun bootstrap failed: $_"
    }
}

# 3. Verify installation
$PluginInstalledPath = Join-Path (Join-Path $PluginsDir "node_modules") "omp-antigravity-pro"
$IsInstalled = (Test-Path $PluginInstalledPath) -or $InstallSuccess

if ($IsInstalled) {
    # 4. Configure inlineToolDescriptors to prevent subagent crashes on Gemini models (OMP 18.1.10+)
    if ($HasOmp) {
        try {
            & omp config set inlineToolDescriptors off | Out-Null
            Write-Info "Configured inlineToolDescriptors = off (prevents OMP subagent crashes on Gemini)"
        } catch {
            # Non-fatal if config set fails
        }
    }
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host " [OK] omp-antigravity-pro successfully installed and ready!     " -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Usage guide:" -ForegroundColor White
    Write-Host "  1. Verify installed models:" -ForegroundColor Gray
    Write-Host "     omp models google-antigravity" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  2. Run any model with thinking budget (e.g. Gemini, Claude):" -ForegroundColor Gray
    Write-Host "     omp --model google-antigravity/gemini-3-flash --thinking high" -ForegroundColor Yellow
    Write-Host "     omp --model google-antigravity/claude-sonnet-4-6 --thinking high" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  3. Log in or switch accounts anytime:" -ForegroundColor Gray
    Write-Host "     omp /login  (select Google Antigravity)" -ForegroundColor Yellow
    Write-Host ""
    [Console]::ResetColor()
    return
} else {
    Write-Err "Installation could not be completed automatically."
    Write-Host "Try running manually in your terminal:" -ForegroundColor Yellow
    Write-Host "  npm --prefix `"$PluginsDir`" install github:ART1KZ/omp-antigravity-pro" -ForegroundColor White
    exit 1
}
