@echo off
REM ================================================================
REM LIGHTMAN Shell - Replaces explorer.exe as the Windows shell
REM ================================================================
REM SINGLE SOURCE OF TRUTH: agent.config.json
REM
REM Boot flow:
REM   1. Auto-login (no password)
REM   2. This script runs INSTEAD of explorer.exe
REM   3. Reads slug + browser from agent.config.json (THE ONLY SOURCE)
REM   4. Waits for agent service (port 3403)
REM   5. Launches Chrome fullscreen
REM   6. If Chrome crashes, relaunches in 3 seconds (infinite loop)
REM ================================================================

set INSTALL_DIR=C:\Program Files\Lightman\Agent
set CONFIG_FILE=%INSTALL_DIR%\agent.config.json
set URL_SIDECAR=C:\ProgramData\Lightman\kiosk-url.txt
set MULTI_SIDECAR=C:\ProgramData\Lightman\kiosk-multi.json
set MULTI_LAUNCHER=%INSTALL_DIR%\scripts\launch-multi-kiosk.ps1
set CHROME_DATA=C:\ProgramData\Lightman\chrome-kiosk
set LOG_FILE=C:\ProgramData\Lightman\logs\shell.log

REM Ensure directories exist
if not exist "C:\ProgramData\Lightman\logs" mkdir "C:\ProgramData\Lightman\logs"
if not exist "%CHROME_DATA%" mkdir "%CHROME_DATA%"

echo [%date% %time%] ===== LIGHTMAN Shell starting ===== >> "%LOG_FILE%"

REM ----------------------------------------------------------------
REM Read slug and browser from agent.config.json ONLY
REM No sidecar files, no hardcoded URLs, no confusion.
REM ----------------------------------------------------------------
set DEVICE_SLUG=
set BROWSER=
set URL=

REM Wait for node.exe to be available
set NODE_WAIT=0
:wait_for_node
    where node >nul 2>&1
    if %errorlevel%==0 goto node_ready
    set /a NODE_WAIT+=1
    if %NODE_WAIT% geq 30 (
        echo [%date% %time%] ERROR: node.exe not found after 30s >> "%LOG_FILE%"
        goto use_fallbacks
    )
    timeout /t 1 /nobreak >nul
    goto wait_for_node

:node_ready

REM Read slug from config
if exist "%CONFIG_FILE%" (
    for /f "delims=" %%a in ('node -e "try{console.log(JSON.parse(require('fs').readFileSync(String.raw`%CONFIG_FILE%`,'utf8')).deviceSlug)}catch(e){console.log('')}" 2^>nul') do set DEVICE_SLUG=%%a
)

REM Read browser from config
if exist "%CONFIG_FILE%" (
    for /f "delims=" %%a in ('node -e "try{const c=JSON.parse(require('fs').readFileSync(String.raw`%CONFIG_FILE%`,'utf8'));console.log(c.kiosk&&c.kiosk.browserPath||'')}catch(e){console.log('')}" 2^>nul') do set BROWSER=%%a
)

:use_fallbacks

REM Build URL from slug (ALWAYS from config, never from sidecar)
if not "%DEVICE_SLUG%"=="" (
    set URL=http://127.0.0.1:3403/display/%DEVICE_SLUG%
    echo [%date% %time%] Slug: %DEVICE_SLUG% >> "%LOG_FILE%"
) else (
    set URL=http://127.0.0.1:3403/display
    echo [%date% %time%] WARNING: No slug in config! >> "%LOG_FILE%"
)

REM If agent wrote a URL sidecar (includes deviceId/apiKey), prefer it.
if exist "%URL_SIDECAR%" (
    for /f "usebackq delims=" %%u in ("%URL_SIDECAR%") do set SIDE_URL=%%u
    set USE_SIDE_URL=0
    if not "%SIDE_URL%"=="" (
        echo %SIDE_URL% | find /I "127.0.0.1:3403" >nul && set USE_SIDE_URL=1
        echo %SIDE_URL% | find /I "localhost:3403" >nul && set USE_SIDE_URL=1
    )
    if "%USE_SIDE_URL%"=="1" (
        set URL=%SIDE_URL%
        echo [%date% %time%] Using sidecar local URL >> "%LOG_FILE%"
    ) else (
        if not "%SIDE_URL%"=="" echo [%date% %time%] Ignoring non-local sidecar URL >> "%LOG_FILE%"
    )
)

REM Fallback browser
if "%BROWSER%"=="" (
    if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
        set "BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe"
    ) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
        set "BROWSER=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
    ) else if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
        set "BROWSER=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
    ) else if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
        set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    ) else (
        echo [%date% %time%] ERROR: No supported kiosk browser found! >> "%LOG_FILE%"
        start explorer.exe
        exit /b 1
    )
)

