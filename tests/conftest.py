"""Every test run gets its own throwaway data folder.

Set before any app module is imported, so paths computed at import time (planner store, manager repo list,
job logs, audit log …) all point into the temp folder and tests can never write to the real data/.
"""

import os
import tempfile

os.environ["EU_DATA_DIR"] = tempfile.mkdtemp(prefix="eu-test-data-")
os.environ.pop("EU_REMOTE_HOSTS", None)  # remote/login mode is opted into per test only
