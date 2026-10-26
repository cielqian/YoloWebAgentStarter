@echo off
rem YoloWebAgentStarter Windows launcher (equivalent of run-all.sh).
rem First run auto-creates .venv and installs dependencies, then starts the
rem backend and frontend in two dedicated windows (close a window to stop it).
rem NOTE: keep this file ASCII-only; cmd.exe parses batch files with the ANSI
rem codepage and non-ASCII bytes can break quote pairing on Chinese Windows.
setlocal EnableExtensions
cd /d "%~dp0"

rem ---- configuration (defaults match run-backend.sh; override via env) ----
if not defined YWA_HOST set "YWA_HOST=127.0.0.1"
if not defined YWA_PORT set "YWA_PORT=8000"
rem Use CN mirrors for dependency installs (direct pypi/npmjs access times out).
set "PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple"
set "NPM_REGISTRY=https://registry.npmmirror.com"
rem Keep Ultralytics / Matplotlib runtime caches out of the repo directory.
if not defined YOLO_CONFIG_DIR set "YOLO_CONFIG_DIR=%TEMP%\ultralytics"
if not defined MPLCONFIGDIR set "MPLCONFIGDIR=%TEMP%\matplotlib"

echo ================================================
echo   YoloWebAgentStarter
echo   Backend : http://%YWA_HOST%:%YWA_PORT%   (docs: /docs)
echo   Frontend: http://127.0.0.1:5173
echo ================================================
echo.

rem ---- check Node.js ----
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found. Install Node.js 20+ from https://nodejs.org/
    pause
    exit /b 1
)

rem ---- backend venv and dependencies ----
if not exist ".venv\Scripts\python.exe" (
    echo [SETUP] Creating .venv with Python 3.12 ...
    py -3.12 -m venv .venv 2>nul || python -m venv .venv
)
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] venv creation failed. Install Python 3.12 with the py launcher:
    echo         https://www.python.org/downloads/
    pause
    exit /b 1
)
if not exist ".venv\Scripts\uvicorn.exe" (
    echo [SETUP] Installing backend dependencies via mirror, first run takes a few minutes ...
    ".venv\Scripts\python.exe" -m pip install -r backend\requirements.txt -i %PIP_INDEX%
    if errorlevel 1 (
        echo [ERROR] Backend dependency install failed. Check pip output above.
        pause
        exit /b 1
    )
)

rem ---- frontend dependencies ----
if not exist "frontend\node_modules\vite" (
    echo [SETUP] Installing frontend dependencies via mirror, first run takes a few minutes ...
    call npm --prefix frontend install --registry=%NPM_REGISTRY%
    if errorlevel 1 (
        echo [ERROR] Frontend dependency install failed. Check npm output above.
        pause
        exit /b 1
    )
)

rem ---- start services (closing a window stops that service) ----
echo [START] backend window (YWA-Backend) ...
start "YWA-Backend" cmd /k "set PYTHONPATH=backend&& .venv\Scripts\python.exe -m uvicorn app.main:app --host %YWA_HOST% --port %YWA_PORT%"

echo [START] frontend window (YWA-Frontend) ...
start "YWA-Frontend" cmd /k "npm --prefix frontend run dev"

echo Waiting for the frontend, then opening the browser ...
%SystemRoot%\System32\timeout.exe /t 5 /nobreak >nul
start "" "http://127.0.0.1:5173"

echo.
echo Both services run in windows titled YWA-Backend / YWA-Frontend.
echo Stop a service by closing its window. This launcher window can be closed.
endlocal
