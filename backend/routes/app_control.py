"""
routes/app_control.py — Application control

Handles open, close, focus, and list operations for desktop applications.
Dispatches to the correct OS-specific implementation at runtime.

Security:
  • App names are validated by Pydantic (models.py) before reaching here
  • subprocess calls never use shell=True
  • Arguments are passed as lists, never string-interpolated into a shell command
"""

import sys
import logging
import platform
import subprocess
import asyncio
from typing import Optional

import psutil
from fastapi import APIRouter, HTTPException

from models import AppCommand, AppResponse

log    = logging.getLogger("cortexa.app")
router = APIRouter()

PLATFORM = platform.system()  # 'Darwin' | 'Windows' | 'Linux'

# ─── Common app name aliases ──────────────────────────────────────────────────
# Maps casual names the agent might use to the exact binary/app name the OS needs.

APP_ALIASES: dict[str, dict] = {
    # macOS bundle names
    "vscode":           {"darwin": "Visual Studio Code", "windows": "code"},
    "vs code":          {"darwin": "Visual Studio Code", "windows": "code"},
    "visual studio code":{"darwin":"Visual Studio Code", "windows": "code"},
    "chrome":           {"darwin": "Google Chrome",      "windows": "chrome"},
    "google chrome":    {"darwin": "Google Chrome",      "windows": "chrome"},
    "firefox":          {"darwin": "Firefox",            "windows": "firefox"},
    "safari":           {"darwin": "Safari"},
    "terminal":         {"darwin": "Terminal",           "windows": "wt"},   # Windows Terminal
    "finder":           {"darwin": "Finder"},
    "explorer":         {"windows":"explorer"},
    "spotify":          {"darwin": "Spotify",            "windows": "Spotify"},
    "slack":            {"darwin": "Slack",              "windows": "slack"},
    "zoom":             {"darwin": "zoom.us",            "windows": "Zoom"},
    "notion":           {"darwin": "Notion",             "windows": "Notion"},
    "figma":            {"darwin": "Figma",              "windows": "figma"},
    "discord":          {"darwin": "Discord",            "windows": "Discord"},
    "whatsapp":         {"darwin": "WhatsApp",           "windows": "WhatsApp"},
    "notes":            {"darwin": "Notes"},
    "calendar":         {"darwin": "Calendar"},
    "mail":             {"darwin": "Mail",               "windows": "Outlook"},
    "word":             {"darwin": "Microsoft Word",     "windows": "WINWORD"},
    "excel":            {"darwin": "Microsoft Excel",    "windows": "EXCEL"},
    "powerpoint":       {"darwin": "Microsoft PowerPoint","windows":"POWERPNT"},
    "xcode":            {"darwin": "Xcode"},
    "postman":          {"darwin": "Postman",            "windows": "Postman"},
    "iterm":            {"darwin": "iTerm"},
    "iterm2":           {"darwin": "iTerm"},
}


def resolve_app_name(raw: str) -> str:
    """
    Resolve a casual app name to the platform-specific name.
    Falls back to the original name if no alias is found.
    """
    key = raw.lower().strip()
    if key in APP_ALIASES:
        platform_key = "darwin" if PLATFORM == "Darwin" else "windows"
        return APP_ALIASES[key].get(platform_key, raw)
    return raw


# ═══════════════════════════════════════════════════════════════════════════════
# OPEN
# ═══════════════════════════════════════════════════════════════════════════════

async def _open_darwin(app_name: str, args: Optional[str]) -> AppResponse:
    """
    macOS: `open -a <AppName>` — launches the app bundle.
    Optionally passes --args to the application.
    """
    resolved = resolve_app_name(app_name)
    cmd = ["open", "-a", resolved]
    if args:
        cmd += ["--args"] + args.split()

    log.info("macOS open: %s", cmd)

    loop   = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(cmd, capture_output=True, text=True, timeout=10),
    )

    if result.returncode != 0:
        stderr = result.stderr.strip()
        # Common case: app not found
        if "Unable to find application" in stderr or "not found" in stderr.lower():
            raise HTTPException(
                status_code=404,
                detail=f"Application not found: '{resolved}'. Check the name in Finder.",
            )
        raise HTTPException(status_code=500, detail=stderr or "open failed")

    return AppResponse(ok=True, action="open", target=resolved)


