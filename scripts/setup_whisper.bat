@echo off
setlocal enabledelayedexpansion
rem ------------------------------------------------------------------
rem  OPTIONAL extra: recognise lyrics from audio (Whisper, the "no lyrics:
rem  recognise them" choice in the page). Downloads
rem    1. the audio converter (imageio-ffmpeg, about 85 MB)
rem    2. whisper.cpp (GPU/CUDA build about 670 MB, or CPU build 21 MB)
rem    3. one model (574 MB or 1.08 GB)
rem  Not needed for the page, the lyrics library, export or "follow the
rem  player". Everything is downloaded with curl and can be resumed: run
rem  the script again if it was interrupted.
rem
rem  Set LRC_SETUP_DRYRUN=1 to only print what would be done; LRC_SETUP_BUILD=1|2 and
rem  LRC_SETUP_MODEL=1|2 answer the two questions in advance.
rem ------------------------------------------------------------------
cd /d "%~dp0.."
set "VPY=tools\align-env\Scripts\python.exe"
if not defined LRC_SETUP_DRYRUN (
  if not exist "%VPY%" call "%~dp0setup_base.bat" nopause
  if not exist "%VPY%" goto :fail
)

set "PIPOPT=--timeout 30 --retries 2"
echo.
echo [1/3] Audio converter ...
if defined LRC_SETUP_DRYRUN (
  echo   would run: pip install imageio-ffmpeg
) else (
  "%VPY%" -m pip install %PIPOPT% -i https://pypi.tuna.tsinghua.edu.cn/simple imageio-ffmpeg
  if errorlevel 1 "%VPY%" -m pip install %PIPOPT% -i https://mirrors.aliyun.com/pypi/simple/ imageio-ffmpeg
  if errorlevel 1 "%VPY%" -m pip install %PIPOPT% imageio-ffmpeg
  if errorlevel 1 goto :fail
)

echo.
echo [2/3] Which recognition program?
echo   1  GPU, NVIDIA card with CUDA 12 (download about 670 MB, fast)
echo   2  CPU (download 21 MB, works everywhere, a few minutes per song)
set "BUILD=1"
if defined LRC_SETUP_BUILD (set "BUILD=%LRC_SETUP_BUILD%") else set /p "BUILD=Choose 1 or 2 [1]: "
if "%BUILD%"=="2" (
  set "ZIP=whisper-blas-bin-x64.zip"
) else (
  set "ZIP=whisper-cublas-12.4.0-bin-x64.zip"
)
set "REL=https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2"
if not exist tools mkdir tools
if exist "tools\%ZIP%" (echo   tools\%ZIP% is already there.) else (
  call :get "%REL%/%ZIP%" "https://ghfast.top/%REL%/%ZIP%" "tools\%ZIP%"
  if errorlevel 1 goto :fail
)

echo.
echo [3/3] Which model?
echo   1  large-v3-turbo q5  (574 MB, recommended: fast, nearly as accurate)
echo   2  large-v3 q5        (1.08 GB, the most accurate)
set "MODEL=1"
if defined LRC_SETUP_MODEL (set "MODEL=%LRC_SETUP_MODEL%") else set /p "MODEL=Choose 1 or 2 [1]: "
if "%MODEL%"=="2" (
  set "MFILE=ggml-large-v3-q5_0.bin"
) else (
  set "MFILE=ggml-large-v3-turbo-q5_0.bin"
)
set "HF=https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
set "HFM=https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main"
if not exist models mkdir models
if exist "models\%MFILE%" (echo   models\%MFILE% is already there.) else (
  call :get "%HF%/%MFILE%" "%HFM%/%MFILE%" "models\%MFILE%"
  if errorlevel 1 goto :fail
)

echo.
echo Recognition extra installed. Close the black start_server.bat window and open it again;
echo "auto recognise" in the page then works (the program is unpacked on first use).
if not defined LRC_SETUP_DRYRUN pause
exit /b 0

:get
rem  :get <url> <fallback url> <target file>   (resumable, tries the first address, then the mirror)
set "PART=%~3.part"
if defined LRC_SETUP_DRYRUN (
  echo   would download %~1  ^(fallback %~2^)  to %~3
  exit /b 0
)
echo   downloading %~nx3 ...
curl.exe -L --fail --connect-timeout 15 --retry 3 -C - -o "%PART%" "%~1"
if errorlevel 1 (
  echo   first address failed, trying the mirror ...
  curl.exe -L --fail --connect-timeout 15 --retry 3 -C - -o "%PART%" "%~2"
  if errorlevel 1 exit /b 1
)
move /y "%PART%" "%~3" >nul
exit /b 0

:fail
echo Setup failed. Take a screenshot of this window and send it to Claude.
if not defined LRC_SETUP_DRYRUN pause
exit /b 1
