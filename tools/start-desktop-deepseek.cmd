@echo off
rem Starts the Store Codex client with the self-built engine and the DeepSeek key.
rem Keep this window open while you use the client; closing it is fine after the client exits.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-desktop-deepseek.ps1"
echo.
echo (client exited)
pause
