@echo off
rem m5e installer for Windows. Double-click it.
cd /d "%~dp0"
echo.
echo === m5e setup ===

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo Installing ffmpeg...
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
)
where python >nul 2>nul
if errorlevel 1 (
  echo Installing Python...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
)
where ffmpeg >nul 2>nul
if errorlevel 1 goto restart
where python >nul 2>nul
if errorlevel 1 goto restart

python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if errorlevel 1 (
  echo Python 3.10 or newer is needed. Install it from https://www.python.org/downloads/ and run this again.
  pause
  exit /b 1
)

echo Setting up m5e's own Python environment (.venv)...
python -m venv .venv
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet
if errorlevel 1 (
  echo Installing the Python packages failed - see the message above.
  pause
  exit /b 1
)

echo Downloading the speech-to-text model (one time, about 500 MB)...
".venv\Scripts\python.exe" -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

if exist "%USERPROFILE%\.m5e\anthropic_key" (
  echo Anthropic API key: already saved.
) else (
  echo.
  echo Anthropic API key for the AI editor - create one at https://console.anthropic.com under API Keys.
  set "KEY="
  set /p KEY=Paste it here and press Enter, or just press Enter to skip for now:
  call :savekey
)
echo.
echo Done. To edit a reel: double-click m5e.bat and choose the folder with your clips and vo.m4a.
pause
exit /b 0

:savekey
if "%KEY%"=="" (
  echo Skipped: m5e will use its rule-based editor until you add a key - run this again any time.
  exit /b 0
)
if not exist "%USERPROFILE%\.m5e" mkdir "%USERPROFILE%\.m5e"
<nul set /p ="%KEY%" > "%USERPROFILE%\.m5e\anthropic_key"
echo Saved to %USERPROFILE%\.m5e\anthropic_key
exit /b 0

:restart
echo.
echo ffmpeg/Python were just installed. Close this window and double-click install.bat again
echo (Windows only sees newly installed programs in a new window).
pause
exit /b 1
