@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
set "ROCKETMAN_EXE=%LOCALAPPDATA%\Programs\Rocketman\Rocketman.exe"

if not exist "%ROCKETMAN_EXE%" (
  echo Rocketman Desktop is not installed.
  echo Run release\Rocketman Setup 0.1.0.exe first.
  exit /b 1
)

start "" "%ROCKETMAN_EXE%" %*
