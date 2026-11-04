"""Process-wide singletons shared by the core API and every service."""

from __future__ import annotations

from . import config
from .jobs import JobManager
from .registry import Service
from .settings_store import SettingsStore

jobs = JobManager(config.JOBS_DIR, max_lines=config.JOB_LOG_MEMORY_LINES)
settings = SettingsStore(config.SETTINGS_DIR)
services: dict[str, Service] = {}  # filled by app.main at startup
failed_services: list[dict] = []  # packages that raised on import, shown in the UI


def service_settings(service_id: str, overrides: dict | None = None) -> dict:
    """Saved settings of a service (defaults applied), with optional per-request overrides."""
    service = services.get(service_id)
    if service is None:
        raise KeyError(f"service '{service_id}' is not registered")
    return settings.merge(service, overrides)
