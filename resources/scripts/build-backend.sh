#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-backend.sh
# Builds the CORTEXA FastAPI backend into a single self-contained binary
# using PyInstaller and places it into resources/bin/.
#
# Usage (from project root):
#   bash resources/scripts/build-backend.sh
#   bash resources/scripts/build-backend.sh --model small   # embed Whisper model
#
# Requirements:
#   • Python 3.11+
#   • backend/venv must exist (run: cd backend && python -m venv venv && pip install -r requirements.txt)
#   • PyInstaller installed in the venv (pip install pyinstaller)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BACKEND_DIR="${PROJECT_ROOT}/backend"
OUTPUT_DIR="${PROJECT_ROOT}/resources/bin"
BINARY_NAME="cortexa-backend"
WHISPER_MODEL="${2:-}"   # optional: --model base|small|medium

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()    { echo -e "${CYAN}[build]${NC} $*"; }
success() { echo -e "${GREEN}[build]${NC} $*"; }
warn()    { echo -e "${YELLOW}[build]${NC} $*"; }
error()   { echo -e "${RED}[build]${NC} $*"; exit 1; }

# ── Pre-flight checks ─────────────────────────────────────────────────────────
info "CORTEXA backend build — $(uname -s) $(uname -m)"
info "Project root : ${PROJECT_ROOT}"
info "Output dir   : ${OUTPUT_DIR}"

[[ -d "${BACKEND_DIR}" ]] || error "backend/ directory not found at ${BACKEND_DIR}"

# Locate Python from the virtualenv
VENV_PYTHON="${BACKEND_DIR}/venv/bin/python"
[[ -f "${VENV_PYTHON}" ]] || error "venv not found. Run: cd backend && python -m venv venv && pip install -r requirements.txt"

PYTHON_VERSION=$("${VENV_PYTHON}" --version 2>&1)
info "Python       : ${PYTHON_VERSION}"

# Check PyInstaller
"${VENV_PYTHON}" -m PyInstaller --version &>/dev/null || {
    warn "PyInstaller not found — installing..."
    "${VENV_PYTHON}" -m pip install pyinstaller --quiet
}

PYINSTALLER_VERSION=$("${VENV_PYTHON}" -m PyInstaller --version 2>&1)
info "PyInstaller  : ${PYINSTALLER_VERSION}"

# ── Optional: pre-download Whisper model so it's bundled ─────────────────────
if [[ -n "${WHISPER_MODEL}" && "${1:-}" == "--model" ]]; then
    info "Pre-downloading Whisper model '${WHISPER_MODEL}'..."
    "${VENV_PYTHON}" -c "import whisper; whisper.load_model('${WHISPER_MODEL}')" || \
        warn "Whisper model download failed — model will be downloaded at runtime instead"
fi

# ── Clean previous build ──────────────────────────────────────────────────────
info "Cleaning previous build artifacts..."
rm -rf "${BACKEND_DIR}/build" "${BACKEND_DIR}/dist" "${BACKEND_DIR}/${BINARY_NAME}.spec"

# ── Run PyInstaller ───────────────────────────────────────────────────────────
info "Running PyInstaller..."
cd "${BACKEND_DIR}"

"${VENV_PYTHON}" -m PyInstaller \
    --onefile \
    --name "${BINARY_NAME}" \
    --distpath "${OUTPUT_DIR}" \
    --workpath "${BACKEND_DIR}/build" \
    --specpath "${BACKEND_DIR}" \
    --hidden-import "uvicorn.logging" \
    --hidden-import "uvicorn.loops" \
    --hidden-import "uvicorn.loops.auto" \
    --hidden-import "uvicorn.protocols" \
    --hidden-import "uvicorn.protocols.http" \
    --hidden-import "uvicorn.protocols.http.auto" \
    --hidden-import "uvicorn.protocols.websockets" \
    --hidden-import "uvicorn.protocols.websockets.auto" \
    --hidden-import "uvicorn.lifespan" \
    --hidden-import "uvicorn.lifespan.on" \
    --hidden-import "fastapi" \
    --hidden-import "pydantic" \
    --hidden-import "multipart" \
    --hidden-import "psutil" \
    --hidden-import "pyautogui" \
    --hidden-import "playwright" \
    --collect-all "uvicorn" \
    --collect-all "fastapi" \
    --noconfirm \
    --clean \
    main.py

# ── Verify output ─────────────────────────────────────────────────────────────
BINARY="${OUTPUT_DIR}/${BINARY_NAME}"
[[ -f "${BINARY}" ]] || error "Build failed — binary not found at ${BINARY}"

# Make executable (PyInstaller should do this, but be explicit)
chmod +x "${BINARY}"

BINARY_SIZE=$(du -sh "${BINARY}" | cut -f1)
success "Binary built successfully!"
success "  Location : ${BINARY}"
success "  Size     : ${BINARY_SIZE}"

# ── Remove PyInstaller working directories ────────────────────────────────────
info "Cleaning up build artifacts..."
rm -rf "${BACKEND_DIR}/build" "${BACKEND_DIR}/${BINARY_NAME}.spec"

# ── Smoke test ────────────────────────────────────────────────────────────────
info "Running smoke test..."
CORTEXA_TOKEN="smoke-test" CORTEXA_PORT="18099" "${BINARY}" &
SMOKE_PID=$!
sleep 2

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:18099/health 2>/dev/null || echo "000")

kill "${SMOKE_PID}" 2>/dev/null || true
wait "${SMOKE_PID}" 2>/dev/null || true

if [[ "${HTTP_STATUS}" == "200" ]]; then
    success "Smoke test passed — /health returned 200 ✓"
else
    warn "Smoke test: /health returned '${HTTP_STATUS}' (expected 200)"
    warn "The binary may still work — check manually: ${BINARY} &"
fi

echo ""
success "Build complete. Next step:"
echo -e "  ${CYAN}npm run make${NC}  — package the full Electron app with this binary"