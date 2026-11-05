@echo off
setlocal
cd /d "%~dp0"

if exist .venv\Scripts\activate.bat (
    call .venv\Scripts\activate.bat
)

for %%C in (python py python3) do (
    %%C --version >nul 2>nul
    if not errorlevel 1 (
        set "PY=%%C"
        goto found
    )
)

echo Error: Python not found. Please install Python 3.10+ and add it to your PATH.
exit /b 1

:found
if "%EU_HOST%"=="" set EU_HOST=127.0.0.1
if "%EU_PORT%"=="" set EU_PORT=8765

"%PY%" -m uvicorn app.main:app --host %EU_HOST% --port %EU_PORT% %*

