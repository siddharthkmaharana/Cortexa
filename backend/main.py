"""
main.py — CORTEXA FastAPI backend

Entry point for the local automation server. Runs on 127.0.0.1 only —
never exposed to the network. The Electron main process spawns this via
PyInstaller binary or uvicorn, injects CORTEXA_TOKEN and CORTEXA_PORT
as environment variables, and proxies every renderer request through IPC
so the token never touches the renderer.

Responsibilities:
  • Session-token authentication on every non-health request
  • Route registration for app, system, browser, and file automation
  • Voice transcription endpoint (Whisper)
  • Screenshot endpoint (pyautogui)
  • Structured request/response logging
  • Clean startup and shutdown lifecycle
"""

import os
import sys
import time
import logging
import platform
import tempfile
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request, HTTPException, Depends, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from routes.app_control import router as app_router
from routes.system      import router as system_router
from routes.browser     import router as browser_router
from routes.files       import router as files_router
from models             import (
    HealthResponse,
    ScreenshotResponse,
    TranscribeResponse,
    ErrorResponse,
)

# ─── Logging setup ────────────────────────────────────────────────────────────

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)

log = logging.getLogger("cortexa")

# ─── Configuration ─────────────────────────────────────────────────────────────

SESSION_TOKEN: str = os.environ.get("CORTEXA_TOKEN", "")
PORT:          int = int(os.environ.get("CORTEXA_PORT", "8000"))
HOST:          str = "127.0.0.1"   # never 0.0.0.0

if not SESSION_TOKEN:
    log.warning(
        "CORTEXA_TOKEN is not set. All non-health requests will be rejected. "
        "In production this is set by the Electron main process."
    )

PLATFORM = platform.system()   # 'Darwin' | 'Windows' | 'Linux'

# ─── Startup / shutdown ───────────────────────────────────────────────────────

