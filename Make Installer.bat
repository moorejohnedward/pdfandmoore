@echo off
setlocal
title Make PDF and Moore Setup
cd /d "%~dp0"
echo.
echo  ================================================
echo     Building  PDF and Moore Setup.exe  (installer)
echo  ================================================
echo.

if not exist "Release\PDF and Moore.exe" (
  echo  First build the app: double-click "Make EXE.bat", then run this again.
  echo.
  pause
  exit /b 1
)

set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not defined ISCC (
  echo  Inno Setup ^(the free tool that makes installers^) is not installed yet.
  echo.
  echo  Fix: open Terminal and run:   winget install --id JRSoftware.InnoSetup -e
  echo   or download it from https://jrsoftware.org/isdl.php
  echo.
  echo  Then double-click Make Installer.bat again.
  echo.
  pause
  exit /b 1
)

"%ISCC%" "installer\PdfAndMoore.iss"
if errorlevel 1 (
  echo.
  echo  The installer did not build. Copy the messages above and send them to Claude.
  pause
  exit /b 1
)
echo.
echo  Done!  "PDF and Moore Setup.exe" is in the school folder's "Release (app to run and share)".
echo  Run it to install PDF and Moore into Program Files with a Start menu entry and an uninstaller.
echo.
start "" explorer "..\..\Release (app to run and share)"
pause
