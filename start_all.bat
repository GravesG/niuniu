@echo off
setlocal

set "ROOT_DIR=%~dp0"
set "TOOL_DIR=%ROOT_DIR%tool"
set "TTS_DIR=%ROOT_DIR%tts-service"
set "TOOL_PORT=5173"
set "TTS_PORT=8000"

if not exist "%TOOL_DIR%\server.js" (
  echo [ERROR] Cannot find tool\server.js
  pause
  exit /b 1
)

if not exist "%TTS_DIR%\tts_server.py" (
  echo [ERROR] Cannot find tts-service\tts_server.py
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not found in PATH.
  echo Install Node.js, then retry.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python is not found in PATH.
  echo Install Python, then retry.
  pause
  exit /b 1
)

if exist "%TTS_DIR%\requirements-tts.txt" (
  python -c "import fastapi, uvicorn, edge_tts" >nul 2>nul
  if errorlevel 1 (
    echo Installing TTS dependencies...
    python -m pip install -r "%TTS_DIR%\requirements-tts.txt"
    if errorlevel 1 (
      echo [ERROR] Failed to install TTS dependencies.
      pause
      exit /b 1
    )
  )
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%TOOL_PORT% .*LISTENING"') do (
  echo [INFO] Port %TOOL_PORT% is occupied by PID %%P, stopping it...
  taskkill /PID %%P /F >nul 2>nul
)

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%TTS_PORT% .*LISTENING"') do (
  echo [INFO] Port %TTS_PORT% is occupied by PID %%P, stopping it...
  taskkill /PID %%P /F >nul 2>nul
)

echo Starting Tool Service...
start "Niuniu Tool Service" /D "%TOOL_DIR%" cmd /k "node server.js"

echo Starting TTS Service...
start "Niuniu TTS Service" /D "%TTS_DIR%" cmd /k "python tts_server.py"

timeout /t 2 >nul
start "" "http://localhost:%TOOL_PORT%/?tts=http://127.0.0.1:%TTS_PORT%"

echo.
echo Services started.
echo Tool: http://localhost:%TOOL_PORT%
echo TTS : http://127.0.0.1:%TTS_PORT%
echo.
echo Close the two service windows to stop services.
pause
