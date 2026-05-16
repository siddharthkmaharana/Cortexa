"""
routes/files.py — File and folder management

Handles create, rename, move, copy, delete, list, open, reveal, and write
operations on the local filesystem.

Security:
  • All paths are expanded and resolved to absolute paths before use
  • '..' traversal is blocked at the Pydantic layer (models.py) and re-checked here
  • Paths must resolve within the user's home directory or /tmp
  • Permanent delete is off by default — trash is used instead
  • File writes are capped at 10 MB to prevent accidental disk exhaustion
  • File listing skips hidden files and caps at 200 entries
"""

import os
import shutil
import logging
import asyncio
import platform
import subprocess
from pathlib import Path
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException

from models import FileCommand, FileResponse, FileEntry

log    = logging.getLogger("cortexa.files")
router = APIRouter()

PLATFORM = platform.system()   # 'Darwin' | 'Windows' | 'Linux'
HOME     = Path.home()

MAX_WRITE_BYTES  = 10 * 1024 * 1024   # 10 MB
MAX_LIST_ENTRIES = 200


# ─── Path helpers ─────────────────────────────────────────────────────────────

def resolve_path(raw: Optional[str]) -> Path:
    """
    Expand ~ and env vars, resolve to an absolute path, enforce safe-root policy.

    Raises HTTPException if the path is empty, contains '..', or escapes
    the user's home directory / temp directory.
    """
    if not raw or not raw.strip():
        raise HTTPException(status_code=422, detail="path must not be empty")

    expanded = Path(os.path.expandvars(os.path.expanduser(raw.strip())))

    # Block traversal regardless of what Pydantic caught
    if ".." in expanded.parts:
        raise HTTPException(status_code=400, detail="Path traversal ('..') is not allowed")

    resolved = expanded.resolve()

    safe_roots = [HOME, Path("/tmp")]
    if PLATFORM == "Windows":
        safe_roots.append(Path(os.environ.get("USERPROFILE", str(HOME))))

    if not any(str(resolved).startswith(str(r)) for r in safe_roots):
        log.warning("Rejected path outside safe root: %s", resolved)
        raise HTTPException(
            status_code=403,
            detail=f"Path '{resolved}' is outside the allowed directory tree.",
        )

    return resolved


def _build_entry(p: Path) -> FileEntry:
    """Build a FileEntry from a Path, handling permission errors gracefully."""
    try:
        st       = p.stat()
        ftype    = "directory" if p.is_dir() else "symlink" if p.is_symlink() else "file"
        size     = st.st_size if ftype == "file" else None
        modified = datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")
        return FileEntry(name=p.name, type=ftype, size=size, modified=modified)
    except (PermissionError, OSError):
        return FileEntry(name=p.name, type="file")


# ─── Trash helper ─────────────────────────────────────────────────────────────

async def _to_trash(path: Path) -> None:
    """
    Move a path to the OS trash / recycle bin.

    macOS  — AppleScript Finder delete (preserves Undo in Finder)
    Windows — Send2Trash package (pip install send2trash)
    Linux  — gio trash → trash-cli → rm fallback
    """
    loop = asyncio.get_event_loop()

    if PLATFORM == "Darwin":
        script = f'tell application "Finder" to delete POSIX file "{path}"'
        result = await loop.run_in_executor(
            None,
            lambda: subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=10,
            ),
        )
        if result.returncode != 0:
            await loop.run_in_executor(None, lambda: _send2trash_fallback(str(path)))

    elif PLATFORM == "Windows":
        await loop.run_in_executor(None, lambda: _send2trash_fallback(str(path)))

    else:
        for cmd in (["gio", "trash", str(path)], ["trash", str(path)]):
            try:
                r = await loop.run_in_executor(
                    None, lambda c=cmd: subprocess.run(c, capture_output=True, timeout=5)
                )
                if r.returncode == 0:
                    return
            except FileNotFoundError:
                continue
        # Linux last resort — permanent removal
        log.warning("No trash utility found on Linux — permanently deleting %s", path)
        await loop.run_in_executor(
            None,
            lambda: shutil.rmtree(str(path)) if path.is_dir() else os.unlink(str(path)),
        )


