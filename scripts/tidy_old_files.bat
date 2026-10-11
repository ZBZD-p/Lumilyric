@echo off
setlocal
rem ------------------------------------------------------------------
rem  One-time tidy-up after the folder layout changed (run once).
rem  Moves the old copies in the project folder (index.html, server.py,
rem  align_lrc.py, ... now living in web\, server\, scripts\) into
rem  _old_layout\ - nothing is deleted. Moves the Whisper model
rem  (ggml-*.bin) into models\.
rem  When everything works, you can delete _old_layout\ yourself.
rem ------------------------------------------------------------------
cd /d "%~dp0.."
if not exist "web\index.html" goto :wrongplace
if not exist "_old_layout" mkdir "_old_layout"
if not exist "models" mkdir "models"

for %%F in (index.html server.py align_lrc.py lddc_bridge.py cover_search.py setup_align.bat setup_lddc.bat transcribe.bat align.bat) do (
  if exist "%%F" (
    move /y "%%F" "_old_layout\" >nul && echo moved %%F to _old_layout\
  )
)
if exist "__pycache__" move /y "__pycache__" "_old_layout\__pycache__" >nul && echo moved __pycache__ to _old_layout\

for %%F in (ggml-*.bin) do (
  move /y "%%F" "models\" >nul && echo moved %%F to models\
)

echo.
echo Done. Double-click start_server.bat to check that everything works,
echo then delete the _old_layout folder if you like.
pause
exit /b 0

:wrongplace
echo This file must stay in the scripts folder of the new layout.
pause
exit /b 1
