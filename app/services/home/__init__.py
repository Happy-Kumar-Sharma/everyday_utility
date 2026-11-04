from app.core.registry import Service

from . import wellbeing
from .router import SERVICE_ID, router

SERVICE = Service(
    id=SERVICE_ID,
    title="Home",
    description="Today at a glance: screen time, water, standup, tasks, focus timer, reminders, jobs, backup, favourite library items and recent activity.",
    icon="🏠",
    order=0,
    router=router,
    settings=wellbeing.SETTINGS,
    # break / water / standup reminders and the browser screen-time heartbeat run whichever tab is open
    background=True,
    startup=wellbeing.start_sampler,
    shutdown=wellbeing.stop_sampler,
)
