@echo off
rem Build the Windows portable/installer package for Email Chatter (Electron).
rem Requires Node.js 18+ and internet access for the first `npm install`.
setlocal
cd /d "%~dp0"
echo [1/3] npm install ...
call npm install || goto :err
echo [2/3] npm run dist:win ...
call npm run dist:win || goto :err
echo [3/3] done. artifacts are in %~dp0dist
dir /b dist
exit /b 0

:err
echo.
echo Build failed. Check network / Node.js version.
exit /b 1
