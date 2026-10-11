@echo off
setlocal
rem ------------------------------------------------------------------
rem  One-time setup: installs the Windows media-session (SMTC) libraries
rem  into tools\align-env, so the lyrics page can follow the song and
rem  position of QQ Music / NetEase / Kugou running on this PC.
rem  Needs setup_base.bat to have been run first. Download: a few MB.
rem ------------------------------------------------------------------
cd /d "%~dp0.."
set "VPY=tools\align-env\Scripts\python.exe"
if not exist "%VPY%" goto :nosetup

set "PKGS=winrt-runtime winrt-Windows.Media.Control winrt-Windows.Foundation winrt-Windows.Foundation.Collections winrt-Windows.Storage.Streams PyAudioWPatch"
set "PIPOPT=--timeout 30 --retries 2"

echo Installing media-session libraries (Tsinghua mirror) ...
"%VPY%" -m pip install %PIPOPT% -i https://pypi.tuna.tsinghua.edu.cn/simple %PKGS%
if not errorlevel 1 goto :ok
echo.
echo Trying the Aliyun mirror ...
"%VPY%" -m pip install %PIPOPT% -i https://mirrors.aliyun.com/pypi/simple/ %PKGS%
if not errorlevel 1 goto :ok
echo.
echo Trying the official PyPI ...
"%VPY%" -m pip install %PIPOPT% %PKGS%
if errorlevel 1 goto :fail

:ok
echo.
echo Done. Close the black start_server.bat window and open it again: the "follow the player" button appears in the page.
echo To check that your player is recognised first, run scripts\probe_nowplaying.bat
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
