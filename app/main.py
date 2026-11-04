"""FastAPI entry point: wires the core API, discovered services and the static frontend."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .core import config, context
from .core.api import router as core_router
from .core.registry import discover_services

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# header the frontend sends on every state-changing request; a custom header cannot be sent cross-origin
# without a CORS preflight (which this app never grants), so other websites can't trigger jobs here
CSRF_HEADER = "x-everyday-utility"


class NoCacheStaticFiles(StaticFiles):
    """Always revalidate (cheap ETag check on localhost) so edited JS/CSS is picked up on a normal reload."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.ensure_dirs()
    yield
    context.jobs.shutdown()


def create_app() -> FastAPI:
    app = FastAPI(title="Everyday Utility", lifespan=lifespan)
    # blocks DNS-rebinding: only requests addressed to this machine are served
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])

    @app.middleware("http")
    async def require_csrf_header(request: Request, call_next):
        if request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/"):
            if request.headers.get(CSRF_HEADER) != "1":
                return JSONResponse({"detail": "missing request header"}, status_code=403)
        return await call_next(request)

    app.include_router(core_router)
    context.failed_services.clear()
    for service in discover_services(failed=context.failed_services):
        context.services[service.id] = service
        app.include_router(service.router, prefix=f"/api/{service.id}", tags=[service.title])

    app.mount("/static", NoCacheStaticFiles(directory=config.WEB_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(config.WEB_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
