from app.core.registry import SettingField

SETTINGS = (
    SettingField("repo_dir", "Sync repo folder", "~/workspace/your-sync-repo", "path",
                 "The folder with the two scripts and their .env (the scripts run from here).", "Sync"),
    SettingField("python", "Python interpreter", "python3", "text",
                 "The interpreter that has the scripts' packages (a name on PATH or a full path, e.g. a venv's bin/python).",
                 "Sync"),
    SettingField("sync_script", "Step 1 script (prod → staging)", "utilities-og.py", "text",
                 "Relative to the repo folder; run as: <script> sync_ids --ids … [--reupload]", "Sync"),
    SettingField("lookup_script", "Step 2 script (staging lookup)", "lookup_staging_assessments.py", "text",
                 "Relative to the repo folder; run as: <script> --ids … --timeout N --output file.csv", "Sync"),
    SettingField("lookup_timeout", "Lookup timeout (s)", 10, "int",
                 "Passed as --timeout to the lookup script (staging DB connection timeout).", "Sync"),
    SettingField("prod_probe", "Prod probe (host:port)", "", "text",
                 "Optional. A host:port that is only reachable on the PROD VPN (e.g. a database host). Empty = skip. "
                 "Current VPN interfaces are listed in the tab's status strip.", "VPN check"),
    SettingField("staging_probe", "Staging probe (host:port)", "", "text",
                 "Optional. A host:port that is only reachable on the STAGING VPN. Empty = skip.", "VPN check"),
)
