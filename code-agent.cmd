@echo off
setlocal
if not exist "%~dp0dist\src\index.js" (
  echo code-agent is not built. Run init.bat first.
  exit /b 1
)
node "%~dp0dist\src\index.js" %*
exit /b %errorlevel%
