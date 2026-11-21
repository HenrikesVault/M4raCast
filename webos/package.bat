@echo off
setlocal
echo ========================================================
echo   Packaging M4raCast for LG webOS TV (.ipk)
echo ========================================================

where ares-package >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] 'ares-package' was not found in your PATH.
    echo Please install webOS TV CLI or webOS Dev Manager.
    echo Download: https://webostv.developer.lge.com/develop/tools/cli-installation
    echo.
    pause
    exit /b 1
)

cd /d "%~dp0"
echo Running: ares-package .
ares-package .

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [SUCCESS] Package created successfully!
    echo To install on your TV (assuming TV device is added in ares):
    echo   ares-install com.m4racast.receiver_1.0.0_all.ipk
) else (
    echo.
    echo [ERROR] Packaging failed.
)

pause

