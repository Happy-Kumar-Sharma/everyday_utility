"""FastAPI entry point: wires the core API, discovered services and the static frontend."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from urllib.parse import urlencode

from fastapi import FastAPI, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .core import auth, config, context
from .core.api import router as core_router
from .core.registry import discover_services

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# header the frontend sends on every state-changing request; a custom header cannot be sent cross-origin
# without a CORS preflight (which this app never grants), so other websites can't trigger jobs here
CSRF_HEADER = "x-everyday-utility"
# reachable on a remote host without a session: the login page, its stylesheet and the login API
PUBLIC_PATHS = {("GET", "/login"), ("GET", "/static/css/app.css"), ("GET", "/api/auth/status"),
                ("POST", "/api/auth/login")}


class NoCacheStaticFiles(StaticFiles):
    """Always revalidate (cheap ETag check on localhost) so edited JS/CSS is picked up on a normal reload."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.ensure_dirs()
    for service in context.services.values():
        if service.startup:
            try:
                service.startup()
            except Exception:  # noqa: BLE001
                logging.getLogger(__name__).exception("startup hook of %s failed", service.id)
    yield
    for service in context.services.values():
        if service.shutdown:
            try:
                service.shutdown()
            except Exception:  # noqa: BLE001
                logging.getLogger(__name__).exception("shutdown hook of %s failed", service.id)
    context.jobs.shutdown()


def create_app() -> FastAPI:
    app = FastAPI(title="Everyday Utility", lifespan=lifespan)

    @app.middleware("http")
    async def require_csrf_header(request: Request, call_next):
        if (request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/")
                and request.url.path != "/api/auth/login"):  # login does its own checks
            if request.headers.get(CSRF_HEADER) != "1":
                return JSONResponse({"detail": "missing request header"}, status_code=403)
        return await call_next(request)

    @app.middleware("http")
    async def require_login_for_remote(request: Request, call_next):
        # the server binds to loopback, so a remote Host only arrives via a local proxy (tailscale serve)
        if not auth.is_remote(request):
            return await call_next(request)
        is_api = request.url.path.startswith("/api/")
        if not auth.password_set():
            if is_api:
                return JSONResponse({"detail": auth.SET_PASSWORD_HINT}, status_code=503)
            return PlainTextResponse(auth.SET_PASSWORD_HINT, status_code=503)
        method = "GET" if request.method == "HEAD" else request.method
        if (method, request.url.path) in PUBLIC_PATHS or auth.valid_session(request.cookies.get(auth.COOKIE)):
            return await call_next(request)
        if is_api or method != "GET":
            return JSONResponse({"detail": "login required"}, status_code=401)
        target = request.url.path + (f"?{request.url.query}" if request.url.query else "")
        return RedirectResponse(f"/login?{urlencode({'next': target})}", status_code=302)

    # added last = runs first: unknown hosts are refused before anything else (blocks DNS rebinding)
    app.add_middleware(TrustedHostMiddleware,
                       allowed_hosts=[*sorted(auth.LOCAL_HOSTS), "[::1]", *config.REMOTE_HOSTS])

    app.include_router(auth.router)
    app.include_router(core_router)
    context.failed_services.clear()
    for service in discover_services(failed=context.failed_services):
        context.services[service.id] = service
        app.include_router(service.router, prefix=f"/api/{service.id}", tags=[service.title])

    app.mount("/static", NoCacheStaticFiles(directory=config.WEB_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(config.WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/login", include_in_schema=False)
    def login_page():
        return FileResponse(config.WEB_DIR / "login.html", headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
