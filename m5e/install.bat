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

echo Downloading the speech-to-text and vision models (one time, about 1 GB, free, they run on this PC)...
".venv\Scripts\python.exe" -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
".venv\Scripts\python.exe" -c "from m5e import see; see.seer()"

if exist "%USERPROFILE%\.m5e\anthropic_key" (
  del "%USERPROFILE%\.m5e\anthropic_key"
  echo Removed the API key an older m5e saved: m5e never uses pay-per-use API keys now.
)

call :claude
echo.
echo Done. To edit a reel: double-click m5e.bat and choose the folder with your clips and vo.m4a.
pause
exit /b 0

:claude
echo.
echo Claude (optional): help from Claude on your Claude Pro/Max plan, never pay-per-use.
echo m5e edits for free on this PC. If Claude Code is logged in with your Claude subscription, m5e also asks
echo Claude to log the shots, direct the cut and review it - on your plan's included usage, and it stops by
echo itself when you hit the plan's limit.
if exist "%USERPROFILE%\.local\bin\claude.exe" set "PATH=%USERPROFILE%\.local\bin;%PATH%"
where claude >nul 2>nul
if not errorlevel 1 goto claude_login
set "A="
set /p A=Claude Code isn't installed. Install it now? [y/N]
if /i not "%A%"=="y" (
  echo Skipped: m5e uses its free editor - run this again any time to add Claude.
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
where claude >nul 2>nul
if errorlevel 1 (
  echo Claude Code didn't install; m5e uses its free editor.
  exit /b 0
)

:claude_login
".venv\Scripts\python.exe" -c "import sys; from m5e import brain; ok, why = brain.login(); print(why); sys.exit(0 if ok else 1)"
if not errorlevel 1 goto claude_done
echo Log in with the Claude account that has your Max plan (a browser window opens):
set "ANTHROPIC_API_KEY="
set "ANTHROPIC_AUTH_TOKEN="
call claude auth login --claudeai
".venv\Scripts\python.exe" -c "from m5e import brain; print(brain.login(force=True)[1])"

:claude_done
echo.
echo To be sure nothing is ever billed beyond your plan, keep 'extra usage' (usage credits) switched OFF at
echo https://claude.ai/settings/usage - m5e never uses it either way, and stops at your plan's limit.
exit /b 0

:restart
echo.
echo ffmpeg/Python were just installed. Close this window and double-click install.bat again
echo (Windows only sees newly installed programs in a new window).
pause
exit /b 1
