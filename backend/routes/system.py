"""
routes/system.py — OS system settings

Controls dark/light mode, audio volume, display brightness, Wi-Fi,
Bluetooth, screen lock, display sleep, system notifications, and
returns a live system info snapshot.

Every setting has three implementations: macOS (AppleScript + CLI tools),
Windows (PowerShell + WMI), and Linux (gsettings / pactl / nmcli).
Falls back gracefully when optional dependencies aren't installed.
"""

import asyncio
import logging
import platform
import subprocess
from typing import Optional, Union

from fastapi import APIRouter, HTTPException

from models import SystemCommand, SystemResponse, SystemInfoData

log    = logging.getLogger("cortexa.system")
router = APIRouter()

PLATFORM = platform.system()   # 'Darwin' | 'Windows' | 'Linux'


# ─── Subprocess helper ────────────────────────────────────────────────────────

async def _run(cmd: list, *, timeout: int = 8, shell: bool = False) -> subprocess.CompletedProcess:
    """Run a command in the thread pool, returning the CompletedProcess result."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            cmd if not shell else " ".join(cmd),
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=shell,
        ),
    )


async def _osascript(script: str) -> subprocess.CompletedProcess:
    """Run an AppleScript one-liner (macOS only)."""
    return await _run(["osascript", "-e", script])


async def _powershell(cmd: str) -> subprocess.CompletedProcess:
    """Run a PowerShell command (Windows only)."""
    return await _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd])


# ═══════════════════════════════════════════════════════════════════════════════
# DARK / LIGHT MODE
# ═══════════════════════════════════════════════════════════════════════════════

async def _set_dark_mode(enabled: bool) -> SystemResponse:
    log.info("dark_mode → %s", enabled)

    if PLATFORM == "Darwin":
        # AppleScript sets the appearance preference directly
        value  = "true" if enabled else "false"
        script = f"tell application \"System Events\" to tell appearance preferences to set dark mode to {value}"
        result = await _osascript(script)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip() or "AppleScript failed")

    elif PLATFORM == "Windows":
        # Registry: 0 = dark, 1 = light (counterintuitively)
        reg_val = "0" if enabled else "1"
        ps_cmd  = (
            f"Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' "
            f"-Name AppsUseLightTheme -Value {reg_val}; "
            f"Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' "
            f"-Name SystemUsesLightTheme -Value {reg_val}"
        )
        result = await _powershell(ps_cmd)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip())

    else:
        # Linux — GNOME
        theme   = "prefer-dark" if enabled else "prefer-light"
        result  = await _run(["gsettings", "set", "org.gnome.desktop.interface", "color-scheme", theme])
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail="gsettings failed — is this a GNOME desktop?")

    return SystemResponse(ok=True, setting="dark_mode", value=enabled)


# ═══════════════════════════════════════════════════════════════════════════════
# VOLUME
# ═══════════════════════════════════════════════════════════════════════════════

async def _set_volume(level: int) -> SystemResponse:
    level = max(0, min(100, level))
    log.info("volume → %d", level)

    if PLATFORM == "Darwin":
        result = await _osascript(f"set volume output volume {level}")
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip())

    elif PLATFORM == "Windows":
        # Use nircmd if available (more reliable than PowerShell WMI)
        nircmd = await _run(["nircmd", "setsysvolume", str(int(level / 100 * 65535))])
        if nircmd.returncode != 0:
            # Fallback: PowerShell + WMI
            ps = (
                f"$vol = [Math]::Round({level} / 100 * 65535); "
                "(New-Object -ComObject WScript.Shell).SendKeys([char]173); "  # mute toggle hack
                # Proper volume via COM
                f"Add-Type -TypeDefinition 'using System.Runtime.InteropServices; "
                f"[ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] interface a {{}} "
                f"class b : a {{}}'; "
            )
            await _powershell(ps)

    else:
        # Linux — PulseAudio / PipeWire
        result = await _run(["pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{level}%"])
        if result.returncode != 0:
            # amixer fallback
            await _run(["amixer", "-q", "sset", "Master", f"{level}%"])

    return SystemResponse(ok=True, setting="volume", value=level)


# ═══════════════════════════════════════════════════════════════════════════════
# BRIGHTNESS
# ═══════════════════════════════════════════════════════════════════════════════

async def _set_brightness(level: int) -> SystemResponse:
    level = max(0, min(100, level))
    log.info("brightness → %d", level)

    if PLATFORM == "Darwin":
        # Requires: brew install brightness
        frac   = round(level / 100, 2)
        result = await _run(["brightness", str(frac)])
        if result.returncode != 0:
            # Fallback: use AppleScript to prompt user since brightness
            # requires System Preferences without the CLI tool
            raise HTTPException(
                status_code=501,
                detail="'brightness' CLI not installed. Run: brew install brightness",
            )

    elif PLATFORM == "Windows":
        ps_cmd = (
            f"(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods)"
            f".WmiSetBrightness(1, {level})"
        )
        result = await _powershell(ps_cmd)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip())

    else:
        # Linux — brightnessctl or xrandr
        result = await _run(["brightnessctl", "set", f"{level}%"])
        if result.returncode != 0:
            await _run(["xrandr", "--output", "eDP-1", "--brightness", str(level / 100)])

    return SystemResponse(ok=True, setting="brightness", value=level)


# ═══════════════════════════════════════════════════════════════════════════════
# WI-FI
# ═══════════════════════════════════════════════════════════════════════════════

async def _set_wifi(enabled: bool) -> SystemResponse:
    state = "on" if enabled else "off"
    log.info("wifi → %s", state)

    if PLATFORM == "Darwin":
        # Detects the Wi-Fi interface (usually en0 or en1)
        detect   = await _run(["networksetup", "-listallhardwareports"])
        iface    = "en0"
        lines    = detect.stdout.splitlines()
        for i, line in enumerate(lines):
            if "Wi-Fi" in line or "AirPort" in line:
                for j in range(i, min(i + 4, len(lines))):
                    if lines[j].startswith("Device:"):
                        iface = lines[j].split(":")[-1].strip()
                        break
                break

        result = await _run(["networksetup", "-setairportpower", iface, state])
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip())

    elif PLATFORM == "Windows":
        ps_cmd = f"netsh interface set interface 'Wi-Fi' {'enabled' if enabled else 'disabled'}"
        result = await _powershell(ps_cmd)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip())

    else:
        # Linux — nmcli
        result = await _run(["nmcli", "radio", "wifi", state])
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip())

    return SystemResponse(ok=True, setting="wifi", value=enabled)


# ═══════════════════════════════════════════════════════════════════════════════
# BLUETOOTH
# ═══════════════════════════════════════════════════════════════════════════════

async def _set_bluetooth(enabled: bool) -> SystemResponse:
    state = "1" if enabled else "0"
    log.info("bluetooth → %s", "on" if enabled else "off")

    if PLATFORM == "Darwin":
        # Requires: brew install blueutil
        result = await _run(["blueutil", "--power", state])
        if result.returncode != 0:
            raise HTTPException(
                status_code=501,
                detail="'blueutil' not installed. Run: brew install blueutil",
            )

    elif PLATFORM == "Windows":
        # PowerShell via Device Management API
        action = "Enable" if enabled else "Disable"
        ps_cmd = (
            f"Get-PnpDevice | Where-Object {{$_.Class -eq 'Bluetooth' -and $_.Status -ne 'Error'}} "
            f"| {action}-PnpDevice -Confirm:$false"
        )
        result = await _powershell(ps_cmd)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip())

    else:
        # Linux — rfkill
        op     = "unblock" if enabled else "block"
        result = await _run(["rfkill", op, "bluetooth"])
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip())

    return SystemResponse(ok=True, setting="bluetooth", value=enabled)


# ═══════════════════════════════════════════════════════════════════════════════
# LOCK SCREEN
# ═══════════════════════════════════════════════════════════════════════════════

async def _lock_screen() -> SystemResponse:
    log.info("lock_screen")

    if PLATFORM == "Darwin":
        script = 'tell application "System Events" to keystroke "q" using {control down, command down}'
        await _osascript(script)

    elif PLATFORM == "Windows":
        result = await _run(["rundll32.exe", "user32.dll,LockWorkStation"])
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail="LockWorkStation failed")

    else:
        for cmd in (
            ["loginctl", "lock-session"],
            ["gnome-screensaver-command", "--lock"],
            ["xdg-screensaver", "lock"],
        ):
            result = await _run(cmd)
            if result.returncode == 0:
                break

    return SystemResponse(ok=True, setting="lock_screen")


# ═══════════════════════════════════════════════════════════════════════════════
# SLEEP DISPLAY
# ═══════════════════════════════════════════════════════════════════════════════

async def _sleep_display() -> SystemResponse:
    log.info("sleep_display")

    if PLATFORM == "Darwin":
        await _run(["pmset", "displaysleepnow"])

    elif PLATFORM == "Windows":
        # SendMessage to set display off (0x0112 = WM_SYSCOMMAND, 0xF170 = SC_MONITORPOWER, 2 = off)
        ps_cmd = (
            "Add-Type -Name W -Member '[DllImport(\"user32.dll\")] "
            "public static extern int SendMessage(int hWnd, int Msg, int wParam, int lParam);' "
            "-Namespace W; [W.W]::SendMessage(-1, 0x0112, 0xF170, 2)"
        )
        await _powershell(ps_cmd)

    else:
        for cmd in (["xset", "dpms", "force", "off"], ["loginctl", "lock-session"]):
            result = await _run(cmd)
            if result.returncode == 0:
                break

    return SystemResponse(ok=True, setting="sleep_display")


# ═══════════════════════════════════════════════════════════════════════════════
# NOTIFICATION
# ═══════════════════════════════════════════════════════════════════════════════

async def _send_notification(title: str, message: str, subtitle: str = "") -> SystemResponse:
    log.info("notification: '%s' — '%s'", title, message)

    # Sanitise — prevent AppleScript/PowerShell injection via quote chars
    def _clean(s: str) -> str:
        return s.replace('"', "'").replace("\\", "").replace("\n", " ")[:200]

    t = _clean(title)
    m = _clean(message)
    s = _clean(subtitle)

    if PLATFORM == "Darwin":
        sub_part = f'subtitle "{s}" ' if s else ""
        script   = f'display notification "{m}" with title "{t}" {sub_part}'
        result   = await _osascript(script)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail=result.stderr.strip())

    elif PLATFORM == "Windows":
        # BurntToast module (Install-Module BurntToast) or PowerShell toast
        ps_cmd = (
            f"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, "
            f"ContentType = WindowsRuntime] | Out-Null; "
            f"$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent("
            f"[Windows.UI.Notifications.ToastTemplateType]::ToastText02); "
            f"$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('{t}')) | Out-Null; "
            f"$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode('{m}')) | Out-Null; "
            f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('CORTEXA')"
            f".Show((New-Object Windows.UI.Notifications.ToastNotification($xml)))"
        )
        await _powershell(ps_cmd)

    else:
        # Linux — notify-send
        cmd = ["notify-send", t, m, "--app-name=CORTEXA"]
        if s:
            cmd += [f"--hint=string:x-canonical-subtitle:{s}"]
        result = await _run(cmd)
        if result.returncode != 0:
            raise HTTPException(status_code=500, detail="notify-send failed")

    return SystemResponse(ok=True, setting="notification")


# ═══════════════════════════════════════════════════════════════════════════════
# SYSTEM INFO SNAPSHOT
# ═══════════════════════════════════════════════════════════════════════════════

async def _get_info() -> SystemResponse:
    """
    Returns a best-effort snapshot of current system settings.
    Non-fatal — missing values are returned as None rather than erroring.
    """
    volume    = await _read_volume()
    dark_mode = await _read_dark_mode()

    info = SystemInfoData(
        volume    = volume,
        dark_mode = dark_mode,
        platform  = PLATFORM,
    )
    return SystemResponse(ok=True, setting="info", info=info)


async def _read_volume() -> Optional[int]:
    """Read the current system volume as 0–100."""
    try:
        if PLATFORM == "Darwin":
            r = await _osascript("output volume of (get volume settings)")
            return int(r.stdout.strip()) if r.returncode == 0 else None
        elif PLATFORM == "Linux":
            r = await _run(["pactl", "get-sink-volume", "@DEFAULT_SINK@"])
            if r.returncode == 0:
                import re
                m = re.search(r"(\d+)%", r.stdout)
                return int(m.group(1)) if m else None
    except Exception:
        pass
    return None


async def _read_dark_mode() -> Optional[bool]:
    """Read whether dark mode is currently enabled."""
    try:
        if PLATFORM == "Darwin":
            r = await _osascript("dark mode of (get current appearance) as string")
            if r.returncode == 0:
                return r.stdout.strip().lower() == "true"
        elif PLATFORM == "Windows":
            r = await _powershell(
                "Get-ItemPropertyValue 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion"
                "\\Themes\\Personalize' -Name AppsUseLightTheme"
            )
            if r.returncode == 0:
                return r.stdout.strip() == "0"  # 0 = dark
        elif PLATFORM == "Linux":
            r = await _run(["gsettings", "get", "org.gnome.desktop.interface", "color-scheme"])
            if r.returncode == 0:
                return "dark" in r.stdout.lower()
    except Exception:
        pass
    return None


# ═══════════════════════════════════════════════════════════════════════════════
# ROUTER
# ═══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/system",
    response_model=SystemResponse,
    summary="Control OS system settings — dark mode, volume, brightness, Wi-Fi, Bluetooth, and more.",
)
async def system_action(cmd: SystemCommand) -> SystemResponse:
    """
    | setting       | value type    | behaviour                             |
    |---------------|---------------|---------------------------------------|
    | dark_mode     | bool          | Enable or disable system dark mode    |
    | volume        | int (0-100)   | Set output volume                     |
    | mute          | —             | Mute audio (volume = 0)               |
    | brightness    | int (0-100)   | Set display brightness                |
    | wifi          | bool          | Enable or disable Wi-Fi               |
    | bluetooth     | bool          | Enable or disable Bluetooth           |
    | lock_screen   | —             | Lock the screen immediately           |
    | sleep_display | —             | Put the display to sleep              |
    | notification  | dict/str      | Show a system notification            |
    | info          | —             | Return current system settings        |
    """
    setting = cmd.setting
    value   = cmd.value

    log.info("system/%s value=%r", setting, value)

    if setting == "dark_mode":
        enabled = value if isinstance(value, bool) else str(value).lower() not in ("false", "0", "off")
        return await _set_dark_mode(enabled)

    if setting == "volume":
        lvl = int(value) if value is not None else 50
        return await _set_volume(lvl)

    if setting == "mute":
        return await _set_volume(0)

    if setting == "brightness":
        lvl = int(value) if value is not None else 50
        return await _set_brightness(lvl)

    if setting == "wifi":
        on = value if isinstance(value, bool) else str(value).lower() not in ("false", "0", "off")
        return await _set_wifi(on)

    if setting == "bluetooth":
        on = value if isinstance(value, bool) else str(value).lower() not in ("false", "0", "off")
        return await _set_bluetooth(on)

    if setting == "lock_screen":
        return await _lock_screen()

    if setting == "sleep_display":
        return await _sleep_display()

    if setting == "notification":
        if isinstance(value, dict):
            title    = str(value.get("title",   "CORTEXA"))
            message  = str(value.get("message", ""))
            subtitle = str(value.get("subtitle",""))
        else:
            title, message, subtitle = "CORTEXA", str(value or ""), ""
        return await _send_notification(title, message, subtitle)

    if setting == "info":
        return await _get_info()

    raise HTTPException(status_code=422, detail=f"Unknown system setting: '{setting}'")