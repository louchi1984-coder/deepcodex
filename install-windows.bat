@echo off
setlocal
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\install-deepcodex.ps1" %*
set "code=%ERRORLEVEL%"
echo.
if "%code%"=="0" (
  echo DeepCodex install finished.
  echo You can launch DeepCodex from the desktop shortcut or Start Menu.
) else (
  echo DeepCodex install failed with exit code %code%.
)
echo.
if "%~1"=="" pause
exit /b %code%
