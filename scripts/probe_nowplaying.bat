@echo off
setlocal
rem  Prints every Windows media session twice a second (see probe_nowplaying.py). Ctrl+C to stop.
cd /d "%~dp0.."
set "VPY=tools\align-env\Scripts\python.exe"
if not exist "%VPY%" goto :nosetup
set "PYTHONIOENCODING=utf-8"
"%VPY%" scripts\probe_nowplaying.py
pause
exit /b 0

:nosetup
echo Run scripts\setup_base.bat first, then scripts\setup_nowplaying.bat.
pause
exit /b 1
