"""Same-origin browser transport; the relay still owns every permission check."""
from __future__ import annotations

from pathlib import Path
import re
from urllib.parse import urlsplit

from aiohttp import web

from .models import RelayError


WEB_ROOT = Path(__file__).parent / "web_static"
PUBLIC_PATHS = {"/", "/favicon.svg"}
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; "
       "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
       "base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


class BrowserAccess:
    def __init__(self, service, origin):
        self.service = service
        self.origin = None
        if origin:
            self.configure(origin)

    def configure(self, origin):
        url = urlsplit(origin)
        if (url.scheme not in ("https", "http") or not url.hostname or url.username or url.password
                or url.path not in ("", "/") or url.query or url.fragment or url.port == 0
                or (url.scheme == "http" and url.hostname not in ("127.0.0.1", "localhost", "::1"))):
            raise ValueError("Browser origin must be HTTPS (HTTP only on loopback).")
        self.origin = f"{url.scheme}://{url.netloc.lower()}"

    @property
    def secure(self):
        return bool(self.origin and self.origin.startswith("https://"))

    @property
    def cookie_name(self):
        return "__Host-guildport_session" if self.secure else "guildport_session"

    def validate(self, request):
        if not self.origin:
            raise RelayError(404, "web_disabled", "Browser access is not configured.")
        origin = request.headers.get("Origin")
        # No wildcard CORS and no forwarded-header trust. Custom headers require
        # a preflight from other origins; mutations also require the exact Origin.
        if (request.headers.get("X-GuildPort-Client") != "web"
                or request.headers.get("Sec-Fetch-Site") not in (None, "same-origin")
                or (origin is not None and origin != self.origin)
                or (request.method not in ("GET", "HEAD") and origin != self.origin)):
            raise RelayError(403, "browser_origin", "Use the relay's own web interface.")
        request["session_token"] = request.cookies.get(self.cookie_name, "")

    def clear_cookie(self, response):
        response.set_cookie(self.cookie_name, "", max_age=0, path="/", secure=self.secure,
                            httponly=True, samesite="Strict")

    async def login(self, request):
        session = await self.service.login_session(request, default_device="Browser")
        self.service.store.revoke(request.get("session_token", ""))
        response = web.json_response({"user": session["user"], "expires_at": session["expires_at"]})
        # A session cookie: no token in JSON, URLs, localStorage or sessionStorage.
        response.set_cookie(self.cookie_name, session["token"], path="/", secure=self.secure,
                            httponly=True, samesite="Strict")
        return response

    async def logout(self, request):
        # Idempotent even if the session has expired; always clear the browser cookie.
        self.service.store.revoke(request.get("session_token", ""))
        response = web.json_response({"ok": True})
        self.clear_cookie(response)
        return response

    async def logout_all(self, request):
        response = await self.service.logout_all(request)
        self.clear_cookie(response)
        return response

    async def asset(self, request):
        if not self.origin:
            raise web.HTTPNotFound()
        if request.path == "/":
            path = WEB_ROOT / "index.html"
        elif request.path == "/favicon.svg":
            path = WEB_ROOT / "favicon.svg"
        else:
            name = request.match_info["name"]
            if not re.fullmatch(r"[A-Za-z0-9_-]+\.(?:js|css|svg)", name):
                raise web.HTTPNotFound()
            path = WEB_ROOT / "assets" / name
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path)

    def routes(self):
        service = self.service
        return [
            web.get("/", self.asset), web.get("/favicon.svg", self.asset),
            web.get("/assets/{name}", self.asset),
            web.post("/web-api/login", self.login), web.post("/web-api/logout", self.logout),
            web.post("/web-api/logout-all", self.logout_all), web.get("/web-api/me", service.me),
            web.get("/web-api/guilds", service.guilds),
            web.get("/web-api/guilds/{guild_id}/channels", service.channels),
            web.get("/web-api/channels/{channel_id}/messages", service.history),
            web.post("/web-api/channels/{channel_id}/messages", service.send),
            web.get("/web-api/channels/{channel_id}/events", service.events),
        ]
