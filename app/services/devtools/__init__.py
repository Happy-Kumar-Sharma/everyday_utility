"""🛠 Dev Tools tab: 32 small developer utilities.

Almost every tool runs in the browser (web/js/services/devtools.js + devtools/tools/*.js), so nothing typed
there reaches the server. Exceptions, each in its own module: YAML ⇄ JSON (yaml_api.py, PyYAML, local only)
and the API tester (api_proxy.py, which sends the request from the server to avoid browser CORS limits).
The backend also answers global search with the matching tools.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.core.registry import Service

from .api_proxy import router as api_router
from .yaml_api import router as yaml_router

router = APIRouter()
router.include_router(yaml_router)
router.include_router(api_router)

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
    # pipeline & data
    "bbox": ("Box / polygon viewer", "🔲", "Draw boxes & polygons on an image, convert formats, IoU", "bbox bounding box polygon iou xyxy xywh yolo coco normalize prediction damage draw"),
    "jsonl": ("JSONL inspector", "📜", "Lines, keys, bad lines, extract a field, filter", "jsonl ndjson json lines predictions inspect field extract filter csv"),
    "sql": ("SQL format + IN list", "🗄️", "Pretty-print / minify SQL, build IN (...) lists", "sql format pretty minify beautify query in list ids postgres"),
    "csv": ("CSV ⇄ JSON / INSERT", "📊", "CSV to JSON, Markdown table, INSERT / COPY and back", "csv tsv json markdown table insert copy sql convert"),
    "s3": ("S3 path", "🪣", "s3:// ⇄ https URLs, bucket / key / region", "s3 aws bucket key path url arn object"),
    "cron": ("Cron helper", "⏰", "Explain a cron expression, next run times, build one", "cron crontab schedule expression next run every"),
    "env": (".env converter", "🧾", ".env ⇄ export ⇄ JSON ⇄ docker -e flags", "env dotenv export variables json docker environment"),
    # formats
    "yaml": ("YAML ⇄ JSON", "📐", "Convert and validate YAML (Helm, k8s)", "yaml yml json convert validate helm kubernetes k8s"),
    "markdown": ("Markdown preview", "📝", "Live preview, copy HTML", "markdown md preview readme render"),
    # encode & secrets
    "password": ("Password generator", "🔑", "Passwords & passphrases with a strength meter", "password passphrase secret generate random strength token"),
    "unicode": ("Unicode inspector", "🔍", "Reveal hidden chars, BOM, CRLF, zero-width", "unicode hidden invisible zero width bom crlf whitespace codepoint"),
    # time & numbers
    "duration": ("Duration calculator", "⏳", "Time between dates, add / subtract durations", "duration diff between dates add subtract time span log timestamp"),
    "units": ("Number & unit converter", "🔢", "hex / dec / bin, bytes KB MB GB, time units", "number base hex binary octal decimal bytes kb mb gb units convert"),
    "chmod": ("chmod calculator", "🛡️", "rwxr-x--- ⇄ 750, special bits", "chmod permissions unix octal rwx umask"),
    # generate
    "fake": ("Fake data", "🎲", "Names, emails, dates… as CSV / JSON / SQL", "fake data mock test fixture generate names emails csv"),
    "qr": ("QR code", "▦", "Text or URL to QR (PNG / SVG)", "qr qrcode code phone link generate"),
    "color": ("Color", "🎨", "Picker, hex / rgb / hsl, contrast check", "color colour hex rgb hsl contrast wcag picker palette"),
    # web & ops
    "http": ("HTTP reference", "📖", "Status codes and headers, searchable", "http status code header reference 404 500 cors cache"),
    "curl": ("curl converter", "🌀", "curl ⇄ fetch / Python requests", "curl fetch python requests convert command http"),
    "api": ("API tester", "📡", "Send requests, save them to the Library", "api http request rest tester postman get post headers"),
    "docker": ("Docker / kubectl builder", "🐳", "Build docker run / kubectl commands from a form", "docker kubectl kubernetes run command ports volumes env"),
    "image": ("Image tool", "🖼️", "EXIF, resize / crop, data URL", "image exif metadata resize crop data url base64 png jpeg"),
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
