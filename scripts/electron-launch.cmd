@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
"%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0.." %*
