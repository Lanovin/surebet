"""Camoufox bridge – jeden Camoufox (upravený Firefox) pro sázkovky, které blokují Playwright Chromium
(Betano, Tipsport, případně Chance). Běží jako samostatný Python proces vedle ingestu, protože
Camoufox potřebuje Playwright < 1.63 a Node část projektu je na 1.63.

HTTP API (jen localhost), Node klient: src/adapters/camoufox.ts
  POST /capture  {bk, url?, match, reload?, timeoutMs?, minResponses?, settleMs?}
  POST /fetch    {bk, origin, url, method?, headers?, body?, credentials?, idlePath?, idleSettleMs?}
  POST /close    {bk?}            – bez bk zavře celý prohlížeč (nová session/fingerprint)
  GET  /health
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Any

from aiohttp import web
from camoufox.async_api import AsyncCamoufox

HOST = os.getenv("CAMOUFOX_HOST", "127.0.0.1")
PORT = int(os.getenv("CAMOUFOX_PORT", "8765"))
_headless = os.getenv("CAMOUFOX_HEADLESS", "virtual")  # virtual (Xvfb) | 1 | 0
HEADLESS: Any = {"1": True, "0": False}.get(_headless, _headless)
IDLE_CLOSE_S = int(os.getenv("CAMOUFOX_IDLE_CLOSE_S", "600"))
MAX_BODY = 8_000_000
NAV_TIMEOUT_MS = 45_000
# fetch() uvnitř stránky; klient (src/adapters/camoufox.ts) čeká déle, aby stihl i první otevření originu
FETCH_TIMEOUT_MS = 45_000

# Tituly blokačních stránek (viz docs/bookmakers/{betano,tipsport}.md)
BLOCK_TITLES = re.compile(r"Betano Splash Screen|^Chyba$|Just a moment|Attention Required|Access denied", re.I)
BLOCK_ABORT_TYPES = {"image", "media", "font"}

log = logging.getLogger("camoufox-bridge")


def replayable_header(name: str) -> bool:
    """Hlavičky, které má smysl předat fetch() při replayi (cookies, UA, sec-* si prohlížeč doplní sám)."""
    n = name.lower()
    return n in ("accept", "content-type") or (n.startswith("x-") and not n.startswith("x-forwarded"))


class Pool:
    """Vlastní Camoufox (proces + fingerprint) a jedna stránka na sázkovku.

    Sdílený prohlížeč nefungoval: Tipsport a Chance (stejné F5) se stejným fingerprintem souběžně →
    Chance 403, se třemi sázkovkami se navigace i fetch zasekávaly (~0,8 GB RAM na sázkovku navíc).
    Navigace (capture, první otevření originu) je per sázkovka serializovaná zámkem; samotné fetch()
    uvnitř stránky běží souběžně (live poll nečeká na 13 prematch POSTů). Capture před navigací
    počká, až doběhnou rozjeté fetche, aby jim nezničil kontext stránky.
    """

    def __init__(self) -> None:
        self.browsers: dict[str, tuple[AsyncCamoufox, Any]] = {}
        self.pages: dict[str, Any] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.launch_locks: dict[str, asyncio.Lock] = {}
        self.inflight: dict[str, int] = {}
        self.idle_cond: dict[str, asyncio.Condition] = {}
        self.last_use: dict[str, float] = {}

    def lock(self, bk: str) -> asyncio.Lock:
        return self.locks.setdefault(bk, asyncio.Lock())

    def cond(self, bk: str) -> asyncio.Condition:
        return self.idle_cond.setdefault(bk, asyncio.Condition())

    async def wait_no_fetches(self, bk: str) -> None:
        c = self.cond(bk)
        async with c:
            await c.wait_for(lambda: self.inflight.get(bk, 0) == 0)

    async def ensure_browser(self, bk: str) -> Any:
        async with self.launch_locks.setdefault(bk, asyncio.Lock()):
            cur = self.browsers.get(bk)
            if cur is None or not cur[1].is_connected():
                log.info("%s: launching camoufox (headless=%s)", bk, HEADLESS)
                cm = AsyncCamoufox(
                    headless=HEADLESS,
                    os="windows",
                    locale="cs-CZ",
                    humanize=True,
                    block_images=True,
                )
                self.browsers[bk] = (cm, await cm.__aenter__())
                self.pages.pop(bk, None)
        return self.browsers[bk][1]

    async def page(self, bk: str) -> Any:
        self.last_use[bk] = time.monotonic()
        p = self.pages.get(bk)
        if p is not None and not p.is_closed():
            return p
        browser = await self.ensure_browser(bk)
        p = await browser.new_page()

        async def route(r: Any) -> None:
            if r.request.resource_type in BLOCK_ABORT_TYPES:
                await r.abort()
            else:
                await r.continue_()

        await p.route("**/*", route)
        self.pages[bk] = p
        return p

    async def capture(self, bk: str, q: dict[str, Any]) -> dict[str, Any]:
        rx = re.compile(q["match"])
        timeout_s = float(q.get("timeoutMs", 30_000)) / 1000
        min_n = int(q.get("minResponses", 1))
        async with self.lock(bk):
            await self.wait_no_fetches(bk)
            page = await self.page(bk)
            got: list[dict[str, Any]] = []
            pending: list[asyncio.Future] = []
            enough = asyncio.Event()

            async def grab(res: Any) -> None:
                try:
                    body = await res.text()
                except Exception:  # redirect / tělo už není k dispozici
                    return
                req = res.request
                try:
                    hdrs = await req.all_headers()
                except Exception:
                    hdrs = {}
                got.append({
                    "url": res.url,
                    "status": res.status,
                    "body": body[:MAX_BODY],
                    # pro pozdější replay přes /fetch (stejný požadavek, jaký poslala stránka)
                    "method": req.method,
                    "postData": req.post_data,
                    "requestHeaders": {k: v for k, v in hdrs.items() if replayable_header(k)},
                })
                if len(got) >= min_n:
                    enough.set()

            def on_response(res: Any) -> None:
                if rx.search(res.url):
                    pending.append(asyncio.ensure_future(grab(res)))

            page.on("response", on_response)
            try:
                nav_status = None
                url = q.get("url")
                if url and (q.get("reload") or page.url != url):
                    r = await page.goto(url, wait_until="domcontentloaded", timeout=timeout_s * 1000)
                    nav_status = r.status if r else None
                elif q.get("reload"):
                    r = await page.reload(wait_until="domcontentloaded", timeout=timeout_s * 1000)
                    nav_status = r.status if r else None
                try:
                    await asyncio.wait_for(enough.wait(), timeout_s)
                except asyncio.TimeoutError:
                    pass
                if q.get("settleMs"):
                    await asyncio.sleep(float(q["settleMs"]) / 1000)
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
                title = await page.title()
                return {
                    "responses": got,
                    "navStatus": nav_status,
                    "title": title,
                    "pageUrl": page.url,
                    "blocked": bool(BLOCK_TITLES.search(title)) or nav_status == 403,
                }
            finally:
                page.remove_listener("response", on_response)
                self.last_use[bk] = time.monotonic()

    async def fetch(self, bk: str, q: dict[str, Any]) -> dict[str, Any]:
        origin = q["origin"].rstrip("/")
        async with self.lock(bk):
            page = await self.page(bk)
            if not page.url.startswith(origin):
                await self.open_origin(page, origin, q)
            self.inflight[bk] = self.inflight.get(bk, 0) + 1
        try:
            init = {k: q[k] for k in ("method", "headers", "body", "credentials") if q.get(k) is not None}
            url = q["url"] if q["url"].startswith("http") else origin + q["url"]
            res = await page.evaluate(
                """async ({url, init, timeoutMs}) => {
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                    try {
                        const r = await fetch(url, {credentials: 'include', ...init, signal: ctrl.signal});
                        return {status: r.status, contentType: r.headers.get('content-type'), body: await r.text()};
                    } finally {
                        clearTimeout(timer);
                    }
                }""",
                {"url": url, "init": init, "timeoutMs": FETCH_TIMEOUT_MS},
            )
            res["body"] = res["body"][:MAX_BODY]
            return res
        finally:
            self.last_use[bk] = time.monotonic()
            c = self.cond(bk)
            async with c:
                self.inflight[bk] -= 1
                c.notify_all()

    async def open_origin(self, page: Any, origin: str, q: dict[str, Any]) -> None:
        await page.goto(origin + "/", wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        idle = q.get("idlePath")
        if not idle:
            return
        # Cloudflare JS (cookies) doběhne na plné stránce, pak se SPA sázkovky vymění za lehký
        # dokument stejného originu – fetch() má cookies, ale web neběží (≈ stovky MB RAM na stránku)
        try:
            await page.wait_for_load_state("load", timeout=15_000)
        except Exception:
            pass
        await asyncio.sleep(float(q.get("idleSettleMs", 4000)) / 1000)
        try:
            await page.goto(origin + idle, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        except Exception:
            # SPA někdy zdrží událost domcontentloaded, i když dokument už je načtený – pak stačí
            if not page.url.startswith(origin + idle):
                raise
            log.warning("%s: goto %s timed out, page already there – continuing", origin, idle)

    async def close(self, bk: str | None = None) -> None:
        """Zavře prohlížeč sázkovky (příště nová session/fingerprint); bez bk všechny."""
        for b in [bk] if bk else list(self.browsers):
            async with self.lock(b):
                await self.wait_no_fetches(b)
                self.pages.pop(b, None)
                cur = self.browsers.pop(b, None)
                if cur is not None:
                    try:
                        await cur[0].__aexit__(None, None, None)
                    except Exception as e:  # prohlížeč už mohl spadnout
                        log.warning("%s: close failed: %s", b, e)

    async def idle_watch(self) -> None:
        while True:
            await asyncio.sleep(30)
            now = time.monotonic()
            for bk in list(self.browsers):
                if now - self.last_use.get(bk, now) > IDLE_CLOSE_S:
                    log.info("%s: closing idle camoufox", bk)
                    await self.close(bk)


pool = Pool()


def handler(fn):
    async def wrapped(request: web.Request) -> web.Response:
        try:
            q = await request.json() if request.can_read_body else {}
            return web.json_response(await fn(q))
        except KeyError as e:
            return web.json_response({"error": f"missing field {e}"}, status=400)
        except Exception as e:
            log.exception("request failed")
            return web.json_response({"error": f"{type(e).__name__}: {e}"}, status=500)

    return wrapped


async def h_capture(q):
    return await pool.capture(q["bk"], q)


async def h_fetch(q):
    return await pool.fetch(q["bk"], q)


async def h_close(q):
    await pool.close(q.get("bk"))
    return {"ok": True}


async def h_health(_q):
    return {"running": bool(pool.browsers), "pages": sorted(pool.pages)}


async def on_startup(app: web.Application) -> None:
    app["idle"] = asyncio.create_task(pool.idle_watch())


async def on_cleanup(app: web.Application) -> None:
    app["idle"].cancel()
    await pool.close()


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(name)s %(levelname)s %(message)s")
    app = web.Application(client_max_size=4_000_000)
    app.add_routes([
        web.post("/capture", handler(h_capture)),
        web.post("/fetch", handler(h_fetch)),
        web.post("/close", handler(h_close)),
        web.get("/health", handler(h_health)),
    ])
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()