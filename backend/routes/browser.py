"""
routes/browser.py — Browser automation via Playwright

Manages a single shared Chromium browser instance across all requests.
The browser connects to an existing Chrome/Chromium session on port 9222
if available (so CORTEXA can control the user's real browser), and falls
back to launching a fresh headless instance if not.

All operations are async and non-blocking. Page content is sanitised
before being returned to the renderer.

Playwright must be installed separately:
    pip install playwright
    playwright install chromium
"""

import re
import logging
import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException
from playwright.async_api import (
    async_playwright,
    Browser,
    BrowserContext,
    Page,
    Error as PlaywrightError,
    TimeoutError as PlaywrightTimeout,
)

from models import BrowserCommand, BrowserResponse, PageContent

log    = logging.getLogger("cortexa.browser")
router = APIRouter()

# ─── Search engine URL templates ─────────────────────────────────────────────

SEARCH_ENGINES: dict[str, str] = {
    "google":  "https://www.google.com/search?q={query}",
    "amazon":  "https://www.amazon.com/s?k={query}",
    "youtube": "https://www.youtube.com/results?search_query={query}",
    "bing":    "https://www.bing.com/search?q={query}",
    "ddg":     "https://duckduckgo.com/?q={query}",
}

# ─── Singleton browser state ──────────────────────────────────────────────────

_playwright  = None
_browser:     Optional[Browser]        = None
_context:     Optional[BrowserContext] = None
_lock                                  = asyncio.Lock()

# ─── Browser lifecycle ────────────────────────────────────────────────────────

async def _get_browser() -> Browser:
    """
    Returns the shared Browser instance, creating it if necessary.

    Strategy:
      1. Try to connect to an existing Chrome/Chromium over CDP on port 9222
         (the user's real browser, launched with --remote-debugging-port=9222)
      2. If that fails, launch a fresh headless Chromium instance
    """
    global _playwright, _browser, _context

    async with _lock:
        if _browser and _browser.is_connected():
            return _browser

        if _playwright is None:
            _playwright = await async_playwright().start()

        # ── 1. Try connecting to user's existing browser ──
        try:
            _browser = await _playwright.chromium.connect_over_cdp(
                "http://localhost:9222",
                timeout=2_000,
            )
            log.info("Connected to existing Chrome on port 9222")
            _context = _browser.contexts[0] if _browser.contexts else await _browser.new_context()
            return _browser
        except Exception:
            log.info("No existing browser on :9222 — launching headless Chromium")

        # ── 2. Launch a fresh instance ──
        _browser = await _playwright.chromium.launch(
            headless=False,         # visible — user can see what CORTEXA is doing
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",  # hides bot fingerprint
                "--disable-infobars",
                "--window-size=1280,800",
            ],
        )
        _context = await _browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        log.info("Launched new Chromium instance")
        return _browser


async def _get_page() -> Page:
    """
    Returns the active page (last focused tab), or creates a new one.
    """
    await _get_browser()

    if _context is None:
        raise HTTPException(status_code=500, detail="Browser context not initialised")

    pages = _context.pages
    if pages:
        return pages[-1]

    page = await _context.new_page()
    return page


async def shutdown_playwright():
    """
    Called by main.py lifespan on app shutdown.
    Closes the browser and Playwright runtime cleanly.
    """
    global _playwright, _browser, _context
    try:
        if _browser:
            await _browser.close()
        if _playwright:
            await _playwright.stop()
    except Exception as e:
        log.warning("Playwright shutdown error: %s", e)
    finally:
        _playwright = None
        _browser    = None
        _context    = None
    log.info("Playwright shut down")


# ─── Page content extractor ───────────────────────────────────────────────────

async def _extract_content(page: Page) -> PageContent:
    """
    Extracts and sanitises the visible text from the current page.
    Strips scripts, styles, and excessive whitespace.
    Caps at 8 000 chars to keep the response manageable.
    """
    title = await page.title()
    url   = page.url

    # JavaScript to pull visible text, excluding scripts and styles
    raw_text: str = await page.evaluate("""
        () => {
            const clone = document.body.cloneNode(true);
            clone.querySelectorAll('script, style, noscript, svg, iframe').forEach(el => el.remove());
            return (clone.innerText || clone.textContent || '').trim();
        }
    """)

    # Collapse whitespace runs
    clean = re.sub(r"\s{3,}", "\n\n", raw_text).strip()
    capped = clean[:8_000] + ("…" if len(clean) > 8_000 else "")

    return PageContent(title=title, url=url, text=capped)


# ─── URL builder ─────────────────────────────────────────────────────────────

def _build_search_url(engine: str, query: str) -> str:
    template = SEARCH_ENGINES.get(engine.lower(), SEARCH_ENGINES["google"])
    from urllib.parse import quote_plus
    return template.format(query=quote_plus(query))


# ─── Action handlers ──────────────────────────────────────────────────────────

async def _navigate(url: str) -> BrowserResponse:
    page = await _get_page()
    log.info("navigate → %s", url)
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
        return BrowserResponse(ok=True, action="navigate")
    except PlaywrightTimeout:
        raise HTTPException(status_code=504, detail=f"Page timed out loading: {url}")
    except PlaywrightError as e:
        raise HTTPException(status_code=500, detail=str(e))


async def _search(engine: str, query: str) -> BrowserResponse:
    url = _build_search_url(engine, query)
    log.info("search [%s] '%s' → %s", engine, query, url)
    page = await _get_page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
        return BrowserResponse(ok=True, action="search")
    except PlaywrightTimeout:
        raise HTTPException(status_code=504, detail="Search page timed out")
    except PlaywrightError as e:
        raise HTTPException(status_code=500, detail=str(e))


