"""🛠 Dev Tools tab: JSON, diff, Base64, JWT, time, UUID, URL, regex, hash and text helpers.

Every tool runs in the browser (web/js/services/devtools.js), so nothing typed here reaches the server.
The backend only answers global search with the matching tools.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.core.registry import Service

router = APIRouter()

# key -> (title, icon, subtitle, keywords); keys match the tool keys in the frontend module
TOOLS: dict[str, tuple[str, str, str, str]] = {
    "json": ("JSON", "🧾", "Format, minify, validate, sort keys, diff", "json format pretty minify validate sort diff"),
    "diff": ("Text diff", "🔀", "Line diff, side-by-side or unified", "text diff compare lines lcs unified side"),
    "base64": ("Base64", "🔤", "Encode / decode, URL-safe, file to base64", "base64 b64 encode decode file urlsafe"),
    "jwt": ("JWT decoder", "🎫", "Header, payload, expiry (signature not verified)", "jwt token bearer decode claims exp"),
    "time": ("Time", "🕒", "Epoch ↔ date, timezones, relative", "time epoch unix timestamp date iso utc timezone"),
    "uuid": ("UUID", "🆔", "Generate v4 UUIDs", "uuid guid v4 random generate id"),
    "url": ("URL", "🔗", "Encode / decode, parse query params", "url uri encode decode percent query params parse"),
    "regex": ("Regex tester", "🧩", "Matches, groups, replace preview", "regex regexp regular expression match replace"),
    "hash": ("Hash", "#️⃣", "SHA-1 / 256 / 384 / 512 of text or file", "hash sha sha1 sha256 sha512 digest checksum"),
    "text": ("Text utilities", "✂️", "Case conversion, counts, sort / unique lines", "text case camel snake kebab count sort unique lines"),
}


def search(query: str) -> list[dict]:
    words = query.lower().split()
    results = []
    for key, (title, icon, subtitle, keywords) in TOOLS.items():
        haystack = f"{key} {title} {subtitle} {keywords}".lower()
        if all(w in haystack for w in words):
            results.append({"title": title, "subtitle": subtitle, "icon": icon, "ref": key})
    return results


SERVICE = Service(
    id="devtools", title="Dev Tools", icon="🛠", order=15, router=router, search=search,
    description="JSON, diff, Base64, JWT, epoch time, UUID, URL, regex, hashes and text helpers — all in the browser.",
)
