# ============================================================
# MemPalace — Installer / Updater
# https://github.com/ShinRalexis/MemPalace
# ============================================================
# Uso:
#   Prima installazione : .\install.ps1
#   Aggiornamento       : .\install.ps1 -Update
#   Riconfigura percorsi: .\install.ps1 -Configure
# ============================================================

param(
    [switch]$Update,
    [switch]$Configure
)

$ErrorActionPreference = "Stop"
$ConfigFile = Join-Path $PSScriptRoot "paths.local.json"
$ExtensionSource = Join-Path $PSScriptRoot "extension"
$ServerSource = Join-Path $PSScriptRoot "server"

# ── UI ───────────────────────────────────────────────────────
function Write-OK   { param($m) Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-WARN { param($m) Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Write-ERR  { param($m) Write-Host "  [XX] $m" -ForegroundColor Red }
function Write-INFO { param($m) Write-Host "  [..] $m" -ForegroundColor Gray }
function Write-Step { param($m) Write-Host "`n  >>> $m" -ForegroundColor Cyan }

Write-Host ""
Write-Host "  MemPalace — Installer v3.10.0" -ForegroundColor Cyan
Write-Host "  https://github.com/ShinRalexis/MemPalace" -ForegroundColor DarkGray
Write-Host ""

# ── Config ───────────────────────────────────────────────────
function Load-Config {
    if (Test-Path $ConfigFile) {
        try { return Get-Content $ConfigFile -Raw | ConvertFrom-Json }
        catch { Write-WARN "File config corrotto, verrà ricreato." }
    }
    return $null
}

function Save-Config {
    param($STPath, $ServerPath, $ServerMode)
    [PSCustomObject]@{
        st_extensions_path = $STPath
        server_path        = $ServerPath
        server_mode        = $ServerMode
        configured_at      = (Get-Date -Format "yyyy-MM-dd HH:mm")
    } | ConvertTo-Json | Set-Content $ConfigFile -Encoding UTF8
    Write-OK "Configurazione salvata in paths.local.json"
}

# ── Cerca SillyTavern ────────────────────────────────────────
function Find-SillyTavern {
    $candidates = @(
        "$env:USERPROFILE\SillyTavern",
        "$env:USERPROFILE\Documents\SillyTavern",
        "C:\SillyTavern", "D:\SillyTavern",
        "D:\AI\Silly Tavern", "C:\AI\SillyTavern",
        "C:\AI\Silly Tavern"
    )
    foreach ($p in $candidates) {
        if (Test-Path (Join-Path $p "public\scripts\extensions")) { return $p }
    }
    return $null
}

# ── Chiedi percorsi ──────────────────────────────────────────
function Ask-STPath {
    $detected = Find-SillyTavern
    if ($detected) {
        Write-INFO "SillyTavern rilevato: $detected"
        $ans = Read-Host "  Usa questo percorso? [Invio=Sì / digita percorso alternativo]"
        if ($ans -eq "") { return $detected } else { return $ans.Trim('"') }
    }
    Write-WARN "SillyTavern non rilevato automaticamente."
    return (Read-Host "  Percorso SillyTavern (es. D:\AI\Silly Tavern)").Trim('"')
}

function Ask-ServerPath {
    Write-Host ""

    # Rileva se esiste già un container mempalace
    $existing = $null
    try { $existing = docker ps -a --filter "name=mempalace" --format "{{.Names}}" 2>$null } catch {}

    if ($existing -match "mempalace") {
        Write-OK "Container Docker 'mempalace' rilevato — MemPalace è già installato."
        Write-INFO "Lo script aggiornerà i file del server esistente."
        Write-INFO "Percorso dei file server (lascia vuoto se usi già questa repo):"
        $p = (Read-Host "  Percorso server esistente").Trim('"')
        if ($p -eq "") { return $ServerSource } else { return $p }
    }

    Write-INFO "Dove installare il server MemPalace?"
    Write-INFO "Lascia vuoto per eseguirlo direttamente da questa cartella repo."
    $p = (Read-Host "  Percorso server").Trim('"')
    if ($p -eq "") { return $ServerSource } else { return $p }
}

function Ask-ServerMode {
    Write-Host ""
    Write-Host "  Modalità server:" -ForegroundColor White
    Write-Host "  [1] Docker (consigliato)" -ForegroundColor Gray
    Write-Host "  [2] Python diretto" -ForegroundColor Gray
    $choice = Read-Host "  Scegli [1/2]"
    if ($choice -eq "2") { return "python" } else { return "docker" }
}

# ── Installa estensione ST ───────────────────────────────────
function Install-Extension {
    param($STPath)
    Write-Step "Installazione estensione SillyTavern"

    $dest = Join-Path $STPath "public\scripts\extensions\MemPlace"

    if (-not (Test-Path (Join-Path $STPath "public\scripts\extensions"))) {
        Write-ERR "Cartella extensions non trovata in: $STPath"
        Write-ERR "Verifica che il percorso SillyTavern sia corretto."
        return $false
    }

    if (-not (Test-Path $dest)) {
        New-Item -ItemType Directory -Path $dest | Out-Null
    }

    Copy-Item "$ExtensionSource\*" $dest -Recurse -Force
    Write-OK "Estensione installata in: $dest"
    return $true
}

# ── Installa server ──────────────────────────────────────────
function Install-Server {
    param($ServerPath, $ServerMode)
    Write-Step "Configurazione server MemPalace"

    # Se il percorso server è diverso dalla cartella server/ del repo, copia i file
    if ($ServerPath -ne $ServerSource) {
        if (-not (Test-Path $ServerPath)) {
            New-Item -ItemType Directory -Path $ServerPath -Force | Out-Null
        }
        Copy-Item "$ServerSource\*" $ServerPath -Recurse -Force
        Write-OK "File server copiati in: $ServerPath"
    } else {
        Write-OK "Server eseguito direttamente da: $ServerPath"
    }

    if ($ServerMode -eq "docker") {
        Start-DockerServer -ServerPath $ServerPath
    } else {
        Start-PythonServer -ServerPath $ServerPath
    }
}

function Start-DockerServer {
    param($ServerPath)
    $dockerAvail = $null
    try { $dockerAvail = (Get-Command docker -ErrorAction SilentlyContinue) } catch {}
    if (-not $dockerAvail) {
        Write-WARN "Docker non trovato. Installa Docker Desktop e riesegui."
        Write-INFO "https://www.docker.com/products/docker-desktop"
        return
    }

    # Rileva se esiste già un container mempalace (installazione esistente)
    $existing = docker ps -a --filter "name=mempalace" --format "{{.Names}}" 2>$null
    if ($existing -match "mempalace") {
        # Container esistente → copia solo i file aggiornati e riavvia
        Write-INFO "Container 'mempalace' già presente — aggiorno i file e riavvio."
        if ($ServerPath -ne $ServerSource) {
            Copy-Item "$ServerSource\*.py" $ServerPath -Force
            Copy-Item "$ServerSource\requirements.txt" $ServerPath -Force
            Write-OK "File server aggiornati in: $ServerPath"
        }
        docker restart mempalace 2>&1 | Out-Null
        Write-OK "Server riavviato su http://localhost:8052"
    } else {
        # Nessun container → prima installazione completa
        Write-INFO "Prima installazione — avvio container Docker..."
        Push-Location $ServerPath
        try {
            docker compose up -d --build 2>&1 | Write-Host
            Write-OK "Server avviato su http://localhost:8052"
        } catch {
            Write-ERR "Errore Docker: $_"
        } finally {
            Pop-Location
        }
    }
}

function Start-PythonServer {
    param($ServerPath)
    $pythonAvail = $null
    try { $pythonAvail = (Get-Command python -ErrorAction SilentlyContinue) } catch {}
    if (-not $pythonAvail) {
        Write-WARN "Python non trovato. Installa Python 3.11+ e riesegui."
        return
    }

    Write-INFO "Installazione dipendenze Python..."
    Push-Location $ServerPath
    try {
        python -m pip install -r requirements.txt -q
        Write-OK "Dipendenze installate."
        Write-WARN "Avvia il server manualmente con:"
        Write-Host "  cd `"$ServerPath`"" -ForegroundColor White
        Write-Host "  python bridge.py" -ForegroundColor White
    } catch {
        Write-ERR "Errore pip: $_"
    } finally {
        Pop-Location
    }
}

# ── Aggiornamento ────────────────────────────────────────────
function Update-All {
    param($Config)
    Write-Step "Aggiornamento MemPalace"

    # Aggiorna repo git
    $gitDir = Join-Path $PSScriptRoot ".git"
    if (Test-Path $gitDir) {
        Write-INFO "git pull..."
        Push-Location $PSScriptRoot
        git pull
        Pop-Location
    } else {
        Write-WARN "Questa cartella non è un repo git — skip git pull."
    }

    # Aggiorna estensione ST
    $dest = Join-Path $Config.st_extensions_path "public\scripts\extensions\MemPlace"
    if (Test-Path $dest) {
        Copy-Item "$ExtensionSource\*" $dest -Recurse -Force
        Write-OK "Estensione ST aggiornata."
    } else {
        Write-WARN "Cartella estensione non trovata, reinstallo..."
        Install-Extension -STPath $Config.st_extensions_path | Out-Null
    }

    # Aggiorna server (se diverso dal source)
    $srvPath = $Config.server_path
    if ($srvPath -and $srvPath -ne $ServerSource -and (Test-Path $srvPath)) {
        Copy-Item "$ServerSource\*.py" $srvPath -Force
        Copy-Item "$ServerSource\requirements.txt" $srvPath -Force
        Copy-Item "$ServerSource\docker-compose.yml" $srvPath -Force
        Write-OK "File server aggiornati in: $srvPath"
    }

    # Riavvia server
    if ($Config.server_mode -eq "docker") {
        $running = docker ps --filter "name=mempalace" --format "{{.Names}}" 2>$null
        if ($running -match "mempalace") {
            docker restart mempalace 2>&1 | Out-Null
            Write-OK "Container mempalace riavviato."
        } else {
            Write-WARN "Container mempalace non in esecuzione — avvialo manualmente con: docker compose up -d"
        }
    } else {
        Write-WARN "Riavvia manualmente il server bridge.py."
    }

    Write-Host ""
    Write-OK "Aggiornamento completato!"
}

# ── MAIN ─────────────────────────────────────────────────────
$config = Load-Config

if ($Configure -or ($null -eq $config -and -not $Update)) {
    Write-Step "Configurazione percorsi"
    $stPath     = Ask-STPath
    $srvPath    = Ask-ServerPath
    $srvMode    = Ask-ServerMode
    Save-Config -STPath $stPath -ServerPath $srvPath -ServerMode $srvMode
    $config = [PSCustomObject]@{
        st_extensions_path = $stPath
        server_path        = $srvPath
        server_mode        = $srvMode
    }
}

Write-Host ""
Write-Host "  ST path    : $($config.st_extensions_path)" -ForegroundColor DarkCyan
Write-Host "  Server     : $($config.server_path)" -ForegroundColor DarkCyan
Write-Host "  Modalità   : $($config.server_mode)" -ForegroundColor DarkCyan
Write-Host ""

if ($Update) {
    Update-All -Config $config
} else {
    $ok = Install-Extension -STPath $config.st_extensions_path
    if ($ok) {
        Install-Server -ServerPath $config.server_path -ServerMode $config.server_mode
        Write-Host ""
        Write-OK "Installazione completata!"
        Write-Host ""
        Write-Host "  Prossimi passi:" -ForegroundColor White
        Write-Host "  1. Apri SillyTavern" -ForegroundColor Gray
        Write-Host "  2. Extensions > cerca MemPalace > abilita" -ForegroundColor Gray
        Write-Host "  3. Seleziona un personaggio e inizia a chattare" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  Per aggiornamenti futuri: git pull + .\install.ps1 -Update" -ForegroundColor DarkGray
    }
}
Write-Host ""