async def _click(selector: str) -> BrowserResponse:
    page = await _get_page()
    log.info("click '%s'", selector)
    try:
        # Try CSS selector first, then visible text fallback
        locator = page.locator(selector).first
        if await locator.count() == 0:
            locator = page.get_by_text(selector, exact=False).first
        await locator.click(timeout=8_000)
        return BrowserResponse(ok=True, action="click")
    except PlaywrightTimeout:
        raise HTTPException(status_code=404, detail=f"Element not found or not clickable: '{selector}'")
    except PlaywrightError as e:
        raise HTTPException(status_code=500, detail=str(e))


async def _fill(selector: str, value: str) -> BrowserResponse:
    page = await _get_page()
    log.info("fill '%s' with '%s'", selector, value[:40])
    try:
        await page.fill(selector, value, timeout=8_000)
        return BrowserResponse(ok=True, action="fill")
    except PlaywrightTimeout:
        raise HTTPException(status_code=404, detail=f"Input not found: '{selector}'")
    except PlaywrightError as e:
        raise HTTPException(status_code=500, detail=str(e))


async def _get_content() -> BrowserResponse:
    page    = await _get_page()
    content = await _extract_content(page)
    log.info("get_content → %d chars from %s", len(content.text), content.url)
    return BrowserResponse(ok=True, action="get_content", content=content)


async def _new_tab(url: str = "") -> BrowserResponse:
    if _context is None:
        await _get_browser()
    page = await _context.new_page()
    log.info("new_tab url='%s'", url or "(blank)")
    if url:
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
        except PlaywrightTimeout:
            log.warning("new_tab: page timed out, tab opened anyway")
    return BrowserResponse(ok=True, action="new_tab")


async def _close_tab() -> BrowserResponse:
    page = await _get_page()
    url  = page.url
    log.info("close_tab %s", url)
    await page.close()
    return BrowserResponse(ok=True, action="close_tab")


async def _go_back() -> BrowserResponse:
    page = await _get_page()
    log.info("back from %s", page.url)
    try:
        await page.go_back(wait_until="domcontentloaded", timeout=8_000)
    except PlaywrightTimeout:
        pass   # partial load is fine
    return BrowserResponse(ok=True, action="back")


async def _go_forward() -> BrowserResponse:
    page = await _get_page()
    log.info("forward from %s", page.url)
    try:
        await page.go_forward(wait_until="domcontentloaded", timeout=8_000)
    except PlaywrightTimeout:
        pass
    return BrowserResponse(ok=True, action="forward")


async def _scroll(amount: int) -> BrowserResponse:
    page = await _get_page()
    await page.mouse.wheel(0, amount)
    log.info("scroll %d px", amount)
    return BrowserResponse(ok=True, action="scroll")


# ═══════════════════════════════════════════════════════════════════════════════
# ROUTER
# ═══════════════════════════════════════════════════════════════════════════════

@router.post(
    "/browser",
    response_model=BrowserResponse,
    summary="Control a browser via Playwright — navigate, search, click, fill, read content.",
)
async def browser_action(cmd: BrowserCommand) -> BrowserResponse:
    """
    | action       | required fields      | behaviour                            |
    |--------------|----------------------|--------------------------------------|
    | navigate     | url                  | Go to URL in active tab              |
    | search       | query, [engine]      | Open search results page             |
    | click        | selector             | Click element by CSS or visible text |
    | fill         | selector, value      | Type into an input field             |
    | get_content  | —                    | Return page title, url, and text     |
    | new_tab      | [url]                | Open a new tab, optionally at url    |
    | close_tab    | —                    | Close the active tab                 |
    | back         | —                    | Navigate backwards                   |
    | forward      | —                    | Navigate forwards                    |
    | scroll       | [amount]             | Scroll the page by amount px         |
    """
    action   = cmd.action
    url      = cmd.url      or ""
    query    = cmd.query    or ""
    engine   = cmd.engine   or "google"
    selector = cmd.selector or ""
    value    = cmd.value    or ""
    amount   = cmd.amount   or 400

    log.info("browser/%s", action)

    try:
        if action == "navigate":
            if not url:
                raise HTTPException(status_code=422, detail="url is required for navigate")
            return await _navigate(url)

        if action == "search":
            if not query:
                raise HTTPException(status_code=422, detail="query is required for search")
            return await _search(engine, query)

        if action == "click":
            if not selector:
                raise HTTPException(status_code=422, detail="selector is required for click")
            return await _click(selector)

        if action == "fill":
            if not selector or value is None:
                raise HTTPException(status_code=422, detail="selector and value required for fill")
            return await _fill(selector, value)

        if action == "get_content":
            return await _get_content()

        if action == "new_tab":
            return await _new_tab(url)

        if action == "close_tab":
            return await _close_tab()

        if action == "back":
            return await _go_back()

        if action == "forward":
            return await _go_forward()

        if action == "scroll":
            return await _scroll(amount)

        raise HTTPException(status_code=422, detail=f"Unknown browser action: '{action}'")

    except HTTPException:
        raise
    except PlaywrightError as e:
        log.exception("Playwright error on browser/%s", action)
        raise HTTPException(status_code=500, detail=f"Browser error: {e.message}")
    except Exception as e:
        log.exception("Unexpected error on browser/%s", action)
        raise HTTPException(status_code=500, detail=str(e))