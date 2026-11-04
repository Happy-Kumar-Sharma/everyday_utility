from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from . import summary as summary_mod
from . import wellbeing

SERVICE_ID = "home"

router = APIRouter()


class WaterChange(BaseModel):
    delta: Literal[1, -1] = 1


class StandupAction(BaseModel):
    action: Literal["done", "skip", "snooze"]
    minutes: int | None = Field(None, ge=1, le=240)


@router.get("/summary")
def summary():
    return summary_mod.summary()


# ---- wellbeing: screen time, water, standup ----------------------------------------------------------
@router.get("/wellbeing")
def get_wellbeing():
    return wellbeing.wellbeing()


@router.post("/screen/heartbeat")
def screen_heartbeat():
    """Browser fallback for screen time; ignored (accepted: false) while GNOME idle time is the source."""
    return wellbeing.heartbeat()


@router.post("/water")
def water(req: WaterChange):
    wellbeing.water_change(req.delta)
    return wellbeing.wellbeing()


@router.post("/standup")
def standup(req: StandupAction):
    wellbeing.standup_action(req.action, req.minutes)
    return wellbeing.wellbeing()
