@echo off
rem rBrowser installer for Windows.
rem Everything stays in this folder: it installs the Python packages of
rem requirements.txt and makes sure Reticulum reaches rmap.world (rns_setup.py).
rem Double-click it, or run it in cmd. Run it again at any time.

setlocal
cd /d "%~dp0"
echo.
echo rBrowser installer - folder: %CD%
echo.

rem --- Python 3.9 or newer, with pip ---
set "PY="
rem "python" first: the one you type to start rBrowser afterwards.
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PY=python"
if not defined PY py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PY=py -3"
if not defined PY (
    echo Python 3.9 or newer is needed: https://www.python.org/downloads/
    echo During its setup tick "Add python.exe to PATH", then run this again.
    goto :end
)
for /f "delims=" %%v in ('%PY% --version 2^>^&1') do echo Python: %%v
%PY% -m pip --version >nul 2>nul
if errorlevel 1 (
    echo pip is missing: reinstall Python from python.org with pip ticked, then run this again.
    goto :end
)

rem --- Python packages ---
echo.
echo Installing the Python packages - requirements.txt
%PY% -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo pip install failed, see above.
    goto :end
)

rem --- Reticulum config: rmap.world there and switched on ---
echo.
%PY% rns_setup.py --iface tcp
if errorlevel 1 echo The Reticulum config was not checked, see above.

:done
echo.
echo Done! Start rBrowser with:
echo.
echo   cd /d "%CD%"
echo   %PY% rBrowser.py
echo.
echo Then open http://localhost:5000 in your browser.
echo Only the NomadNet browser is on at first: switch on LXMF, RRC, BBS and RMAP in Settings when you want them.

:end
echo.
pause
endlocal
