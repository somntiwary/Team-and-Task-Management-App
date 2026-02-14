@echo off
echo Starting Saralta...
echo.

start "Backend" cmd /k "cd /d "%~dp0backend" && pip install -r requirements.txt -q && uvicorn main:app --reload --host 0.0.0.0 --port 8000"
timeout /t 3 /nobreak >nul

start "Frontend" cmd /k "cd /d "%~dp0frontend" && python -m http.server 3000"
timeout /t 2 /nobreak >nul

echo.
echo Backend:  http://127.0.0.1:8000
echo Frontend: http://localhost:3000
echo.
echo Close the two terminal windows to stop the app.
pause
