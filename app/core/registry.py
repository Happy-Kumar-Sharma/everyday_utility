"""Service registry.

Every package under ``app/services`` that exposes a module-level ``SERVICE`` is a tab in the UI.
To add a new utility, create ``app/services/<name>/__init__.py`` with a ``SERVICE = Service(...)`` and a
matching ``web/js/services/<id>.js`` exporting ``mount(container, ctx)``. Nothing else needs to change.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
import traceback
from dataclasses import dataclass, field

from fastapi import APIRouter

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class SettingField:
    """One user-editable setting, rendered by the generic settings panel in the UI."""

    key: str
    label: str
    default: str | int | float | bool
    type: str = "text"  # text | path | int | float | bool
    help: str = ""
    group: str = "General"


@dataclass(frozen=True)
class Service:
    id: str  # url-safe, also the name of the frontend module web/js/services/<id>.js
    title: str
    description: str
    router: APIRouter
    icon: str = "🧰"
    order: int = 100
    settings: tuple[SettingField, ...] = field(default_factory=tuple)
    # the frontend module's background(ctx) is started at page load, even before the tab is opened
    # (e.g. reminders); the module must then export `background`
    background: bool = False

    def defaults(self) -> dict:
        return {f.key: f.default for f in self.settings}

    def to_public(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "icon": self.icon,
            "background": self.background,
            "settings": [f.__dict__ for f in self.settings],
        }


def discover_services(package: str = "app.services", failed: list[dict] | None = None) -> list[Service]:
    """Import every service package. A package that fails to import is logged and reported in `failed`
    instead of taking the whole app down."""
    pkg = importlib.import_module(package)
    found: list[Service] = []
    for mod in pkgutil.iter_modules(pkg.__path__):
        if not mod.ispkg:
            continue
        try:
            module = importlib.import_module(f"{package}.{mod.name}")
        except Exception as e:
            log.exception("service %s failed to load", mod.name)
            if failed is not None:
                failed.append({"name": mod.name, "error": f"{type(e).__name__}: {e}",
                               "traceback": traceback.format_exc(limit=5)})
            continue
        service = getattr(module, "SERVICE", None)
        if isinstance(service, Service):
            found.append(service)
        else:
            log.warning("package %s has no SERVICE, skipped", mod.name)
    ids = [s.id for s in found]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise RuntimeError(f"duplicate service ids: {sorted(dupes)}")
    return sorted(found, key=lambda s: (s.order, s.title))
