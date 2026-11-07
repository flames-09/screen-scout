@echo off
rem Screen Scout — launch the built app (background tray app).
rem Rebuild first if you changed source: npm run build
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
