@echo off
setlocal
rem ------------------------------------------------------------------
rem  Drag an audio file (mp3 / wav / flac / ogg) onto this file.
rem  Runs whisper.cpp on the CPU and writes <audio name>.json next to
rem  the audio file, ready to load into index.html.
rem ------------------------------------------------------------------
cd /d "%~dp0.."

rem Use the best model found in models\ (or, as before, the project folder). First match wins.
set "MODEL="
set "DTW="
for %%M in (ggml-large-v3-q5_0.bin ggml-large-v3.bin ggml-large-v2-q5_0.bin ggml-large-v3-turbo-q5_0.bin) do if not defined MODEL if exist "models\%%M" set "MODEL=models\%%M"
if defined MODEL for %%M in ("%MODEL%") do set "MNAME=%%~nxM"
if defined MODEL set "DTW=large.v3"
if "%MNAME%"=="ggml-large-v2-q5_0.bin" set "DTW=large.v2"
if "%MNAME%"=="ggml-large-v3-turbo-q5_0.bin" set "DTW=large.v3.turbo"
if exist "ggml-large-v3-q5_0.bin" if not defined MODEL set "MODEL=models\ggml-large-v3-q5_0.bin" & set "DTW=large.v3"
if exist "ggml-large-v3.bin" if not defined MODEL set "MODEL=ggml-large-v3.bin" & set "DTW=large.v3"
if exist "ggml-large-v2-q5_0.bin" if not defined MODEL set "MODEL=ggml-large-v2-q5_0.bin" & set "DTW=large.v2"
if exist "ggml-large-v3-turbo-q5_0.bin" if not defined MODEL set "MODEL=ggml-large-v3-turbo-q5_0.bin" & set "DTW=large.v3.turbo"
if not defined MODEL set "MODEL=models\ggml-large-v3-q5_0.bin"
rem Prefer the NVIDIA CUDA build when its zip (or unpacked folder) is here, else the CPU build.
set "ZIP=whisper-blas-bin-x64.zip"
set "DIR=tools\whisper"
set "DEVICE=CPU"
if exist "whisper-cublas-12.4.0-bin-x64.zip" set "ZIP=whisper-cublas-12.4.0-bin-x64.zip" & set "DIR=tools\whisper-cuda" & set "DEVICE=GPU (CUDA)"
if exist "tools\whisper-cuda\whisper-cli.exe" set "DIR=tools\whisper-cuda" & set "DEVICE=GPU (CUDA)"
set "CLI=%DIR%\whisper-cli.exe"

if exist "%CLI%" goto :have_cli
if not exist "%ZIP%" goto :no_zip
echo Unpacking %ZIP% ...
powershell -NoProfile -Command "Expand-Archive -Force '%ZIP%' 'tools\whisper-tmp'"
if errorlevel 1 goto :fail
move "tools\whisper-tmp\Release" "%DIR%" >nul
rmdir /s /q "tools\whisper-tmp"
if not exist "%CLI%" goto :fail
:have_cli

if not exist "%MODEL%" goto :no_model
if "%~1"=="" goto :usage

set "WLANG=auto"
set /p WLANG=Language - zh / en / auto, press Enter for auto: 

echo.
echo Model: %MODEL%   Device: %DEVICE%
echo Transcribing "%~nx1" ...
rem No VAD: with VAD on, this whisper.cpp build skips DTW and drops sung parts that have loud backing music.
rem -nfa: DTW timestamps only work with flash attention turned off.
"%CLI%" -m "%MODEL%" -f "%~1" -l %WLANG% -t %NUMBER_OF_PROCESSORS% -nfa --dtw %DTW% -ml 1 -sow -ojf -of "%~dpn1"
if errorlevel 1 goto :fail

:done
echo.
echo Done: "%~dpn1.json"
echo Load this JSON in the lyrics page with the Whisper button.
pause
exit /b 0

:usage
echo Drag an audio file - mp3, wav, flac or ogg - onto transcribe.bat
pause
exit /b 1

:no_zip
echo No whisper.cpp zip was found in the project folder.
pause
exit /b 1

:no_model
echo Model file %MODEL% was not found in the models folder.
pause
exit /b 1

:fail
echo Something went wrong. Take a screenshot of this window and send it to Claude.
pause
exit /b 1
