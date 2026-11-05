from app.core.registry import Service

from .router import SERVICE_ID, router, search

SERVICE = Service(
    id=SERVICE_ID,
    title="Remote Jupyter",
    description="Connect over ssh (after the VPN), start JupyterLab in a conda env on the server and open it — "
                "through an ssh tunnel or directly.",
    icon="🪐",
    order=40,
    router=router,
    search=search,
)
