@echo off
cd /d "%~dp0"
where pyw >nul 2>nul && (start "" pyw "addon_loader.py" & exit /b)
where pythonw >nul 2>nul && (start "" pythonw "addon_loader.py" & exit /b)
echo Python 3 was not found. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
pause
