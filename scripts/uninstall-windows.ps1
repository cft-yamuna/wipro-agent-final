# LIGHTMAN Agent - Windows Uninstaller
# Removes everything: service, tasks, processes, files, shell.
#Requires -RunAsAdministrator

$ErrorActionPreference = "Continue"
$NssmExe = "C:\ProgramData\Lightman\nssm\nssm.exe"
$ServiceName = "LightmanAgent"

Write-Host ""
Write-Host "=== LIGHTMAN Agent - Uninstaller ===" -ForegroundColor Cyan

# 1. Service
Write-Host "[1/6] Removing service..." -ForegroundColor Yellow
if (Test-Path $NssmExe) { & $NssmExe stop $ServiceName 2>$null; & $NssmExe remove $ServiceName confirm 2>$null }
foreach ($sn in @($ServiceName,"lightmanagent.exe")) { sc.exe stop $sn 2>$null; sc.exe delete $sn 2>$null }
$s = Get-Service -DisplayName "LIGHTMAN*" -ErrorAction SilentlyContinue
if ($s) { Stop-Service $s.Name -Force -ErrorAction SilentlyContinue; sc.exe delete $s.Name 2>$null }

# 2. Tasks
Write-Host "[2/6] Removing tasks..." -ForegroundColor Yellow
foreach ($tn in @("LIGHTMAN Agent","LIGHTMAN Kiosk Browser","LIGHTMAN Guardian")) {
    $t = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
    if ($t) { Stop-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction SilentlyContinue }
}

# 3. Processes
Write-Host "[3/6] Killing processes..." -ForegroundColor Yellow
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 4. Firewall
Write-Host "[4/6] Removing firewall rule..." -ForegroundColor Yellow
Remove-NetFirewallRule -DisplayName "LIGHTMAN Agent WebSocket" -ErrorAction SilentlyContinue

# 5. Shell
Write-Host "[5/6] Restoring shell..." -ForegroundColor Yellow
$HKLMPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
$shell = (Get-ItemProperty -Path $HKLMPath -Name "Shell" -ErrorAction SilentlyContinue).Shell
if ($shell -and $shell -like "*lightman*") {
    $orig = (Get-ItemProperty -Path $HKLMPath -Name "Shell_Original" -ErrorAction SilentlyContinue).Shell_Original
    Set-ItemProperty -Path $HKLMPath -Name "Shell" -Value $(if ($orig) { $orig } else { "explorer.exe" })
    Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name "Shell" -ErrorAction SilentlyContinue
    Write-Host "  Shell restored"
}

# 6. Files
Write-Host "[6/6] Removing files..." -ForegroundColor Yellow
Remove-Item "C:\Program Files\Lightman" -Recurse -Force -ErrorAction SilentlyContinue
$choice = Read-Host "Remove all data (logs, chrome cache, nssm)? [y/N]"
if ($choice -eq 'y') { Remove-Item "C:\ProgramData\Lightman" -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "=== Done. Reboot: Restart-Computer ===" -ForegroundColor Green
Write-Host ""
