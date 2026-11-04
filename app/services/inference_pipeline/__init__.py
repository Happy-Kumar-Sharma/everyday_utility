from app.core.registry import Service

from .router import SERVICE_ID, router
from .settings import SETTINGS

SERVICE = Service(
    id=SERVICE_ID,
    title="AI Inference Pipeline",
    description="Image ids → prod-to-local migration → export CSV → YoloV11 predictions → load → query results.",
    icon="🧠",
    order=20,
    router=router,
    settings=SETTINGS,
)
