@echo off
setlocal
rem ------------------------------------------------------------------
rem  Builds the desktop version into dist\Lumilyric (and a zip of it):
rem  a folder that runs on a PC without Python. See desktop\build.py.
rem  Close the desktop version first if it is open.
rem ------------------------------------------------------------------
cd /d "%~dp0.."
set "VPY=tools\align-env\Scripts\python.exe"
if not exist "%VPY%" goto :nosetup
"%VPY%" -X utf8 desktop\build.py
if errorlevel 1 goto :fail
pause
exit /b 0

:nosetup
echo Run scripts\setup_base.bat first.
pause
exit /b 1

:fail
echo Build failed. Take a screenshot of this window and send it to Claude.
pause
exit /b 1