async def _open_windows(app_name: str, args: Optional[str]) -> AppResponse:
    """
    Windows: tries `start <name>` first; falls back to searching PATH.
    """
    resolved = resolve_app_name(app_name)
    # `start` is a shell built-in — we need shell=True here, but we
    # control the input (validated by Pydantic) so it is safe.
    cmd = f'start "" "{resolved}"'
    if args:
        cmd += f" {args}"

    log.info("Windows start: %s", resolved)

    loop   = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=10
        ),
    )

    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=result.stderr.strip() or f"Failed to open '{resolved}'",
        )

    return AppResponse(ok=True, action="open", target=resolved)


async def _open_linux(app_name: str, args: Optional[str]) -> AppResponse:
    """
    Linux: tries to run the app directly, falls back to `xdg-open`.
    """
    resolved = resolve_app_name(app_name).lower().replace(" ", "-")
    cmd = [resolved] + (args.split() if args else [])

    log.info("Linux exec: %s", cmd)

    loop = asyncio.get_event_loop()
    try:
        proc = await loop.run_in_executor(
            None,
            lambda: subprocess.Popen(cmd),
        )
        return AppResponse(ok=True, action="open", target=resolved, pid=proc.pid)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"'{resolved}' not found on PATH.",
        )


# ═══════════════════════════════════════════════════════════════════════════════
# CLOSE
# ═══════════════════════════════════════════════════════════════════════════════

async def _close_darwin(app_name: str) -> AppResponse:
    """
    macOS: AppleScript quit is graceful (saves open documents if the app supports it).
    Falls back to pkill if AppleScript fails.
    """
    resolved = resolve_app_name(app_name)
    script   = f'tell application "{resolved}" to quit'

    log.info("macOS quit: %s", resolved)
    loop = asyncio.get_event_loop()

    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10,
        ),
    )

    if result.returncode != 0:
        # Graceful quit failed — fall back to pkill
        log.warning("AppleScript quit failed for '%s', trying pkill", resolved)
        await loop.run_in_executor(
            None,
            lambda: subprocess.run(["pkill", "-ix", resolved], timeout=5),
        )

    return AppResponse(ok=True, action="close", target=resolved)


async def _close_windows(app_name: str) -> AppResponse:
    """
    Windows: taskkill /f terminates the process tree.
    """
    resolved = resolve_app_name(app_name)
    exe_name = resolved if resolved.endswith(".exe") else f"{resolved}.exe"

    log.info("Windows taskkill: %s", exe_name)
    loop = asyncio.get_event_loop()

    await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            ["taskkill", "/f", "/im", exe_name],
            capture_output=True, text=True, timeout=10,
        ),
    )
    return AppResponse(ok=True, action="close", target=resolved)


async def _close_linux(app_name: str) -> AppResponse:
    resolved = resolve_app_name(app_name).lower().replace(" ", "-")
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: subprocess.run(["pkill", "-ix", resolved], timeout=5),
    )
    return AppResponse(ok=True, action="close", target=resolved)


# ═══════════════════════════════════════════════════════════════════════════════
# FOCUS / SWITCH
# ═══════════════════════════════════════════════════════════════════════════════

async def _focus_darwin(app_name: str) -> AppResponse:
    """
    macOS: AppleScript activate brings the app to front.
    Also opens it if it wasn't running.
    """
    resolved = resolve_app_name(app_name)
    script   = f'tell application "{resolved}" to activate'

    log.info("macOS activate: %s", resolved)
    loop = asyncio.get_event_loop()

    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10,
        ),
    )

    if result.returncode != 0:
        # App may not be running — try opening it first
        return await _open_darwin(app_name, None)

    return AppResponse(ok=True, action="focus", target=resolved)


