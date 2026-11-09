@echo off
rem Edit a reel with m5e. Double-click it, choose the folder with your clips + vo.m4a,
rem and the review page opens in your browser.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo m5e isn't set up yet: double-click install.bat first.
  pause
  exit /b 1
)
set "FOLDER=%~1"
if "%FOLDER%"=="" (
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose the folder with your clips and vo.m4a'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"`) do set "FOLDER=%%i"
)
if "%FOLDER%"=="" exit /b 0
echo Editing: %FOLDER%
echo The review page opens in your browser. Leave this window open while you work; close it to stop m5e.
".venv\Scripts\python.exe" -m m5e ui "%FOLDER%"
