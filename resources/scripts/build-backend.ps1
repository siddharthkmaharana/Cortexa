# ─────────────────────────────────────────────────────────────────────────────
# build-backend.ps1
# Builds the CORTEXA FastAPI backend into a single self-contained .exe
# using PyInstaller and places it into resources\bin\.
#
# Usage (from project root, in PowerShell):
#   powershell -ExecutionPolicy Bypass -File resources\scripts\build-backend.ps1
#
# Requirements:
#   - Python 3.11+
#   - backend\venv must exist:
#       cd backend
#       python -m venv venv
#       venv\Scripts\activate
#       pip install -r requirements.txt
#       pip install pyinstaller
# ─────────────────────────────────────────────────────────────────────────────

param(
    [string]$WhisperModel = ""   # optional: pass '-WhisperModel small' to pre-bundle
)

$ErrorActionPreference = "Stop"

# ── Resolve paths ─────────────────────────────────────────────────────────────
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Resolve-Path "$ScriptDir\..\.." ).Path
$BackendDir  = Join-Path $ProjectRoot "backend"
$OutputDir   = Join-Path $ProjectRoot "resources\bin"
$BinaryName  = "cortexa-backend"
$VenvPython  = Join-Path $BackendDir "venv\Scripts\python.exe"

function Write-Info    { param($msg) Write-Host "[build] $msg" -ForegroundColor Cyan    }
function Write-Success { param($msg) Write-Host "[build] $msg" -ForegroundColor Green   }
function Write-Warn    { param($msg) Write-Host "[build] $msg" -ForegroundColor Yellow  }
function Write-Fail    { param($msg) Write-Host "[build] $msg" -ForegroundColor Red; exit 1 }

# ── Pre-flight ────────────────────────────────────────────────────────────────
Write-Info "CORTEXA backend build — Windows"
Write-Info "Project root : $ProjectRoot"
Write-Info "Output dir   : $OutputDir"

if (-not (Test-Path $BackendDir))  { Write-Fail "backend\ not found at $BackendDir" }
if (-not (Test-Path $VenvPython))  {
    Write-Fail "venv not found. Run: cd backend && python -m venv venv && pip install -r requirements.txt"
}

$PythonVersion = & $VenvPython --version 2>&1
Write-Info "Python : $PythonVersion"

# Check PyInstaller
$PIVersion = & $VenvPython -m PyInstaller --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Warn "PyInstaller not found — installing..."
    & $VenvPython -m pip install pyinstaller --quiet
}
Write-Info "PyInstaller : $PIVersion"

# ── Optional Whisper pre-download ─────────────────────────────────────────────
if ($WhisperModel -ne "") {
    Write-Info "Pre-downloading Whisper model '$WhisperModel'..."
    & $VenvPython -c "import whisper; whisper.load_model('$WhisperModel')"
    if ($LASTEXITCODE -ne 0) { Write-Warn "Whisper download failed — will download at runtime" }
}

# ── Clean previous build ──────────────────────────────────────────────────────
Write-Info "Cleaning previous build artifacts..."
@("$BackendDir\build", "$BackendDir\dist", "$BackendDir\$BinaryName.spec") | ForEach-Object {
    if (Test-Path $_) { Remove-Item $_ -Recurse -Force }
}

# ── Ensure output dir exists ──────────────────────────────────────────────────
if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }

# ── Run PyInstaller ───────────────────────────────────────────────────────────
Write-Info "Running PyInstaller..."
Set-Location $BackendDir

& $VenvPython -m PyInstaller `
    --onefile `
    --name $BinaryName `
    --distpath $OutputDir `
    --workpath "$BackendDir\build" `
    --specpath $BackendDir `
    --hidden-import "uvicorn.logging" `
    --hidden-import "uvicorn.loops" `
    --hidden-import "uvicorn.loops.auto" `
    --hidden-import "uvicorn.protocols" `
    --hidden-import "uvicorn.protocols.http" `
    --hidden-import "uvicorn.protocols.http.auto" `
    --hidden-import "uvicorn.protocols.websockets" `
    --hidden-import "uvicorn.protocols.websockets.auto" `
    --hidden-import "uvicorn.lifespan" `
    --hidden-import "uvicorn.lifespan.on" `
    --hidden-import "fastapi" `
    --hidden-import "pydantic" `
    --hidden-import "multipart" `
    --hidden-import "psutil" `
    --hidden-import "pyautogui" `
    --hidden-import "playwright" `
    --collect-all "uvicorn" `
    --collect-all "fastapi" `
    --noconfirm `
    --clean `
    main.py

if ($LASTEXITCODE -ne 0) { Write-Fail "PyInstaller exited with code $LASTEXITCODE" }

# ── Verify output ─────────────────────────────────────────────────────────────
$BinaryPath = Join-Path $OutputDir "$BinaryName.exe"
if (-not (Test-Path $BinaryPath)) { Write-Fail "Binary not found at $BinaryPath" }

$BinarySize = [math]::Round((Get-Item $BinaryPath).Length / 1MB, 1)
Write-Success "Binary built successfully!"
Write-Success "  Location : $BinaryPath"
Write-Success "  Size     : ${BinarySize} MB"

# ── Clean up PyInstaller artifacts ────────────────────────────────────────────
Write-Info "Cleaning build artifacts..."
@("$BackendDir\build", "$BackendDir\$BinaryName.spec") | ForEach-Object {
    if (Test-Path $_) { Remove-Item $_ -Recurse -Force }
}

# ── Smoke test ────────────────────────────────────────────────────────────────
Write-Info "Running smoke test..."
$env:CORTEXA_TOKEN = "smoke-test"
$env:CORTEXA_PORT  = "18099"

$proc = Start-Process -FilePath $BinaryPath -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:18099/health" -UseBasicParsing -TimeoutSec 5
    if ($resp.StatusCode -eq 200) {
        Write-Success "Smoke test passed — /health returned 200 ✓"
    } else {
        Write-Warn "Smoke test: /health returned $($resp.StatusCode)"
    }
} catch {
    Write-Warn "Smoke test: could not reach /health — $_"
} finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\CORTEXA_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:\CORTEXA_PORT  -ErrorAction SilentlyContinue
}

# ── nircmd reminder ───────────────────────────────────────────────────────────
$NircmdPath = Join-Path $OutputDir "nircmd.exe"
if (-not (Test-Path $NircmdPath)) {
    Write-Warn ""
    Write-Warn "Optional: download nircmd.exe for reliable volume control on Windows."
    Write-Warn "  https://www.nirsoft.net/utils/nircmd.html"
    Write-Warn "  Place nircmd.exe in: $OutputDir"
}

Write-Host ""
Write-Success "Build complete. Next step:"
Write-Host "  npm run make  — package the full Electron app with this binary" -ForegroundColor Cyan