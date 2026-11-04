"""Per-service settings persisted as JSON under data/settings/<service_id>.json."""

from __future__ import annotations

import json
from pathlib import Path

from .registry import Service, SettingField


def _coerce(f: SettingField, value):
    if value is None:
        return f.default
    if f.type == "bool":
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if f.type == "int":
        return int(value)
    if f.type == "float":
        return float(value)
    return str(value)


class SettingsStore:
    def __init__(self, root: Path):
        self.root = root

    def _path(self, service_id: str) -> Path:
        return self.root / f"{service_id}.json"

    def load(self, service: Service) -> dict:
        values = service.defaults()
        path = self._path(service.id)
        if path.exists():
            saved = json.loads(path.read_text())
            # only known keys survive, so renamed/removed settings don't linger
            values.update({k: v for k, v in saved.items() if k in values})
        return values

    def merge(self, service: Service, overrides: dict | None) -> dict:
        """Saved settings with per-request overrides applied, coerced to their declared types."""
        values = self.load(service)
        fields = {f.key: f for f in service.settings}
        for key, value in (overrides or {}).items():
            if key in fields:
                values[key] = _coerce(fields[key], value)
        return values

    def save(self, service: Service, values: dict) -> dict:
        merged = self.merge(service, values)
        self.root.mkdir(parents=True, exist_ok=True)
        self._path(service.id).write_text(json.dumps(merged, indent=2))
        return merged

    def reset(self, service: Service) -> dict:
        self._path(service.id).unlink(missing_ok=True)
        return service.defaults()