_startup_time: float = 0.0
_whisper_model = None          # loaded lazily on first transcribe request


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Runs once at startup and once at shutdown.
    Logs environment info; gracefully tears down Playwright if it was used.
    """
    global _startup_time
    _startup_time = time.time()

    log.info("=" * 52)
    log.info("  CORTEXA backend starting")
    log.info(f"  Platform : {PLATFORM}")
    log.info(f"  Python   : {sys.version.split()[0]}")
    log.info(f"  Host     : {HOST}:{PORT}")
    log.info(f"  Token    : {'set' if SESSION_TOKEN else 'NOT SET'}")
    log.info("=" * 52)

    yield  # ← app is running here

    # ── Shutdown ──
    log.info("CORTEXA backend shutting down")

    # Close Playwright browser if it was opened
    try:
        from routes.browser import shutdown_playwright
        await shutdown_playwright()
    except Exception:
        pass

    log.info("Shutdown complete")


# ─── App instance ─────────────────────────────────────────────────────────────

app = FastAPI(
    title="CORTEXA Automation Backend",
    description="Local automation server for the CORTEXA desktop agent.",
    version="1.0.0",
    docs_url="/docs" if os.environ.get("NODE_ENV") == "development" else None,
    redoc_url=None,
    openapi_url="/openapi.json" if os.environ.get("NODE_ENV") == "development" else None,
    lifespan=lifespan,
)

# ─── CORS — localhost only ────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",           # Electron dev server
        "http://127.0.0.1:3000",
        f"http://localhost:{PORT}",
        f"http://127.0.0.1:{PORT}",
        "app://.",                         # Electron production origin
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Session-Token"],
)

# ─── Authentication dependency ────────────────────────────────────────────────

async def require_token(request: Request) -> None:
    """
    FastAPI dependency — validates X-Session-Token on every protected request.
    Uses constant-time comparison to prevent timing attacks.

    Raises HTTP 401 if the token is missing or wrong.
    Raises HTTP 503 if the server was started without a token (misconfiguration).
    """
    if not SESSION_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="Server misconfigured — session token not set.",
        )

    incoming = request.headers.get("X-Session-Token", "")

    # hmac.compare_digest gives constant-time comparison
    import hmac
    if not hmac.compare_digest(incoming.encode(), SESSION_TOKEN.encode()):
        log.warning(
            "Auth failure from %s — bad token (first 4 chars: %s…)",
            request.client.host if request.client else "unknown",
            incoming[:4] if incoming else "empty",
        )
        raise HTTPException(status_code=401, detail="Invalid session token.")


# ─── Request logging middleware ───────────────────────────────────────────────

@app.middleware("http")
async def log_requests(request: Request, call_next):
    """
    Logs every request with method, path, status, and duration.
    Skips /health to avoid log noise.
    """
    if request.url.path == "/health":
        return await call_next(request)

    start = time.perf_counter()
    response = await call_next(request)
    elapsed = (time.perf_counter() - start) * 1000

    log.info(
        "%s %s → %d  (%.1f ms)",
        request.method,
        request.url.path,
        response.status_code,
        elapsed,
    )
    return response


# ─── Global exception handlers ────────────────────────────────────────────────

@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    log.warning("Validation error on %s: %s", request.url.path, exc.errors())
    return JSONResponse(
        status_code=422,
        content=ErrorResponse(
            ok=False,
            error="Request validation failed",
            detail=str(exc.errors()),
        ).model_dump(),
    )


@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    log.exception("Unhandled exception on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content=ErrorResponse(
            ok=False,
            error=str(exc),
            detail=type(exc).__name__,
        ).model_dump(),
    )


# ─── Health endpoint (no auth required) ──────────────────────────────────────

@app.get(
    "/health",
    response_model=HealthResponse,
    tags=["meta"],
    summary="Health check — called by Electron to confirm the server is ready.",
)
async def health():
    return HealthResponse(
        ok=True,
        uptime_seconds=round(time.time() - _startup_time, 1),
        platform=PLATFORM,
        port=PORT,
    )


# ─── Screenshot endpoint ──────────────────────────────────────────────────────

@app.post(
    "/screenshot",
    response_model=ScreenshotResponse,
    dependencies=[Depends(require_token)],
    tags=["system"],
    summary="Capture the full screen and return a base64 PNG.",
)
async def screenshot(request: Request):
    """
    Takes a full-screen screenshot using pyautogui (or scrot on Linux).
    Returns the image as a base64-encoded PNG string.

    The Electron main process also exposes window.cortexa.screenshot() which
    calls this endpoint — the renderer never calls it directly.
    """
    try:
        import pyautogui
        import io
        import base64

        # Run in thread — pyautogui is synchronous and blocks the event loop
        loop = asyncio.get_event_loop()
        img  = await loop.run_in_executor(None, pyautogui.screenshot)

        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode()

        return ScreenshotResponse(ok=True, image=b64, format="png")

    except ImportError:
        raise HTTPException(
            status_code=501,
            detail="pyautogui is not installed. Run: pip install pyautogui",
        )
    except Exception as exc:
        log.exception("Screenshot failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ─── Voice transcription endpoint ────────────────────────────────────────────

@app.post(
    "/voice/transcribe",
    response_model=TranscribeResponse,
    dependencies=[Depends(require_token)],
    tags=["voice"],
    summary="Transcribe uploaded audio using OpenAI Whisper (runs locally).",
)
async def transcribe(audio: UploadFile = File(...)):
    """
    Accepts a multipart audio file (webm, wav, mp3, ogg, m4a) and returns
    the Whisper transcription. The model is loaded on first call and cached
    for subsequent requests (loading takes ~2s for the 'base' model).

    The Web Speech API is CORTEXA's default STT provider. This endpoint is
    only called when CONFIG.voice.sttProvider === 'whisper'.
    """
    global _whisper_model

    # ── Validate file type ──
    allowed = {"audio/webm", "audio/wav", "audio/mpeg", "audio/ogg", "audio/mp4", "audio/x-m4a"}
    ct = (audio.content_type or "").lower()
    if ct and ct not in allowed:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported audio type: {ct}. Accepted: {', '.join(allowed)}",
        )

    # ── Enforce a sane file size limit (25 MB) ──
    MAX_BYTES = 25 * 1024 * 1024
    raw = await audio.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio file too large ({len(raw) // 1024} KB). Max: 25 MB.",
        )

    # ── Write to a temp file (Whisper requires a path, not bytes) ──
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name

    try:
        # ── Lazy-load Whisper ──
        if _whisper_model is None:
            try:
                import whisper
                model_name = os.environ.get("WHISPER_MODEL", "base")
                log.info("Loading Whisper model '%s'…", model_name)
                loop = asyncio.get_event_loop()
                _whisper_model = await loop.run_in_executor(
                    None, lambda: whisper.load_model(model_name)
                )
                log.info("Whisper model loaded")
            except ImportError:
                raise HTTPException(
                    status_code=501,
                    detail="openai-whisper is not installed. Run: pip install openai-whisper",
                )

        # ── Transcribe in thread ──
        loop   = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            lambda: _whisper_model.transcribe(
                tmp_path,
                language=os.environ.get("WHISPER_LANGUAGE", None),   # None = auto-detect
                fp16=False,     # safer on CPU; set to True if you have a GPU
            ),
        )

        text     = result.get("text", "").strip()
        language = result.get("language", "unknown")

        log.info("Transcribed %d chars (%s)", len(text), language)
        return TranscribeResponse(ok=True, text=text, language=language)

    except HTTPException:
        raise
    except Exception as exc:
        log.exception("Transcription failed")
        raise HTTPException(status_code=500, detail=str(exc))

    finally:
        # Always delete the temp file
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


# ─── Automation routers ───────────────────────────────────────────────────────

# Every router enforces require_token via its own Depends() —
# routes/app_control.py, routes/system.py, etc. also import and apply it.
# Applying it here at the include level adds a second layer of protection.

app.include_router(
    app_router,
    prefix="/automate",
    tags=["app"],
    dependencies=[Depends(require_token)],
)

app.include_router(
    system_router,
    prefix="/automate",
    tags=["system"],
    dependencies=[Depends(require_token)],
)

app.include_router(
    browser_router,
    prefix="/automate",
    tags=["browser"],
    dependencies=[Depends(require_token)],
)

app.include_router(
    files_router,
    prefix="/automate",
    tags=["files"],
    dependencies=[Depends(require_token)],
)


# ─── Entry point (development only) ──────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        reload=os.environ.get("NODE_ENV") == "development",
        log_level=LOG_LEVEL.lower(),
        access_log=False,   # we use our own middleware logger
    )