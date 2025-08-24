@echo off
cd /d "%~dp0"
call npm install --silent --no-fund --no-audit >nul 2>&1
node index.js
pause