echo [%date% %time%] Browser: %BROWSER% >> "%LOG_FILE%"
echo [%date% %time%] URL: %URL% >> "%LOG_FILE%"

REM ----------------------------------------------------------------
REM Wait for agent service (port 3403)
REM ----------------------------------------------------------------
echo [%date% %time%] Waiting for port 3403... >> "%LOG_FILE%"
set WAIT_COUNT=0

:wait_for_agent
    netstat -an | findstr ":3403.*LISTENING" >nul 2>&1
    if %errorlevel%==0 goto agent_ready
    set /a WAIT_COUNT+=1
    set /a WAIT_MOD=WAIT_COUNT %% 30
    if %WAIT_MOD%==0 echo [%date% %time%] Still waiting for port 3403... (%WAIT_COUNT%s) >> "%LOG_FILE%"
    timeout /t 1 /nobreak >nul
    goto wait_for_agent

:agent_ready
echo [%date% %time%] Agent ready >> "%LOG_FILE%"

REM Wait until local display HTTP endpoint responds before opening browser.
set HTTP_WAIT=0
:wait_for_http
    powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:3403/'; if ($r.StatusCode -ge 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if %errorlevel%==0 goto http_ready
    set /a HTTP_WAIT+=1
    set /a HTTP_WAIT_MOD=HTTP_WAIT %% 30
    if %HTTP_WAIT_MOD%==0 echo [%date% %time%] Still waiting for HTTP on 127.0.0.1:3403... (%HTTP_WAIT%s) >> "%LOG_FILE%"
    timeout /t 1 /nobreak >nul
    goto wait_for_http

:http_ready
echo [%date% %time%] HTTP ready on 127.0.0.1:3403 >> "%LOG_FILE%"

REM ----------------------------------------------------------------
REM Infinite Chrome loop
REM ----------------------------------------------------------------
:loop
    REM Prefer sidecar URL for auth params/device routing; fallback to slug URL.
    set SIDE_URL=
    if exist "%URL_SIDECAR%" (
        for /f "usebackq delims=" %%u in ("%URL_SIDECAR%") do set SIDE_URL=%%u
    )
    if not "%SIDE_URL%"=="" (
        set USE_SIDE_URL=0
        echo %SIDE_URL% | find /I "127.0.0.1:3403" >nul && set USE_SIDE_URL=1
        echo %SIDE_URL% | find /I "localhost:3403" >nul && set USE_SIDE_URL=1
        if "%USE_SIDE_URL%"=="1" (
            set URL=%SIDE_URL%
        ) else (
            echo [%date% %time%] Ignoring non-local sidecar URL in loop >> "%LOG_FILE%"
        )
    ) else (
        REM Re-read slug from config on every loop iteration.
        if exist "%CONFIG_FILE%" (
            for /f "delims=" %%a in ('node -e "try{console.log(JSON.parse(require('fs').readFileSync(String.raw`%CONFIG_FILE%`,'utf8')).deviceSlug)}catch(e){console.log('')}" 2^>nul') do (
                if not "%%a"=="" set URL=http://127.0.0.1:3403/display/%%a
            )
        )
    )

    set MULTI_COUNT=0
    if exist "%MULTI_SIDECAR%" (
        for /f "delims=" %%c in ('node -e "try{const fs=require('fs');const p=String.raw`%MULTI_SIDECAR%`;const j=JSON.parse(fs.readFileSync(p,'utf8'));const n=Array.isArray(j&&j.entries)?j.entries.length:0;console.log(n)}catch(e){console.log(0)}" 2^>nul') do set MULTI_COUNT=%%c
    )

    if %MULTI_COUNT% gtr 1 if exist "%MULTI_LAUNCHER%" (
        echo [%date% %time%] Launching multi-screen shell session (%MULTI_COUNT% screens) >> "%LOG_FILE%"
        powershell -ExecutionPolicy Bypass -NoProfile -File "%MULTI_LAUNCHER%" -BrowserPath "%BROWSER%" -MultiConfigPath "%MULTI_SIDECAR%" -FallbackUrl "%URL%" -LogFile "%LOG_FILE%"
    ) else (
        echo [%date% %time%] Launching browser: %URL% >> "%LOG_FILE%"
        start /wait "" "%BROWSER%" --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --no-first-run --no-default-browser-check --start-fullscreen --disable-translate --disable-extensions --autoplay-policy=no-user-gesture-required --disable-features=TranslateUI --proxy-server=direct:// --proxy-bypass-list=* --user-data-dir="%CHROME_DATA%" "%URL%"
    )

    echo [%date% %time%] Browser exited (code: %errorlevel%). Restarting in 3s... >> "%LOG_FILE%"
    timeout /t 3 /nobreak >nul

goto loop