def _send2trash_fallback(p: str) -> None:
    try:
        import send2trash
        send2trash.send2trash(p)
    except ImportError:
        raise RuntimeError("send2trash not installed. Run: pip install send2trash")


# ═══════════════════════════════════════════════════════════════════════════════
# ACTION HANDLERS
# ═══════════════════════════════════════════════════════════════════════════════

async def _create_folder(raw: str) -> FileResponse:
    path = resolve_path(raw)
    if path.exists():
        if path.is_dir():
            return FileResponse(ok=True, action="create_folder", path=str(path))
        raise HTTPException(status_code=409, detail=f"A file already exists at '{path}'")
    log.info("create_folder: %s", path)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: path.mkdir(parents=True, exist_ok=True))
    return FileResponse(ok=True, action="create_folder", path=str(path))


async def _rename(raw: str, new_name: str) -> FileResponse:
    if not new_name or not new_name.strip():
        raise HTTPException(status_code=422, detail="new_name is required")
    clean = new_name.strip()
    if "/" in clean or "\\" in clean:
        raise HTTPException(status_code=400, detail="new_name must be a filename, not a path")
    src  = resolve_path(raw)
    dest = src.parent / clean
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"'{src.name}' does not exist")
    if dest.exists():
        raise HTTPException(status_code=409, detail=f"'{clean}' already exists in this folder")
    log.info("rename: %s → %s", src.name, clean)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: src.rename(dest))
    return FileResponse(ok=True, action="rename", path=str(dest))


async def _move(raw: str, dest_raw: str) -> FileResponse:
    src  = resolve_path(raw)
    dest = resolve_path(dest_raw)
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"'{src.name}' does not exist")
    if not dest.is_dir():
        raise HTTPException(status_code=400, detail=f"Destination '{dest}' is not a directory")
    final = dest / src.name
    if final.exists():
        raise HTTPException(status_code=409, detail=f"'{src.name}' already exists in destination")
    log.info("move: %s → %s", src, dest)
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: shutil.move(str(src), str(dest)))
    return FileResponse(ok=True, action="move", path=str(final))


async def _copy(raw: str, dest_raw: str) -> FileResponse:
    src  = resolve_path(raw)
    dest = resolve_path(dest_raw)
    if not src.exists():
        raise HTTPException(status_code=404, detail=f"'{src.name}' does not exist")
    if not dest.is_dir():
        raise HTTPException(status_code=400, detail=f"Destination '{dest}' is not a directory")
    final = dest / src.name
    log.info("copy: %s → %s", src, dest)
    loop = asyncio.get_event_loop()
    if src.is_dir():
        await loop.run_in_executor(None, lambda: shutil.copytree(str(src), str(final)))
    else:
        await loop.run_in_executor(None, lambda: shutil.copy2(str(src), str(final)))
    return FileResponse(ok=True, action="copy", path=str(final))


async def _delete(raw: str, trash: bool) -> FileResponse:
    path = resolve_path(raw)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"'{path.name}' does not exist")
    if path == HOME:
        raise HTTPException(status_code=403, detail="Refusing to delete the home directory")
    log.info("delete [%s]: %s", "trash" if trash else "permanent", path)
    if trash:
        await _to_trash(path)
    else:
        log.warning("PERMANENT DELETE: %s", path)
        loop = asyncio.get_event_loop()
        if path.is_dir():
            await loop.run_in_executor(None, lambda: shutil.rmtree(str(path)))
        else:
            await loop.run_in_executor(None, lambda: os.unlink(str(path)))
    return FileResponse(ok=True, action="delete", path=str(path))


