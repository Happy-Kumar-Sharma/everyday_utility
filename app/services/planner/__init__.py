from app.core.registry import Service

from .router import SERVICE_ID, router
from .search import search

SERVICE = Service(
    id=SERVICE_ID,
    title="Planner",
    description="Tasks, checklists, reminders, repeating chores, a done log and daily notes. Quick add: “title #tag !high @tomorrow”.",
    icon="✅",
    order=5,
    router=router,
    background=True,  # reminders fire while any tab is open
    search=search,
)
