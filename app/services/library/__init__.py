from app.core import config
from app.core.registry import Service
from app.core.registry import SettingField as F

from .router import SERVICE_ID, router

SERVICE = Service(
    id=SERVICE_ID,
    title="Library",
    description="Your saved queries, commands, links and notes — real files in folders, with templates, favourites and card / list views.",
    icon="📚",
    order=8,
    router=router,
    settings=(
        F("library_dir", "Library folder", str(config.ROOT_DIR / "private" / "library"), "path",
          "collections are sub-folders, items are files; must be outside git or git-ignored", "Library"),
    ),
)
