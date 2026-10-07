@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0release\win-unpacked\Voice Scribe.exe" goto launch_packaged

set "SCRIBE_NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "SCRIBE_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined SCRIBE_NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "SCRIBE_NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined SCRIBE_NODE for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined SCRIBE_NODE set "SCRIBE_NODE=%%N"
if not defined SCRIBE_NODE goto missing_node
if not exist "%~dp0node_modules\esbuild\package.json" goto missing_dependencies
if not exist "%~dp0node_modules\electron\dist\electron.exe" goto missing_dependencies

echo Building Voice Scribe...
"%SCRIBE_NODE%" "%~dp0scripts\build.mjs"
if errorlevel 1 goto build_failed
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
exit /b 0

:launch_packaged
start "" "%~dp0release\win-unpacked\Voice Scribe.exe" %*
exit /b 0

:missing_node
echo Node.js was not found. Install Node.js 22 or newer, or use the packaged app.
echo See README.md for instructions.
pause
exit /b 1

:missing_dependencies
echo Dependencies are missing. In this folder, run npm install first.
echo If npm is not in PATH, use the npm.cmd next to your node.exe:
echo "%SCRIBE_NODE%"
echo See README.md for instructions.
pause
exit /b 1

:build_failed
echo Voice Scribe could not be built. Review the error above.
pause
exit /b 1
