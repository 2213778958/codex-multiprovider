@echo off
rem One-click wrapper: double-click to patch and build the engine.
rem Extra arguments are passed through, e.g. install-engine.cmd -Profile debug
setlocal
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-engine.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo Installer failed with exit code %EXITCODE%. Read the message above for the reason.
) else (
  echo Installer finished successfully.
)
pause
exit /b %EXITCODE%
