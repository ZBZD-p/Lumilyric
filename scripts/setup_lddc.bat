@echo off
setlocal
rem ------------------------------------------------------------------
rem  One-time setup: installs LDDC (github.com/chenmozhijin/LDDC, GPL-3.0)
rem  into tools\align-env, so the lyrics page can search QQ Music, Kugou
rem  and NetEase Cloud Music for word-by-word lyrics.
rem  Needs setup_base.bat to have been run first. Download: about 10 MB.
rem  LDDC's own window needs Qt (PySide6, 215 MB); its lyrics search does not,
rem  so Qt is left out: LDDC is installed without its dependency list and the
rem  libraries the search really uses are named here (server\qt_stub stands in for Qt).
rem  Python libraries come from a mirror in China (Tsinghua, then Aliyun),
rem  falling back to the official PyPI.
rem ------------------------------------------------------------------
cd /d "%~dp0.."
set "VPY=tools\align-env\Scripts\python.exe"
if not exist "%VPY%" goto :nosetup

set "LDDC_URL=https://github.com/chenmozhijin/LDDC/archive/refs/tags/v0.9.2.zip"
set "PIPOPT=--timeout 30 --retries 2"
set "DEPS=httpx[brotli,http2] diskcache pyaes charset-normalizer mutagen psutil"

echo Installing LDDC and its libraries (Tsinghua mirror) ...
"%VPY%" -m pip install %PIPOPT% -i https://pypi.tuna.tsinghua.edu.cn/simple %DEPS%
if not errorlevel 1 "%VPY%" -m pip install %PIPOPT% --no-deps -i https://pypi.tuna.tsinghua.edu.cn/simple "%LDDC_URL%"
if not errorlevel 1 goto :ok
echo.
echo Trying the Aliyun mirror ...
"%VPY%" -m pip install %PIPOPT% -i https://mirrors.aliyun.com/pypi/simple/ %DEPS%
if not errorlevel 1 "%VPY%" -m pip install %PIPOPT% --no-deps -i https://mirrors.aliyun.com/pypi/simple/ "%LDDC_URL%"
if not errorlevel 1 goto :ok
echo.
echo Trying GitHub through a mirror ...
"%VPY%" -m pip install %PIPOPT% --no-deps -i https://pypi.tuna.tsinghua.edu.cn/simple "https://ghfast.top/%LDDC_URL%"
if not errorlevel 1 goto :ok
echo.
echo Trying the official PyPI ...
"%VPY%" -m pip install %PIPOPT% %DEPS%
if not errorlevel 1 "%VPY%" -m pip install %PIPOPT% --no-deps "%LDDC_URL%"
if errorlevel 1 goto :fail

:ok
echo.
echo LDDC installed. Close start_server.bat if it is open and start it again,
echo then use the "QQ / Kugou / NetEase" tab in the lyrics library panel.
pause
exit /b 0

:nosetup
echo Run scripts\setup_base.bat first.
pause
exit /b 1

:fail
echo Install failed. Take a screenshot of this window and send it to Claude.
pause
exit /b 1
