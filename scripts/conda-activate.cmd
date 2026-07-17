@echo off
setlocal

if "%~1"=="" (
  echo Usage: conda-activate.cmd ENV_NAME
  exit /b 2
)

set "ENV_NAME=%~1"
set "CONDA_BAT="

for %%P in (
  "%USERPROFILE%\anaconda3\condabin\conda.bat"
  "%USERPROFILE%\miniconda3\condabin\conda.bat"
  "%USERPROFILE%\AppData\Local\anaconda3\condabin\conda.bat"
  "%USERPROFILE%\AppData\Local\miniconda3\condabin\conda.bat"
  "C:\ProgramData\anaconda3\condabin\conda.bat"
  "C:\ProgramData\miniconda3\condabin\conda.bat"
) do (
  if not defined CONDA_BAT if exist "%%~P" set "CONDA_BAT=%%~P"
)

if not defined CONDA_BAT (
  for /f "delims=" %%P in ('where conda.bat 2^>nul') do (
    if not defined CONDA_BAT set "CONDA_BAT=%%P"
  )
)

if not defined CONDA_BAT (
  echo Conda was not found. Install Anaconda/Miniconda or add conda.bat to PATH.
  exit /b 1
)

endlocal & call "%CONDA_BAT%" activate "%ENV_NAME%"
