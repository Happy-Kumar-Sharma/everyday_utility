from app.core.registry import Service

from .router import router

SERVICE = Service(
    id="column-extractor",
    title="Column Extractor",
    description="Pick a CSV/Excel file and a column, get every value joined with the delimiter you want.",
    icon="📋",
    order=10,
    router=router,
)
