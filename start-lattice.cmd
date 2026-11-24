@echo off
setlocal
chcp 65001 >nul

rem Launch Edge with a dedicated, persistent Lattice profile and the unpacked
rem extension. Unpacked MV3 extensions cannot be installed silently into a normal
rem browser profile (the browser requires the user to pick the folder once), so
rem this launcher is the reproducible way to get a working install:
rem   - its own profile  -> your daily browsing stays untouched
rem   - --load-extension -> the extension is present every time you start it
rem   - the profile keeps the learner database (OPFS) between runs

set "ROOT=%~dp0"
set "EXT=%ROOT%packages\extension"

if not exist "%EXT%\manifest.json" (
  echo [Lattice] 找不到扩展构建产物：%EXT%
  echo 请先在仓库目录运行：  npm install ^&^& npm run build
  pause
  exit /b 1
)

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo [Lattice] 没找到 Microsoft Edge。
  echo 请用记事本打开本文件，把 EDGE 改成你的浏览器路径后重试。
  pause
  exit /b 1
)

start "" "%EDGE%" --user-data-dir="%ROOT%.browser-profile" --load-extension="%EXT%" --no-first-run --no-default-browser-check --new-window
exit /b 0
