@echo off
setlocal
title Make PDF and Moore.exe
cd /d "%~dp0"
echo.
echo  ================================================
echo     Building  PDF and Moore.exe
echo  ================================================
echo.

rem --- Check for the .NET 8 (or newer) SDK -----------------------------
set "HASSDK="
for /f "tokens=1 delims=." %%v in ('dotnet --list-sdks 2^>nul') do (
  if %%v GEQ 8 set "HASSDK=1"
)
if not defined HASSDK (
  echo  The .NET 8 SDK is not installed yet, so the app can't be built.
  echo.
  echo  Fix: open Terminal and run:   winget install Microsoft.DotNet.SDK.8
  echo   or: Visual Studio Installer ^> Modify ^> tick ".NET desktop development"
  echo.
  echo  Then close this window and double-click Make EXE.bat again.
  echo.
  pause
  exit /b 1
)

echo  This takes a few minutes the first time (it downloads what it needs)...
echo.
if exist "Release\PdfAndMoore.exe" del /q "Release\PdfAndMoore.exe"
dotnet publish "PdfAndMoore\PdfAndMoore.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeAllContentForSelfExtract=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:DebugType=none -o "Release"

if not exist "Release\PdfAndMoore.exe" (
  echo.
  echo  The build did not finish. Copy the messages above and send them to Claude.
  echo.
  pause
  exit /b 1
)

move /y "Release\PdfAndMoore.exe" "Release\PDF and Moore.exe" >nul

rem --- Keep a copy in the school folder's "Release (app to run and share)" when it is there ---
set "APPDIR=Release"
if exist "..\..\Release (app to run and share)\" (
  copy /y "Release\PDF and Moore.exe" "..\..\Release (app to run and share)\PDF and Moore.exe" >nul
  set "APPDIR=..\..\Release (app to run and share)"
)

rem --- Desktop shortcut ---------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command "$exe = Join-Path (Resolve-Path $env:APPDIR) 'PDF and Moore.exe'; $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PDF and Moore.lnk'; $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk); $s.TargetPath = $exe; $s.IconLocation = $exe + ',0'; $s.Save()"

echo.
echo  Done!  "PDF and Moore.exe" is in the %APPDIR% folder,
echo  and there is a shortcut on your desktop.
echo  You can copy the .exe to any Windows 10/11 PC - nothing else to install.
echo.
start "" explorer "%APPDIR%"
pause
