@echo off
setlocal
rem ------------------------------------------------------------------
rem  Base install: a private Python environment in tools\align-env with
rem  just numpy (about 60 MB). That is enough for the page, the lyrics
rem  library, exporting video and "follow the player".
rem
rem  Optional extras, only when you want them:
rem    setup_lddc.bat       QQ / Kugou / NetEase lyrics search   (about 10 MB)
rem    setup_nowplaying.bat follow the desktop player            (a few MB)
rem    setup_whisper.bat    recognise lyrics from audio          (0.6 - 1.7 GB)
rem    setup_align.bat      word-by-word alignment of an LRC     (about 1 GB + models)
rem
rem  Needs Python 3.10 - 3.12 from python.org.
rem  Python libraries come from a mirror in China (Tsinghua, then Aliyun),
rem  falling back to the official PyPI.
rem ------------------------------------------------------------------
cd /d "%~dp0.."
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (where python >nul 2>nul && set "PY=python")
if not defined PY goto :nopy

set "VPY=tools\align-env\Scripts\python.exe"
if exist "%VPY%" goto :have
echo Creating tools\align-env ...
%PY% -m venv tools\align-env
if errorlevel 1 goto :fail
:have
set "PIPOPT=--timeout 30 --retries 2"
"%VPY%" -m pip install --upgrade pip %PIPOPT% -i https://pypi.tuna.tsinghua.edu.cn/simple >nul 2>nul

echo Installing numpy ...
"%VPY%" -m pip install %PIPOPT% -i https://pypi.tuna.tsinghua.edu.cn/simple numpy
if not errorlevel 1 goto :ok
"%VPY%" -m pip install %PIPOPT% -i https://mirrors.aliyun.com/pypi/simple/ numpy
if not errorlevel 1 goto :ok
"%VPY%" -m pip install %PIPOPT% numpy
if errorlevel 1 goto :fail

:ok
echo.
echo Base install finished. Double-click start_server.bat in the project folder to use the page.
echo The optional extras are listed at the top of this file; run the matching setup_*.bat when you want one.
if /i not "%~1"=="nopause" pause
exit /b 0

:nopy
echo Python was not found. Install Python 3.12 from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH" in the installer, then run this again.
if /i not "%~1"=="nopause" pause
exit /b 1

:fail
echo Setup failed. Take a screenshot of this window and send it to Claude.
if /i not "%~1"=="nopause" pause
exit /b 1
