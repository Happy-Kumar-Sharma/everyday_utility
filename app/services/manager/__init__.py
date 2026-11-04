from app.core.registry import Service
from app.core.registry import SettingField as F

from .router import SERVICE_ID, router

SERVICE = Service(
    id=SERVICE_ID,
    title="Manager",
    description="Logins (URL, username, password) in a local text file you choose, kept out of git + every repo's .env / credentials files.",
    icon="🔐",
    order=30,
    router=router,
    settings=(
        F("credentials_file", "Credentials file", "", "path",
          "plain-text file for logins; keep it outside git repos or git-ignored", "Credentials"),
        F("workspace_root", "Workspace folder", "~/workspace", "path", "where 'Scan for repos' looks", "Env files"),
        F("env_patterns", "File patterns", ".env,.env.*,*.env,*credentials*.sh,*_env.sh,env.sh", "text",
          "comma separated globs matched against file names", "Env files"),
        F("max_depth", "Search depth", 4, "int", "folder levels below each repo root to search", "Env files"),
    ),
)