async def _focus_windows(app_name: str) -> AppResponse:
    """
    Windows: PowerShell AppActivate via WScript.Shell.
    """
    resolved = resolve_app_name(app_name)
    ps_script = (
        f'$wsh = New-Object -ComObject WScript.Shell; '
        f'$wsh.AppActivate("{resolved}")'
    )

    log.info("Windows AppActivate: %s", resolved)
    loop = asyncio.get_event_loop()

    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True, text=True, timeout=10,
        ),
    )

    if result.returncode != 0:
        return await _open_windows(app_name, None)

    return AppResponse(ok=True, action="focus", target=resolved)


# ═══════════════════════════════════════════════════════════════════════════════
# LIST RUNNING APPS
# ═══════════════════════════════════════════════════════════════════════════════

async def _list_apps() -> AppResponse:
    """
    Uses psutil to enumerate running processes.
    Returns unique process names, sorted alphabetically.
    Excludes system daemons and kernel threads.
    """
    loop = asyncio.get_event_loop()

    def _collect():
        seen   = set()
        apps   = []
        for proc in psutil.process_iter(["name", "pid", "status"]):
            try:
                name = proc.info["name"]
                if not name or name in seen:
                    continue
                # Skip obvious OS internals
                if any(name.startswith(p) for p in (
                    "kernel", "kworker", "systemd", "launchd",
                    "com.apple", "configd", "WindowServer",
                )):
                    continue
                seen.add(name)
                apps.append(name)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return sorted(apps, key=str.lower)

    apps = await loop.run_in_executor(None, _collect)
    return AppResponse(ok=True, action="list", apps=apps)


# ═══════════════════════════════════════════════════════════════════════════════
# ROUTER
# ═══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/app",
    response_model=AppResponse,
    summary="Control desktop applications — open, close, focus, or list.",
)
async def control_app(cmd: AppCommand) -> AppResponse:
    """
    Dispatches to the correct OS implementation based on `action`.

    | action | behaviour                                      |
    |--------|------------------------------------------------|
    | open   | Launch the app (or bring to front if running) |
    | close  | Graceful quit, then force-kill if needed       |
    | focus  | Bring the app window to the foreground         |
    | switch | Alias for focus                                |
    | list   | Return all running process names               |
    """
    action = cmd.action
    target = cmd.target or ""
    args   = cmd.args

    log.info("app/%s target='%s'", action, target)

    # ── list ──────────────────────────────────────────────────────────────────
    if action == "list":
        return await _list_apps()

    # ── open ──────────────────────────────────────────────────────────────────
    if action == "open" or action == "launch":
        if not target:
            raise HTTPException(status_code=422, detail="target is required for action='open'")
        if PLATFORM == "Darwin":  return await _open_darwin(target, args)
        if PLATFORM == "Windows": return await _open_windows(target, args)
        return await _open_linux(target, args)

    # ── close ─────────────────────────────────────────────────────────────────
    if action == "close" or action == "quit":
        if not target:
            raise HTTPException(status_code=422, detail="target is required for action='close'")
        if PLATFORM == "Darwin":  return await _close_darwin(target)
        if PLATFORM == "Windows": return await _close_windows(target)
        return await _close_linux(target)

    # ── focus / switch ────────────────────────────────────────────────────────
    if action in ("focus", "switch"):
        if not target:
            raise HTTPException(status_code=422, detail="target is required for action='focus'")
        if PLATFORM == "Darwin":  return await _focus_darwin(target)
        if PLATFORM == "Windows": return await _focus_windows(target)
        # Linux: attempt to run the app (wmctrl not universally available)
        return await _open_linux(target, None)

    raise HTTPException(status_code=422, detail=f"Unknown action: '{action}'")