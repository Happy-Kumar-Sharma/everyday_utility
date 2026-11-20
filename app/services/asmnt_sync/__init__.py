from app.core.registry import Service

from .router import SERVICE_ID, router, search
from .settings import SETTINGS

SERVICE = Service(
    id=SERVICE_ID,
    title="Prod → Staging Sync",
    description="Sync assessments from PROD to STAGING (step 1, on the PROD VPN), then look up their staging "
                "assessment ids and OTPs (step 2, on the STAGING VPN).",
    icon="🔁",
    order=42,
    router=router,
    settings=SETTINGS,
    search=search,
)
