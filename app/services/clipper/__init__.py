from app.core import config
from app.core.registry import Service
from app.core.registry import SettingField as F

from .clip import DEFAULTS
from .router import SERVICE_ID, router
from .search import search

SERVICE = Service(
    id=SERVICE_ID,
    title="Web Clipper",
    description="Paste any public web page URL: its content as Markdown plus every image, saved into a folder — "
                "however long the page is.",
    icon="🗞",
    order=45,
    router=router,
    search=search,
    settings=(
        F("clips_dir", "Clips folder", str(config.ROOT_DIR / "private" / "clips"), "path",
          "one sub-folder per clip; must be outside git or git-ignored", "Clipper"),
        F("user_agent", "User agent", DEFAULTS["user_agent"], "text", "sent with every request", "Clipper"),
        F("timeout_s", "Request timeout (s)", DEFAULTS["timeout_s"], "int", "", "Clipper"),
        F("max_html_mb", "Max page size (MB)", DEFAULTS["max_html_mb"], "int", "HTML as downloaded or rendered",
          "Clipper"),
        F("max_images", "Max images per clip", DEFAULTS["max_images"], "int", "skipped images are listed", "Clipper"),
        F("max_image_mb", "Max image size (MB)", DEFAULTS["max_image_mb"], "int", "", "Clipper"),
        F("image_workers", "Parallel image downloads", DEFAULTS["image_workers"], "int", "", "Clipper"),
        F("browser_wait_ms", "Browser render time (ms)", DEFAULTS["browser_wait_ms"], "int",
          "how long headless Chrome lets the page run scripts and lazy-load", "Clipper"),
    ),
)
