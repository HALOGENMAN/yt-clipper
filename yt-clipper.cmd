@echo off
setlocal
set "SCRIPT_DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is required. Install Node.js and try again. 1>&2
    exit /b 1
)

node "%SCRIPT_DIR%server.js" %*
