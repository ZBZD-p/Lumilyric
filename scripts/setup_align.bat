@echo off
setlocal
rem ------------------------------------------------------------------
rem  OPTIONAL extra: word-by-word alignment of an LRC against the audio
rem  (the "auto recognise / align" window in the page, and align.bat).
rem  Installs CPU PyTorch, transformers and the audio converter into
rem  tools\align-env: about 1 GB. The alignment models themselves
rem  (Chinese 1.2 GB, English 360 MB) are downloaded the first time a
rem  song of that language is aligned, into tools\hf-cache.
rem
rem  Not needed for the page, the lyrics library, export or "follow the
rem  player". Run setup_base.bat first if this is a fresh folder (this
rem  script does it for you when the environment is missing).
rem ------------------------------------------------------------------
cd /d "%~dp0.."
set "VPY=tools\align-env\Scripts\python.exe"
if not exist "%VPY%" call "%~dp0setup_base.bat" nopause
if not exist "%VPY%" goto :fail

set "PIPOPT=--timeout 30 --retries 2"
echo.
echo Installing PyTorch (CPU build, about 200 MB) ...
"%VPY%" -m pip install %PIPOPT% torch --index-url https://download.pytorch.org/whl/cpu
if not errorlevel 1 goto :torchok
echo Trying the Tsinghua mirror ...
"%VPY%" -m pip install %PIPOPT% -i https://pypi.tuna.tsinghua.edu.cn/simple torch
if errorlevel 1 goto :fail
:torchok
echo.
echo Installing transformers, numpy, imageio-ffmpeg ...
"%VPY%" -m pip install %PIPOPT% -i https://pypi.tuna.tsinghua.edu.cn/simple transformers numpy imageio-ffmpeg
if not errorlevel 1 goto :ok
"%VPY%" -m pip install %PIPOPT% -i https://mirrors.aliyun.com/pypi/simple/ transformers numpy imageio-ffmpeg
if not errorlevel 1 goto :ok
"%VPY%" -m pip install %PIPOPT% transformers numpy imageio-ffmpeg
if errorlevel 1 goto :fail

:ok
echo.
echo Alignment extra installed. Close the black start_server.bat window and open it again.
pause
exit /b 0

:fail
echo Setup failed. Take a screenshot of this window and send it to Claude.
pause
exit /b 1
