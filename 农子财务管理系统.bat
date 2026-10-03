@echo off
rem ============================================================
rem  Nongzi Finance System - Windows launcher (double-click me)
rem
rem  This file is deliberately ASCII-only and uses CRLF line
rem  endings. cmd.exe parses .bat files in the ANSI codepage, so
rem  non-ASCII text here would be garbled and can break parsing.
rem  All Chinese messages are printed by Node instead.
rem ============================================================

setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem --- locate a Node runtime: bundled first, then PATH ---
set "NODE=%~dp0runtime\node.exe"
if exist "%NODE%" goto run

set "NODE="
for %%i in (node.exe) do set "NODE=%%~$PATH:i"
if not defined NODE goto nonode
if not exist "%NODE%" goto nonode

:run
echo Using runtime: %NODE%
"%NODE%" "src\main.js"
if errorlevel 1 goto failed
goto end

:nonode
echo.
echo   Node.js runtime not found.
echo.
echo   Please do one of the following:
echo     1. Install Node.js 22 or newer from https://nodejs.org
echo     2. Put node.exe into the runtime\ folder beside this file
echo.
pause
goto end

:failed
echo.
echo   The program exited with an error. Please see the messages above.
echo.
pause

:end
endlocal
