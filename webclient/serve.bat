@echo off
title M4raCast Web Client Server
echo Starting M4raCast Web Client...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
pause

