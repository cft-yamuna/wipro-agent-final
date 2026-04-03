# LIGHTMAN Agent - Complete Windows Installer
# Uses NSSM for rock-solid Windows Service. Shell replacement for kiosk.
# Cleans up any previous installation automatically before installing.
#
# Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Slug "F-AV01" -Server "http://192.168.1.180:3401"
#
# Shell Replacement mode (RECOMMENDED for kiosk machines):
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Slug "F-AV01" -Server "http://..." -ShellReplace
#Requires -RunAsAdministrator

param(
    [Parameter(Mandatory=$true)]  [string]$Slug,
    [Parameter(Mandatory=$true)]  [string]$Server,
    [string]$Timezone = "Asia/Kolkata",
    [string]$Username = "",
    [switch]$ShellReplace = $false
)

$ErrorActionPreference = "Stop"

$InstallDir    = "C:\Program Files\Lightman\Agent"
$LogDir        = "C:\ProgramData\Lightman\logs"
$ChromeData    = "C:\ProgramData\Lightman\chrome-kiosk"
$NssmDir       = "C:\ProgramData\Lightman\nssm"
$NssmExe       = "$NssmDir\nssm.exe"
$ServiceName   = "LightmanAgent"
$GuardianTask  = "LIGHTMAN Guardian"
$KioskTask     = "LIGHTMAN Kiosk Browser"
$AgentTask     = "LIGHTMAN Agent"
$ScriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentDir      = Split-Path -Parent $ScriptDir

if (-not $Username) { $Username = $env:USERNAME }

Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  LIGHTMAN Agent - Complete Windows Installer" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  Device slug : $Slug"
Write-Host "  Server URL  : $Server"
Write-Host "  Username    : $Username"
Write-Host "  Mode        : $(if ($ShellReplace) { 'Shell Replacement' } else { 'Standard' })"
Write-Host ""

# ============================================================
# PHASE 0: NUKE EVERYTHING FROM PREVIOUS INSTALLS
# ============================================================
Write-Host "--- Phase 0: Cleaning previous installation ---" -ForegroundColor Cyan
$ErrorActionPreference = "Continue"

# Stop and remove NSSM service
Write-Host "[0a] Removing old services..." -ForegroundColor Yellow
if (Test-Path $NssmExe) {
    & $NssmExe stop $ServiceName 2>$null
    & $NssmExe remove $ServiceName confirm 2>$null
}
foreach ($sn in @($ServiceName, "lightmanagent.exe", "LightmanAgent.exe")) {
    sc.exe stop $sn 2>$null; sc.exe delete $sn 2>$null
}
$oldSvc = Get-Service -DisplayName "LIGHTMAN*" -ErrorAction SilentlyContinue
if ($oldSvc) { Stop-Service -Name $oldSvc.Name -Force -ErrorAction SilentlyContinue; sc.exe delete $oldSvc.Name 2>$null }

# Remove scheduled tasks (from previous task-scheduler-based installs)
Write-Host "[0b] Removing old scheduled tasks..." -ForegroundColor Yellow
foreach ($tn in @($AgentTask, $KioskTask, $GuardianTask)) {
    $t = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
    if ($t) { Stop-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue }
}

# Kill processes
Write-Host "[0c] Killing node.exe and Chrome..." -ForegroundColor Yellow
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Remove old files (keep NSSM and logs)
Write-Host "[0d] Removing old agent files..." -ForegroundColor Yellow
Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "C:\ProgramData\Lightman\kiosk-url.txt" -Force -ErrorAction SilentlyContinue

# Remove firewall rule
Remove-NetFirewallRule -DisplayName "LIGHTMAN Agent WebSocket" -ErrorAction SilentlyContinue

$ErrorActionPreference = "Stop"
Start-Sleep -Seconds 2
Write-Host "  Clean slate" -ForegroundColor Green
Write-Host ""

# ============================================================
# PART 1: BUILD & INSTALL
# ============================================================