async def _list_dir(raw: str) -> FileResponse:
    path = resolve_path(raw)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"'{path}' does not exist")
    if not path.is_dir():
        raise HTTPException(status_code=400, detail=f"'{path.name}' is not a directory")
    log.info("list: %s", path)
    loop = asyncio.get_event_loop()

    def _collect():
        try:
            items = sorted(path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            return [
                _build_entry(i) for i in items[:MAX_LIST_ENTRIES]
                if not i.name.startswith(".")
            ]
        except PermissionError:
            return []

    entries = await loop.run_in_executor(None, _collect)
    return FileResponse(ok=True, action="list", path=str(path), entries=entries)


async def _open_file(raw: str) -> FileResponse:
    path = resolve_path(raw)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"'{path.name}' does not exist")
    log.info("open: %s", path)
    loop = asyncio.get_event_loop()
    try:
        if PLATFORM == "Darwin":
            await loop.run_in_executor(None, lambda: subprocess.Popen(["open", str(path)]))
        elif PLATFORM == "Windows":
            await loop.run_in_executor(None, lambda: subprocess.Popen(f'start "" "{path}"', shell=True))
        else:
            await loop.run_in_executor(None, lambda: subprocess.Popen(["xdg-open", str(path)]))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return FileResponse(ok=True, action="open", path=str(path))


async def _reveal(raw: str) -> FileResponse:
    path = resolve_path(raw)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"'{path.name}' does not exist")
    log.info("reveal: %s", path)
    loop = asyncio.get_event_loop()
    if PLATFORM == "Darwin":
        await loop.run_in_executor(None, lambda: subprocess.run(["open", "-R", str(path)], timeout=5))
    elif PLATFORM == "Windows":
        await loop.run_in_executor(None, lambda: subprocess.run(f'explorer /select,"{path}"', shell=True, timeout=5))
    else:
        await loop.run_in_executor(None, lambda: subprocess.Popen(["xdg-open", str(path.parent)]))
    return FileResponse(ok=True, action="reveal", path=str(path))


async def _write(raw: str, content: str) -> FileResponse:
    path    = resolve_path(raw)
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_WRITE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Content too large ({len(encoded)//1024} KB). Max {MAX_WRITE_BYTES//1024} KB.",
        )
    log.info("write: %s (%d bytes)", path, len(encoded))
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, lambda: path.parent.mkdir(parents=True, exist_ok=True))

    # Atomic write via temp file → rename
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        await loop.run_in_executor(None, lambda: tmp.write_text(content, encoding="utf-8"))
        await loop.run_in_executor(None, lambda: tmp.replace(path))
    except Exception:
        try: tmp.unlink()
        except Exception: pass
        raise
    return FileResponse(ok=True, action="write", path=str(path))


# ═══════════════════════════════════════════════════════════════════════════════
# ROUTER
# ═══════════════════════════════════════════════════════════════════════════════

@router.post("/files", response_model=FileResponse,
             summary="Manage files and folders on the local filesystem.")
async def file_action(cmd: FileCommand) -> FileResponse:
    action  = cmd.action
    path    = cmd.path        or ""
    dest    = cmd.destination or ""
    name    = cmd.new_name    or ""
    content = cmd.content     or ""
    trash   = cmd.trash

    log.info("files/%s path='%s'", action, path)

    if action == "create_folder": return await _create_folder(path)
    if action == "rename":        return await _rename(path, name)
    if action == "move":          return await _move(path, dest)
    if action == "copy":          return await _copy(path, dest)
    if action == "delete":        return await _delete(path, trash)
    if action == "list":          return await _list_dir(path or str(HOME))
    if action == "open":          return await _open_file(path)
    if action == "reveal":        return await _reveal(path)
    if action == "write":
        if not content:
            raise HTTPException(status_code=422, detail="content is required for write")
        return await _write(path, content)

    raise HTTPException(status_code=422, detail=f"Unknown files action: '{action}'")