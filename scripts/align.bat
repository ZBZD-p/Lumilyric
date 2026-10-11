@echo off
setlocal
rem ------------------------------------------------------------------
rem  Select an audio file AND its .lrc, drag both onto this file.
rem  Writes <lrc name>.aligned.lrc (one timestamp per character).
rem ------------------------------------------------------------------
cd /d "%~dp0.."
set "VPY=tools\align-env\Scripts\python.exe"
if not exist "%VPY%" goto :nosetup

rem keep the 1.2 GB model inside this folder instead of drive C:
set "HF_HOME=%~dp0tools\hf-cache"
set "PYTHONIOENCODING=utf-8"

rem Read the dropped files one by one. No parenthesised blocks here: Explorer passes paths
rem without quotes when they have no spaces, and a ")" in a file name would break them.
set "AUDIO="
set "LRC="
:args
if "%~1"=="" goto :args_done
if /i "%~x1"==".lrc" set "LRC=%~f1"
if /i not "%~x1"==".lrc" set "AUDIO=%~f1"
shift
goto :args
:args_done
if not defined AUDIO goto :usage
if not defined LRC goto :usage

"%VPY%" server\align_lrc.py "%AUDIO%" "%LRC%"
if errorlevel 1 goto :fail
echo.
echo Load the .aligned.lrc file in the lyrics page with the LRC button.
pause
exit /b 0

:usage
echo Select the audio file and the .lrc file together, then drag both onto align.bat
pause
exit /b 1

:nosetup
echo Run scripts\setup_align.bat first.
pause
exit /b 1

:fail
echo Something went wrong. Take a screenshot of this window and send it to Claude.
pause
exit /b 1
