"""
models.py — Pydantic v2 schemas

Every request body and response body used across all routes is
defined here. Keeping schemas in one file means:
  • No circular imports between route modules
  • One place to update field names or add validation
  • Auto-generated OpenAPI docs are always accurate
"""

from __future__ import annotations
from typing import Any, Optional, Union
from pydantic import BaseModel, Field, field_validator


# ─── Base response ────────────────────────────────────────────────────────────

class BaseResponse(BaseModel):
    ok:     bool            = True
    error:  Optional[str]   = None
    detail: Optional[str]   = None


# ─── Health ───────────────────────────────────────────────────────────────────

class HealthResponse(BaseResponse):
    uptime_seconds: float   = 0.0
    platform:       str     = ""
    port:           int     = 8000


# ─── Error ────────────────────────────────────────────────────────────────────

class ErrorResponse(BaseResponse):
    ok: bool = False


# ─── Screenshot ───────────────────────────────────────────────────────────────

class ScreenshotResponse(BaseResponse):
    image:  Optional[str]   = None   # base64-encoded PNG
    format: str             = "png"
    width:  Optional[int]   = None
    height: Optional[int]   = None


# ─── Voice ────────────────────────────────────────────────────────────────────

class TranscribeResponse(BaseResponse):
    text:     str   = ""
    language: str   = "unknown"
    duration: Optional[float] = None   # audio duration in seconds (if available)


# ═══════════════════════════════════════════════════════════════════════════════
# APP CONTROL
# ═══════════════════════════════════════════════════════════════════════════════

class AppCommand(BaseModel):
    action: str = Field(..., description="open | close | focus | list")
    target: Optional[str] = Field(None, description="Application name")
    args:   Optional[str] = Field(None, description="Optional CLI arguments")

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        allowed = {"open", "close", "focus", "switch", "list"}
        if v not in allowed:
            raise ValueError(f"action must be one of {allowed}")
        return v

    @field_validator("target")
    @classmethod
    def sanitise_target(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # Strip characters that could be used for shell injection
        forbidden = set(';&|`$(){}[]<>\\')
        if any(c in forbidden for c in v):
            raise ValueError("target contains forbidden characters")
        return v.strip()


class AppResponse(BaseResponse):
    action: Optional[str]   = None
    target: Optional[str]   = None
    pid:    Optional[int]   = None   # PID of launched process, if available
    apps:   Optional[list]  = None   # populated for action='list'


# ═══════════════════════════════════════════════════════════════════════════════
# SYSTEM SETTINGS
# ═══════════════════════════════════════════════════════════════════════════════

class SystemCommand(BaseModel):
    setting: str = Field(..., description=(
        "dark_mode | volume | brightness | wifi | bluetooth | "
        "lock_screen | sleep_display | notification | screenshot | info"
    ))
    value: Optional[Union[bool, int, float, str, dict]] = Field(
        None, description="Setting value — type depends on setting"
    )

    @field_validator("setting")
    @classmethod
    def validate_setting(cls, v: str) -> str:
        allowed = {
            "dark_mode", "volume", "brightness",
            "wifi", "bluetooth",
            "lock_screen", "sleep_display",
            "notification", "screenshot", "info",
            "mute",
        }
        if v not in allowed:
            raise ValueError(f"setting must be one of {allowed}")
        return v


class SystemInfoData(BaseModel):
    volume:    Optional[int]   = None
    brightness:Optional[int]   = None
    dark_mode: Optional[bool]  = None
    wifi:      Optional[bool]  = None
    bluetooth: Optional[bool]  = None
    platform:  Optional[str]   = None


class SystemResponse(BaseResponse):
    setting:  Optional[str]            = None
    value:    Optional[Any]            = None
    info:     Optional[SystemInfoData] = None


# ═══════════════════════════════════════════════════════════════════════════════
# BROWSER AUTOMATION
# ═══════════════════════════════════════════════════════════════════════════════

class BrowserCommand(BaseModel):
    action:   str           = Field(..., description=(
        "navigate | search | click | fill | get_content | "
        "new_tab | close_tab | back | forward | scroll"
    ))
    url:      Optional[str] = Field(None, description="URL for navigate / new_tab")
    query:    Optional[str] = Field(None, description="Search query")
    engine:   Optional[str] = Field("google", description="google | amazon | youtube")
    selector: Optional[str] = Field(None, description="CSS selector or label text")
    value:    Optional[str] = Field(None, description="Value to fill or type")
    amount:   Optional[int] = Field(None, description="Scroll amount in pixels")

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        allowed = {
            "navigate", "search", "click", "fill",
            "get_content", "new_tab", "close_tab",
            "back", "forward", "scroll",
        }
        if v not in allowed:
            raise ValueError(f"action must be one of {allowed}")
        return v

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # Only allow HTTP/HTTPS — prevents file:// or javascript: abuse
        if not v.startswith(("http://", "https://")):
            return f"https://{v}"
        return v


class PageContent(BaseModel):
    title:    str = ""
    url:      str = ""
    text:     str = ""   # trimmed visible text content


class BrowserResponse(BaseResponse):
    action:  Optional[str]         = None
    content: Optional[PageContent] = None


# ═══════════════════════════════════════════════════════════════════════════════
# FILE MANAGEMENT
# ═══════════════════════════════════════════════════════════════════════════════

class FileCommand(BaseModel):
    action:   str           = Field(..., description=(
        "create_folder | rename | move | copy | delete | "
        "open | reveal | write | list"
    ))
    path:     Optional[str] = Field(None, description="Source path (~ expanded)")
    new_name: Optional[str] = Field(None, description="New name for rename")
    destination: Optional[str] = Field(None, description="Destination path for move/copy")
    content:  Optional[str] = Field(None, description="Text content for write action")
    trash:    bool          = Field(True, description="Move to trash instead of permanent delete")

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        allowed = {
            "create_folder", "rename", "move", "copy",
            "delete", "open", "reveal", "write", "list",
        }
        if v not in allowed:
            raise ValueError(f"action must be one of {allowed}")
        return v

    @field_validator("path", "destination")
    @classmethod
    def sanitise_path(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        expanded = str(v).replace("~", "", 1).strip()
        # Block path traversal attempts
        if ".." in expanded:
            raise ValueError("Path traversal ('..') is not allowed")
        return v.strip()


class FileEntry(BaseModel):
    name:     str
    type:     str           # 'file' | 'directory' | 'symlink'
    size:     Optional[int] = None   # bytes, None for directories
    modified: Optional[str] = None   # ISO timestamp


class FileResponse(BaseResponse):
    action:  Optional[str]        = None
    path:    Optional[str]        = None
    entries: Optional[list[FileEntry]] = None   # populated for action='list'