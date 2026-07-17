@echo off
setlocal
cd /d "%~dp0"

curl.exe --silent --fail --max-time 2 http://localhost:7777/api/health 2>nul | findstr /c:"rocketman" >nul
if not errorlevel 1 (
  echo Rocketman is already running at http://localhost:7777
  if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" "http://localhost:7777"
  ) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" "http://localhost:7777"
  ) else (
    echo Chrome was not found. Open http://localhost:7777 manually in Chrome.
  )
  exit /b 0
)

node --watch server.js
