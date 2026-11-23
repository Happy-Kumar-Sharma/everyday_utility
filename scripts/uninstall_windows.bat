@echo off
rem Double-click to remove the Everyday Utility shortcuts (your data is kept). Option: -PurgeVenv also deletes .venv
rem Set EU_NO_PAUSE=1 to skip the final "Press any key" when running it from a terminal.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall_windows.ps1" %*
set "EU_RC=%ERRORLEVEL%"
if not defined EU_NO_PAUSE pause
endlocal & exit /b %EU_RC%
