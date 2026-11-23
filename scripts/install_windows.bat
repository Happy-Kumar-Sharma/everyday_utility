@echo off
rem Double-click to install Everyday Utility on Windows (Start menu + Desktop shortcuts, see install.md).
rem Options are passed on, e.g.:  install_windows.bat -Autostart     install_windows.bat -Wsl -Distro Ubuntu -RepoPath /home/me/everyday_utility
rem Set EU_NO_PAUSE=1 to skip the final "Press any key" when running it from a terminal.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1" %*
set "EU_RC=%ERRORLEVEL%"
if not defined EU_NO_PAUSE pause
endlocal & exit /b %EU_RC%
