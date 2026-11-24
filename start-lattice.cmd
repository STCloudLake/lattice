@echo off
setlocal

rem Launch Edge with Lattice's dedicated profile.
rem
rem IMPORTANT: this script does NOT pass --load-extension. Chrome/Edge 137+
rem removed that flag on branded builds: an extension loaded from the command
rem line gets DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION on the next start. The
rem supported path is a one-time manual install in developer mode:
rem
rem   edge://extensions  ->  developer mode ON  ->  Load unpacked
rem                      ->  pick packages\extension
rem
rem After that it stays installed in this profile and survives restarts.
rem
rem Keep this file ASCII-only: cmd.exe parses .cmd files in the OEM code page,
rem and UTF-8 Chinese text can corrupt the parser on a GBK system.

set "ROOT=%~dp0"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto :run
set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" goto :run
goto :noedge

:run
start "" "%EDGE%" --user-data-dir="%ROOT%.browser-profile" --no-first-run --no-default-browser-check --new-window
exit /b 0

:noedge
echo [Lattice] Microsoft Edge not found.
echo Open this file in Notepad and set EDGE to your browser path.
pause
exit /b 1
