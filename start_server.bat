@echo off
setlocal
rem ------------------------------------------------------------------
rem  Starts the local helper and opens the lyrics page in your browser.
rem  Recognition and alignment then run from the page itself.
rem  Keep this window open while you use the page; close it to stop.
rem ------------------------------------------------------------------
cd /d "%~dp0"
set "VPY=tools\align-env\Scripts\python.exe"
if not exist "%VPY%" goto :nosetup
set "HF_HOME=%~dp0tools\hf-cache"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
start "" "http://127.0.0.1:8765/"
"%VPY%" server\server.py
pause
exit /b 0

:nosetup
echo Run scripts\setup_base.bat first (one-time setup).
pause
exit /b 1
