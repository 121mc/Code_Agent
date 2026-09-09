@echo off
setlocal
set "PSModulePath="
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-user-path.ps1"
if errorlevel 1 goto failed
where node >nul 2>nul
if errorlevel 1 goto missing_node
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\init-config.ps1"
if errorlevel 1 goto failed
call npm ci
if errorlevel 1 goto failed
call npm run build
if errorlevel 1 goto failed
echo Ready. Open a new terminal and run code-agent.
popd
pause
exit /b 0
:missing_node
echo Install Node.js 20.19 or newer with npm first.
:failed
echo Installation failed. See the error above.
popd
pause
exit /b 1
