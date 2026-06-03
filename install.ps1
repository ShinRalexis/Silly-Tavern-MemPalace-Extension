# ============================================================
# MemPalace - Installer / Updater
# https://github.com/ShinRalexis/Silly-Tavern-MemPalace-Extension
# ============================================================
# Usage:
#   First install : .\install.ps1
#   Update        : .\install.ps1 -Update
#   Reconfigure   : .\install.ps1 -Configure
# ============================================================

param(
    [switch]$Update,
    [switch]$Configure
)

$ErrorActionPreference = "Stop"
$ConfigFile      = Join-Path $PSScriptRoot "paths.local.json"
$ExtensionSource = Join-Path $PSScriptRoot "extension"
$ServerSource    = Join-Path $PSScriptRoot "server"

# ── UI helpers ───────────────────────────────────────────────
function Write-OK   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-WARN { param($m) Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Write-ERR  { param($m) Write-Host "  [XX] $m" -ForegroundColor Red }
function Write-INFO { param($m) Write-Host "  [..] $m" -ForegroundColor Gray }
function Write-Step { param($m) Write-Host "" ; Write-Host "  >>> $m" -ForegroundColor Cyan }

Write-Host ""
Write-Host "  MemPalace - Installer v3.10.0" -ForegroundColor Cyan
Write-Host "  https://github.com/ShinRalexis/Silly-Tavern-MemPalace-Extension" -ForegroundColor DarkGray
Write-Host ""

# ── Config ───────────────────────────────────────────────────
function Load-Config {
    if (Test-Path $ConfigFile) {
        try {
            return Get-Content $ConfigFile -Raw | ConvertFrom-Json
        } catch {
            Write-WARN "Config file corrupted, will recreate."
        }
    }
    return $null
}

function Save-Config {
    param($STPath, $ServerPath, $ServerMode)
    $obj = [PSCustomObject]@{
        st_extensions_path = $STPath
        server_path        = $ServerPath
        server_mode        = $ServerMode
        configured_at      = (Get-Date -Format "yyyy-MM-dd HH:mm")
    }
    $obj | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8
    Write-OK "Configuration saved to paths.local.json"
}

# ── Auto-detect SillyTavern ──────────────────────────────────
function Find-SillyTavern {
    $candidates = @(
        "$env:USERPROFILE\SillyTavern",
        "$env:USERPROFILE\Documents\SillyTavern",
        "C:\SillyTavern",
        "D:\SillyTavern",
        "D:\AI\Silly Tavern",
        "C:\AI\SillyTavern",
        "C:\AI\Silly Tavern"
    )
    foreach ($p in $candidates) {
        if (Test-Path (Join-Path $p "public\scripts\extensions")) {
            return $p
        }
    }
    return $null
}

# ── Ask for paths ────────────────────────────────────────────
function Ask-STPath {
    $detected = Find-SillyTavern
    if ($detected) {
        Write-INFO "SillyTavern detected at: $detected"
        $ans = Read-Host "  Use this path? [Enter=Yes / type alternative path]"
        if ($ans -eq "") { return $detected }
        return $ans.Trim('"')
    }
    Write-WARN "SillyTavern not detected automatically."
    $p = Read-Host "  SillyTavern path (e.g. D:\AI\Silly Tavern)"
    return $p.Trim('"')
}

function Ask-ServerPath {
    Write-Host ""

    # Check if mempalace container already exists
    $hasDocker = $null
    try { $hasDocker = Get-Command docker -ErrorAction SilentlyContinue } catch {}

    if ($hasDocker) {
        $dockerOut = docker ps -a --filter "name=mempalace" 2>$null
        if ($dockerOut -match "mempalace") {
            Write-OK "Docker container 'mempalace' found - MemPalace already installed."
            Write-INFO "The script will update the server files and restart the container."
            Write-INFO "Server files path (leave empty to use this repo's server/ folder):"
            $p = Read-Host "  Existing server path"
            $p = $p.Trim('"')
            if ($p -eq "") { return $ServerSource }
            return $p
        }
    }

    Write-INFO "Where should the MemPalace server be installed?"
    Write-INFO "Leave empty to run directly from this repo's server/ folder."
    $p = Read-Host "  Server path"
    $p = $p.Trim('"')
    if ($p -eq "") { return $ServerSource }
    return $p
}

function Ask-ServerMode {
    Write-Host ""
    Write-Host "  Server mode:" -ForegroundColor White
    Write-Host "  [1] Docker (recommended)" -ForegroundColor Gray
    Write-Host "  [2] Python direct" -ForegroundColor Gray
    $choice = Read-Host "  Choose [1/2]"
    if ($choice -eq "2") { return "python" }
    return "docker"
}

# ── Install ST extension ─────────────────────────────────────
function Install-Extension {
    param($STPath)
    Write-Step "Installing SillyTavern extension"

    $extFolder = Join-Path $STPath "public\scripts\extensions"
    $dest      = Join-Path $extFolder "MemPlace"

    if (-not (Test-Path $extFolder)) {
        Write-ERR "Extensions folder not found at: $STPath"
        Write-ERR "Make sure the SillyTavern path is correct."
        return $false
    }

    if (-not (Test-Path $dest)) {
        New-Item -ItemType Directory -Path $dest | Out-Null
    }

    Copy-Item "$ExtensionSource\*" $dest -Recurse -Force
    Write-OK "Extension installed at: $dest"
    return $true
}

# ── Install / start server ───────────────────────────────────
function Install-Server {
    param($ServerPath, $ServerMode)
    Write-Step "Setting up MemPalace server"

    if ($ServerPath -ne $ServerSource) {
        if (-not (Test-Path $ServerPath)) {
            New-Item -ItemType Directory -Path $ServerPath -Force | Out-Null
        }
        Copy-Item "$ServerSource\*" $ServerPath -Recurse -Force
        Write-OK "Server files copied to: $ServerPath"
    } else {
        Write-OK "Server will run from: $ServerPath"
    }

    if ($ServerMode -eq "docker") {
        Start-DockerServer -ServerPath $ServerPath
    } else {
        Start-PythonServer -ServerPath $ServerPath
    }
}

function Start-DockerServer {
    param($ServerPath)

    $hasDocker = $null
    try { $hasDocker = Get-Command docker -ErrorAction SilentlyContinue } catch {}
    if (-not $hasDocker) {
        Write-WARN "Docker not found. Install Docker Desktop and re-run."
        Write-INFO "https://www.docker.com/products/docker-desktop"
        return
    }

    # Check if container already exists
    $dockerOut = docker ps -a --filter "name=mempalace" 2>$null
    if ($dockerOut -match "mempalace") {
        Write-INFO "Container 'mempalace' already present - updating files and restarting."
        if ($ServerPath -ne $ServerSource) {
            Copy-Item "$ServerSource\*.py"           $ServerPath -Force
            Copy-Item "$ServerSource\requirements.txt" $ServerPath -Force
            Write-OK "Server files updated at: $ServerPath"
        }
        docker restart mempalace 2>$null | Out-Null
        Write-OK "Server restarted on http://localhost:8052"
    } else {
        # First install - create memories folder and .env
        $memoriesRoot   = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "MemPalaceMemories"
        $memoriesData   = Join-Path $memoriesRoot "data"
        $memoriesConfig = Join-Path $memoriesRoot "config"

        New-Item -ItemType Directory -Path $memoriesData   -Force | Out-Null
        New-Item -ItemType Directory -Path $memoriesConfig -Force | Out-Null
        Write-OK "Memories folder created: $memoriesRoot"

        # Write .env for docker-compose (gitignored)
        $dataFwd   = $memoriesData.Replace('\', '/')
        $configFwd = $memoriesConfig.Replace('\', '/')
        $envContent = "MEMPALACE_DATA_PATH=$dataFwd`nMEMPALACE_CONFIG_PATH=$configFwd"
        Set-Content -Path (Join-Path $ServerPath ".env") -Value $envContent -Encoding UTF8
        Write-OK ".env configured with local paths"

        Write-INFO "Starting Docker container (first install)..."
        Push-Location $ServerPath
        try {
            docker compose up -d --build
            Write-OK "Server running on http://localhost:8052"
            Write-OK "Memories saved at: $memoriesRoot"
        } catch {
            Write-ERR "Docker error: $_"
        } finally {
            Pop-Location
        }
    }
}

function Start-PythonServer {
    param($ServerPath)

    $hasPython = $null
    try { $hasPython = Get-Command python -ErrorAction SilentlyContinue } catch {}
    if (-not $hasPython) {
        Write-WARN "Python not found. Install Python 3.11+ and re-run."
        return
    }

    Write-INFO "Installing Python dependencies..."
    Push-Location $ServerPath
    try {
        python -m pip install -r requirements.txt -q
        Write-OK "Dependencies installed."
        Write-WARN "Start the server manually with:"
        Write-Host "  cd `"$ServerPath`""  -ForegroundColor White
        Write-Host "  python bridge.py"    -ForegroundColor White
    } catch {
        Write-ERR "pip error: $_"
    } finally {
        Pop-Location
    }
}

# ── Update ───────────────────────────────────────────────────
function Update-All {
    param($Config)
    Write-Step "Updating MemPalace"

    # git pull
    if (Test-Path (Join-Path $PSScriptRoot ".git")) {
        Write-INFO "Running git pull..."
        Push-Location $PSScriptRoot
        git pull
        Pop-Location
    } else {
        Write-WARN "Not a git repo - skipping git pull."
    }

    # Update extension in ST
    $dest = Join-Path $Config.st_extensions_path "public\scripts\extensions\MemPlace"
    if (Test-Path $dest) {
        Copy-Item "$ExtensionSource\*" $dest -Recurse -Force
        Write-OK "ST extension updated."
    } else {
        Write-WARN "Extension folder not found, reinstalling..."
        Install-Extension -STPath $Config.st_extensions_path | Out-Null
    }

    # Update server files (if server is in a different location)
    $srvPath = $Config.server_path
    if ($srvPath -and ($srvPath -ne $ServerSource) -and (Test-Path $srvPath)) {
        Copy-Item "$ServerSource\*.py"            $srvPath -Force
        Copy-Item "$ServerSource\requirements.txt" $srvPath -Force
        Copy-Item "$ServerSource\docker-compose.yml" $srvPath -Force
        Write-OK "Server files updated at: $srvPath"
    }

    # Restart server
    if ($Config.server_mode -eq "docker") {
        $dockerOut = docker ps --filter "name=mempalace" 2>$null
        if ($dockerOut -match "mempalace") {
            docker restart mempalace 2>$null | Out-Null
            Write-OK "Container mempalace restarted."
        } else {
            Write-WARN "Container mempalace not running. Start with: docker compose up -d"
        }
    } else {
        Write-WARN "Restart bridge.py manually."
    }

    Write-Host ""
    Write-OK "Update complete!"
}

# ── MAIN ─────────────────────────────────────────────────────
$config = Load-Config

if ($Configure -or ($null -eq $config -and -not $Update)) {
    Write-Step "Path configuration"
    $stPath  = Ask-STPath
    $srvPath = Ask-ServerPath
    $srvMode = Ask-ServerMode
    Save-Config -STPath $stPath -ServerPath $srvPath -ServerMode $srvMode
    $config = [PSCustomObject]@{
        st_extensions_path = $stPath
        server_path        = $srvPath
        server_mode        = $srvMode
    }
}

Write-Host ""
Write-Host "  ST path  : $($config.st_extensions_path)" -ForegroundColor DarkCyan
Write-Host "  Server   : $($config.server_path)"        -ForegroundColor DarkCyan
Write-Host "  Mode     : $($config.server_mode)"        -ForegroundColor DarkCyan
Write-Host ""

if ($Update) {
    Update-All -Config $config
} else {
    $ok = Install-Extension -STPath $config.st_extensions_path
    if ($ok) {
        Install-Server -ServerPath $config.server_path -ServerMode $config.server_mode
        Write-Host ""
        Write-OK "Installation complete!"
        Write-Host ""
        Write-Host "  Next steps:" -ForegroundColor White
        Write-Host "  1. Open SillyTavern"                          -ForegroundColor Gray
        Write-Host "  2. Extensions > find MemPalace > enable"      -ForegroundColor Gray
        Write-Host "  3. Select a character and start chatting"      -ForegroundColor Gray
        Write-Host ""
        Write-Host "  To update later: git pull + .\install.ps1 -Update" -ForegroundColor DarkGray
    }
}
Write-Host ""