# --- 1. Node.js ---
Write-Host "[1/19] Checking Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = (node -v) -replace 'v', ''
    if ([int]($nodeVersion.Split('.')[0]) -lt 20) { throw "old" }
    Write-Host "  Found Node.js v$nodeVersion"
} catch {
    Write-Host "  Installing Node.js v20.18.0..." -ForegroundColor Yellow
    $installer = "$env:TEMP\node-setup.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi" -OutFile $installer -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$installer`" /qn /norestart" -Wait -NoNewWindow
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "  FATAL: Node.js install failed!" -ForegroundColor Red; exit 1 }
    Write-Host "  Node.js installed" -ForegroundColor Green
}

# --- 2. Build ---
Write-Host "[2/19] Building agent..." -ForegroundColor Yellow
Push-Location $AgentDir
$ErrorActionPreference = "Continue"
& npm install 2>&1 | Out-Host
& npm run build 2>&1 | Out-Host
$ErrorActionPreference = "Stop"
if (-not (Test-Path "$AgentDir\dist\index.js")) { Write-Host "  FATAL: Build failed!" -ForegroundColor Red; exit 1 }
Pop-Location
Write-Host "  Build successful"

# --- 3. Directories ---
Write-Host "[3/19] Creating directories..." -ForegroundColor Yellow
foreach ($d in @($InstallDir, $LogDir, $ChromeData, $NssmDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# --- 4. Copy files ---
Write-Host "[4/19] Copying agent files..." -ForegroundColor Yellow
Copy-Item "$AgentDir\dist" "$InstallDir\dist" -Recurse -Force
Copy-Item "$AgentDir\package.json" "$InstallDir\package.json" -Force
if (Test-Path "$AgentDir\package-lock.json") { Copy-Item "$AgentDir\package-lock.json" "$InstallDir\package-lock.json" -Force }
Copy-Item "$AgentDir\agent.config.template.json" "$InstallDir\agent.config.template.json" -Force
if (Test-Path "$AgentDir\public") { Copy-Item "$AgentDir\public" "$InstallDir\public" -Recurse -Force }

# --- 5. Install deps ---
Write-Host "[5/19] Installing dependencies..." -ForegroundColor Yellow
Push-Location $InstallDir
$ErrorActionPreference = "Continue"
& npm ci --omit=dev --ignore-scripts 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { & npm install --omit=dev --ignore-scripts 2>&1 | Out-Host }
$ErrorActionPreference = "Stop"
Pop-Location

# --- 6. Generate config ---
Write-Host "[6/19] Generating config..." -ForegroundColor Yellow
if ($ShellReplace) {
    & "$ScriptDir\setup.ps1" -Slug $Slug -Server $Server -Timezone $Timezone -InstallDir $InstallDir -ShellMode
} else {
    & "$ScriptDir\setup.ps1" -Slug $Slug -Server $Server -Timezone $Timezone -InstallDir $InstallDir
}

# --- 7. Fix BOM ---
Write-Host "[7/19] Fixing config encoding..." -ForegroundColor Yellow
$configPath = Join-Path $InstallDir "agent.config.json"
if (-not (Test-Path $configPath)) { Write-Host "  FATAL: config not created!" -ForegroundColor Red; exit 1 }
$raw = [System.IO.File]::ReadAllText($configPath)
[System.IO.File]::WriteAllText($configPath, $raw.TrimStart([char]0xFEFF), [System.Text.UTF8Encoding]::new($false))

# --- 8. Verify config ---
Write-Host "[8/19] Verifying config..." -ForegroundColor Yellow
Push-Location $InstallDir
$ErrorActionPreference = "Continue"
$jsonCheck = & node -e "try{const c=JSON.parse(require('fs').readFileSync('agent.config.json','utf8'));console.log('OK slug='+c.deviceSlug+' shellMode='+(c.kiosk&&c.kiosk.shellMode||false))}catch(e){console.log('FAIL: '+e.message);process.exit(1)}" 2>&1
$ErrorActionPreference = "Stop"
if ($LASTEXITCODE -ne 0) { Write-Host "  FATAL: invalid config: $jsonCheck" -ForegroundColor Red; Pop-Location; exit 1 }
Pop-Location
Write-Host "  $jsonCheck"

# --- 9. Download NSSM ---
Write-Host "[9/19] Setting up NSSM..." -ForegroundColor Yellow
if (-not (Test-Path $NssmExe)) {
    # Check bundled copy first (fastest, no internet needed)
    $bundled = Join-Path $AgentDir "nssm\nssm.exe"
    if (Test-Path $bundled) {
        Copy-Item $bundled $NssmExe -Force
        Write-Host "  Using bundled NSSM"
    } else {
        # Download from multiple sources
        $nssmZip = "$env:TEMP\nssm.zip"
        $downloaded = $false
        $urls = @(
            "https://nssm.cc/release/nssm-2.24.zip",
            "https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip"
        )
        foreach ($url in $urls) {
            if ($downloaded) { break }
            Write-Host "  Downloading from $url ..."
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $url -OutFile $nssmZip -UseBasicParsing -TimeoutSec 60
                if ((Test-Path $nssmZip) -and (Get-Item $nssmZip).Length -gt 10000) {
                    $downloaded = $true
                }
            } catch {
                Write-Host "  Failed: $_" -ForegroundColor DarkYellow
            }
        }
        if ($downloaded) {
            Expand-Archive -Path $nssmZip -DestinationPath "$env:TEMP\nssm-extract" -Force
            # Find nssm.exe in extracted folder (handles different zip structures)
            $found = Get-ChildItem "$env:TEMP\nssm-extract" -Recurse -Filter "nssm.exe" | Where-Object { $_.DirectoryName -like "*win64*" } | Select-Object -First 1
            if (-not $found) { $found = Get-ChildItem "$env:TEMP\nssm-extract" -Recurse -Filter "nssm.exe" | Select-Object -First 1 }
            if ($found) { Copy-Item $found.FullName $NssmExe -Force }
            Remove-Item $nssmZip -Force -ErrorAction SilentlyContinue
            Remove-Item "$env:TEMP\nssm-extract" -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
if (-not (Test-Path $NssmExe)) {
    Write-Host ""
    Write-Host "  NSSM download failed. Manual fix:" -ForegroundColor Red
    Write-Host "  1. Download nssm-2.24.zip from https://nssm.cc/release/nssm-2.24.zip" -ForegroundColor Yellow
    Write-Host "  2. Extract win64\nssm.exe to: $NssmExe" -ForegroundColor Yellow
    Write-Host "  3. Re-run this script" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  OR bundle it in the repo:" -ForegroundColor Yellow
    Write-Host "  Copy nssm.exe to: $AgentDir\nssm\nssm.exe" -ForegroundColor Yellow
    exit 1
}
Write-Host "  NSSM ready: $NssmExe"

# --- 10. Install Windows Service via NSSM ---
Write-Host "[10/19] Installing Windows Service..." -ForegroundColor Yellow

# Clean slate
$ErrorActionPreference = "Continue"
& $NssmExe stop $ServiceName 2>$null
& $NssmExe remove $ServiceName confirm 2>$null
sc.exe delete $ServiceName 2>$null
Start-Sleep -Seconds 2
$ErrorActionPreference = "Stop"

$nodePath = (Get-Command node).Source

# Install
& $NssmExe install $ServiceName $nodePath "dist\index.js"
if ($LASTEXITCODE -ne 0) { Write-Host "  FATAL: NSSM install failed!" -ForegroundColor Red; exit 1 }

# Configure
& $NssmExe set $ServiceName AppDirectory $InstallDir
& $NssmExe set $ServiceName DisplayName "LIGHTMAN Agent"
& $NssmExe set $ServiceName Description "LIGHTMAN kiosk agent - display management and monitoring"
& $NssmExe set $ServiceName Start SERVICE_AUTO_START
& $NssmExe set $ServiceName AppStdout "$LogDir\service-stdout.log"
& $NssmExe set $ServiceName AppStderr "$LogDir\service-stderr.log"
& $NssmExe set $ServiceName AppStdoutCreationDisposition 4
& $NssmExe set $ServiceName AppStderrCreationDisposition 4
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 5242880
& $NssmExe set $ServiceName AppRestartDelay 10000
& $NssmExe set $ServiceName AppExit Default Restart

# Verify service was created
Start-Sleep -Seconds 2
$svcCheck = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svcCheck) {
    $svcCheck = Get-Service -DisplayName "LIGHTMAN*" -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $svcCheck) {
    Write-Host "  FATAL: Service was not created!" -ForegroundColor Red
    exit 1
}
Write-Host "  Service installed: $($svcCheck.Name)" -ForegroundColor Green

# Recovery policy
sc.exe failure $svcCheck.Name reset= 86400 actions= restart/5000/restart/10000/restart/30000 2>$null

# --- 11. Start service ---
Write-Host "[11/19] Starting service..." -ForegroundColor Yellow
Start-Service -Name $svcCheck.Name -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
$svcCheck.Refresh()

if ($svcCheck.Status -eq 'Running') {
    Write-Host "  Service is RUNNING" -ForegroundColor Green
} else {
    Write-Host "  Service status: $($svcCheck.Status) - check $LogDir" -ForegroundColor Yellow
    Start-Sleep -Seconds 3
    Start-Service -Name $svcCheck.Name -ErrorAction SilentlyContinue
}

# Wait for port 3403
$portUp = $false
for ($i = 0; $i -lt 10; $i++) {
    $ErrorActionPreference = "Continue"
    $n = netstat -an 2>$null | findstr ":3403.*LISTENING" 2>$null
    $ErrorActionPreference = "Stop"
    if ($n) { $portUp = $true; break }
    Start-Sleep -Seconds 2
}
if ($portUp) { Write-Host "  Port 3403 LISTENING" -ForegroundColor Green }
else { Write-Host "  Port 3403 not yet up (may take a moment)" -ForegroundColor Yellow }

# --- 12. Firewall ---
Write-Host "[12/19] Configuring firewall..." -ForegroundColor Yellow
$ErrorActionPreference = "Continue"
if (-not (Get-NetFirewallRule -DisplayName "LIGHTMAN Agent WebSocket" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "LIGHTMAN Agent WebSocket" -Direction Outbound -Action Allow -Protocol TCP -RemotePort 3001 -Description "LIGHTMAN Agent" | Out-Null
    Write-Host "  Created"
} else { Write-Host "  Already exists" }

# ============================================================
# PART 2: KIOSK CONFIGURATION
# ============================================================
$ErrorActionPreference = "Continue"
Write-Host ""
Write-Host "--- Configuring Kiosk Mode ---" -ForegroundColor Cyan
Write-Host ""

# --- 13. Auto-login ---
Write-Host "[13/19] Enabling auto-login..." -ForegroundColor Yellow
$RegPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
$targetUser = Get-LocalUser -Name $Username -ErrorAction SilentlyContinue
$isMsAccount = $targetUser -and $targetUser.PrincipalSource -eq 'MicrosoftAccount'

if ($isMsAccount) {
    $KioskUser = "kiosk"
    $existingKiosk = Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue
    if (-not $existingKiosk) { net user $KioskUser "" /add 2>$null; net localgroup Administrators $KioskUser /add 2>$null }
    else { net user $KioskUser "" 2>$null }
    $HidePath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
    if (-not (Test-Path $HidePath)) { New-Item -Path $HidePath -Force | Out-Null }
    Set-ItemProperty -Path $HidePath -Name $Username -Value 0
    $Username = $KioskUser
    Write-Host "  Created kiosk account, auto-login: $Username" -ForegroundColor Green
} else {
    net user $Username "" 2>$null
}

$PwdLess = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device"
if (Test-Path $PwdLess) { Set-ItemProperty -Path $PwdLess -Name "DevicePasswordLessBuildVersion" -Value 0 }

$Passport = "HKLM:\SOFTWARE\Policies\Microsoft\PassportForWork"
if (-not (Test-Path $Passport)) { New-Item -Path $Passport -Force | Out-Null }
Set-ItemProperty -Path $Passport -Name "Enabled" -Value 0

Set-ItemProperty -Path $RegPath -Name "AutoAdminLogon" -Value "1"
Set-ItemProperty -Path $RegPath -Name "DefaultUserName" -Value $Username
Set-ItemProperty -Path $RegPath -Name "DefaultPassword" -Value ""
Set-ItemProperty -Path $RegPath -Name "DefaultDomainName" -Value ""
Set-ItemProperty -Path $RegPath -Name "DisableCAD" -Value 1
Set-ItemProperty -Path $RegPath -Name "AutoRestartShell" -Value 1
Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -Name "DisableAutomaticRestartSignOn" -Value 0
$OOBE = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE"
if (-not (Test-Path $OOBE)) { New-Item -Path $OOBE -Force | Out-Null }
Set-ItemProperty -Path $OOBE -Name "DisablePrivacyExperience" -Value 1
Write-Host "  Auto-login enabled for: $Username"

# --- 14. Lock screen ---
Write-Host "[14/19] Removing lock screen..." -ForegroundColor Yellow
$LP = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization"
if (-not (Test-Path $LP)) { New-Item -Path $LP -Force | Out-Null }
Set-ItemProperty -Path $LP -Name "NoLockScreen" -Value 1

$SD = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI\SessionData"
if (Test-Path $SD) { Set-ItemProperty -Path $SD -Name "AllowLockScreen" -Value 0 -ErrorAction SilentlyContinue }

$CC = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent"
if (-not (Test-Path $CC)) { New-Item -Path $CC -Force | Out-Null }
Set-ItemProperty -Path $CC -Name "DisableWindowsConsumerFeatures" -Value 1
Set-ItemProperty -Path $CC -Name "DisableCloudOptimizedContent" -Value 1
$CCU = "HKCU:\SOFTWARE\Policies\Microsoft\Windows\CloudContent"
if (-not (Test-Path $CCU)) { New-Item -Path $CCU -Force | Out-Null }
Set-ItemProperty -Path $CCU -Name "DisableWindowsSpotlightFeatures" -Value 1
Set-ItemProperty -Path $CCU -Name "DisableTailoredExperiencesWithDiagnosticData" -Value 1

Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -Name "EnableFirstLogonAnimation" -Value 0
$SP = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
Set-ItemProperty -Path $SP -Name "DisableLockWorkstation" -Value 1
Set-ItemProperty -Path $SP -Name "HideFastUserSwitching" -Value 1

$DL = "HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
if (-not (Test-Path $DL)) { New-Item -Path $DL -Force | Out-Null }
Set-ItemProperty -Path $DL -Name "EnableGoodbye" -Value 0

$PS = "HKLM:\SOFTWARE\Policies\Microsoft\Power\PowerSettings\0e796bdb-100d-47d6-a2d5-f7d2daa51f51"
if (-not (Test-Path $PS)) { New-Item -Path $PS -Force | Out-Null }
Set-ItemProperty -Path $PS -Name "ACSettingIndex" -Value 0
Set-ItemProperty -Path $PS -Name "DCSettingIndex" -Value 0
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 2>&1 | Out-Null
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 2>&1 | Out-Null
powercfg /SETACTIVE SCHEME_CURRENT 2>&1 | Out-Null

Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaverIsSecure" -Value "0"
Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaveActive" -Value "0"
Set-ItemProperty -Path $SP -Name "InactivityTimeoutSecs" -Value 0 -ErrorAction SilentlyContinue
try { Disable-ScheduledTask -TaskName "\Microsoft\Windows\Shell\CreateObjectTask" -ErrorAction SilentlyContinue | Out-Null } catch { }
Write-Host "  Lock screen fully disabled"

# --- 15. Sleep ---
Write-Host "[15/19] Disabling sleep..." -ForegroundColor Yellow
powercfg /change monitor-timeout-ac 0 2>&1 | Out-Null
powercfg /change standby-timeout-ac 0 2>&1 | Out-Null
powercfg /change hibernate-timeout-ac 0 2>&1 | Out-Null

# --- 16. Harden ---
Write-Host "[16/19] Hardening Windows..." -ForegroundColor Yellow
$WU = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
if (-not (Test-Path $WU)) { New-Item -Path $WU -Force | Out-Null }
Set-ItemProperty -Path $WU -Name "NoAutoRebootWithLoggedOnUsers" -Value 1
Set-ItemProperty -Path $WU -Name "AUOptions" -Value 2
$WUM = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate"
if (-not (Test-Path $WUM)) { New-Item -Path $WUM -Force | Out-Null }
Set-ItemProperty -Path $WUM -Name "SetAutoRestartNotificationDisable" -Value 1
Set-ItemProperty -Path $WUM -Name "SetActiveHours" -Value 1
Set-ItemProperty -Path $WUM -Name "ActiveHoursStart" -Value 0
Set-ItemProperty -Path $WUM -Name "ActiveHoursEnd" -Value 23

$NP = "HKCU:\SOFTWARE\Policies\Microsoft\Windows\Explorer"
if (-not (Test-Path $NP)) { New-Item -Path $NP -Force | Out-Null }
Set-ItemProperty -Path $NP -Name "DisableNotificationCenter" -Value 1
$TP = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\PushNotifications"
if (-not (Test-Path $TP)) { New-Item -Path $TP -Force | Out-Null }
Set-ItemProperty -Path $TP -Name "ToastEnabled" -Value 0

$WER = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting"
if (-not (Test-Path $WER)) { New-Item -Path $WER -Force | Out-Null }
Set-ItemProperty -Path $WER -Name "DontShowUI" -Value 1
Set-ItemProperty -Path $WER -Name "Disabled" -Value 1
Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Windows" -Name "ErrorMode" -Value 2 -ErrorAction SilentlyContinue

$SR = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search"
if (-not (Test-Path $SR)) { New-Item -Path $SR -Force | Out-Null }
Set-ItemProperty -Path $SR -Name "AllowCortana" -Value 0
Write-Host "  Done"

# --- 17. Kiosk Chrome ---
if ($ShellReplace) {
    Write-Host "[17/19] SHELL REPLACEMENT..." -ForegroundColor Magenta

    # Copy shell BAT (reads slug from agent.config.json - single source of truth)
    $shellSource = Join-Path $ScriptDir "lightman-shell.bat"
    $shellTarget = Join-Path $InstallDir "lightman-shell.bat"
    if (Test-Path $shellSource) { Copy-Item $shellSource $shellTarget -Force }

    # No sidecar file needed - shell BAT reads directly from agent.config.json

    # Replace shell
    $ShellReg = "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
    if (-not (Test-Path $ShellReg)) { New-Item -Path $ShellReg -Force | Out-Null }
    Set-ItemProperty -Path $ShellReg -Name "Shell" -Value """$shellTarget"""
    $HKLMShell = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
    $orig = (Get-ItemProperty -Path $HKLMShell -Name "Shell" -ErrorAction SilentlyContinue).Shell
    if ($orig -and $orig -notlike "*lightman*") { Set-ItemProperty -Path $HKLMShell -Name "Shell_Original" -Value $orig }
    Set-ItemProperty -Path $HKLMShell -Name "Shell" -Value """$shellTarget"""

    Write-Host "  Shell replaced -> lightman-shell.bat" -ForegroundColor Green
    Write-Host "  Recovery: scripts\restore-desktop.ps1" -ForegroundColor Yellow

    # Remove kiosk task if exists
    $kt = Get-ScheduledTask -TaskName $KioskTask -ErrorAction SilentlyContinue
    if ($kt) { Unregister-ScheduledTask -TaskName $KioskTask -Confirm:$false }
} else {
    Write-Host "[17/19] Standard mode - kiosk browser task..." -ForegroundColor Yellow
    $vbs = Join-Path $ScriptDir "launch-kiosk.vbs"
    $vbsT = Join-Path $InstallDir "launch-kiosk.vbs"
    if (Test-Path $vbs) { Copy-Item $vbs $vbsT -Force }
    $kt = Get-ScheduledTask -TaskName $KioskTask -ErrorAction SilentlyContinue
    if ($kt) { Unregister-ScheduledTask -TaskName $KioskTask -Confirm:$false }
    $kA = New-ScheduledTaskAction -Execute "wscript.exe" -Argument """$vbsT""" -WorkingDirectory $InstallDir
    $kT1 = New-ScheduledTaskTrigger -AtLogOn -User $Username
    $kT2 = New-ScheduledTaskTrigger -AtStartup
    $kS = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $KioskTask -Action $kA -Trigger @($kT1,$kT2) -Settings $kS -RunLevel Highest -Description "Chrome kiosk at logon/startup" -Force | Out-Null
    Write-Host "  Kiosk browser task registered"
}

# --- 18. Guardian ---
Write-Host "[18/19] Registering Guardian..." -ForegroundColor Yellow
$gSrc = Join-Path $ScriptDir "guardian.ps1"
$gDst = Join-Path $InstallDir "guardian.ps1"
if (Test-Path $gSrc) { Copy-Item $gSrc $gDst -Force }
$gt = Get-ScheduledTask -TaskName $GuardianTask -ErrorAction SilentlyContinue
if ($gt) { Unregister-ScheduledTask -TaskName $GuardianTask -Confirm:$false }
$gA = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File ""$gDst""" -WorkingDirectory $InstallDir
$gT = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 365)
$gS = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$gP = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $GuardianTask -Action $gA -Trigger $gT -Settings $gS -Principal $gP -Description "LIGHTMAN health check every 5 min" -Force | Out-Null

foreach ($task in @("\Microsoft\Windows\UpdateOrchestrator\Reboot","\Microsoft\Windows\UpdateOrchestrator\Schedule Retry Scan","\Microsoft\Windows\WindowsUpdate\Scheduled Start")) {
    try { Disable-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue | Out-Null } catch { }
}
Write-Host "  Guardian registered"

# --- 19. Final verification ---
Write-Host "[19/19] Verification..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

$finalSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $finalSvc) { $finalSvc = Get-Service -DisplayName "LIGHTMAN*" -ErrorAction SilentlyContinue | Select-Object -First 1 }
$svcStatus = if ($finalSvc) { "$($finalSvc.Status)" } else { "NOT FOUND" }

$cfgOk = $false
try {
    Push-Location $InstallDir
    $cfgResult = & node -e "const c=JSON.parse(require('fs').readFileSync('agent.config.json','utf8'));console.log(JSON.stringify({slug:c.deviceSlug,shell:c.kiosk&&c.kiosk.shellMode||false}))" 2>&1
    $cfgData = $cfgResult | ConvertFrom-Json
    Pop-Location
    $cfgOk = $true
} catch { Pop-Location }

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  INSTALLATION COMPLETE" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Slug       : $Slug"
Write-Host "  Server     : $Server"
Write-Host "  Install    : $InstallDir"
Write-Host "  Logs       : $LogDir"
Write-Host "  User       : $Username"
Write-Host ""
Write-Host "  Service    : $svcStatus" -ForegroundColor $(if ($svcStatus -eq 'Running') { 'Green' } else { 'Red' })
if ($cfgOk) {
    Write-Host "  Config slug: $($cfgData.slug)" -ForegroundColor $(if ($cfgData.slug -eq $Slug) { 'Green' } else { 'Red' })
    Write-Host "  Shell mode : $($cfgData.shell)" -ForegroundColor $(if ($cfgData.shell -eq $ShellReplace.IsPresent) { 'Green' } else { 'Red' })
}
Write-Host ""
Write-Host "  Manage:" -ForegroundColor DarkGray
Write-Host "    $NssmExe stop $ServiceName" -ForegroundColor DarkGray
Write-Host "    $NssmExe start $ServiceName" -ForegroundColor DarkGray
Write-Host "    $NssmExe restart $ServiceName" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  BIOS (manual):" -ForegroundColor Red
Write-Host "    After Power Loss = Power On" -ForegroundColor Red
Write-Host "    Wake-on-LAN = Enabled" -ForegroundColor Red
Write-Host ""
Write-Host "  REBOOT NOW: Restart-Computer" -ForegroundColor Yellow
Write-Host ""
