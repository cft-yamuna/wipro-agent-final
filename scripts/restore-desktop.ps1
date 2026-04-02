# LIGHTMAN - Restore Windows Desktop
# Reverses shell replacement: sets explorer.exe back as the Windows shell.
# Run via RDP with admin account, or from Safe Mode:
#   powershell -ExecutionPolicy Bypass -File restore-desktop.ps1
#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== LIGHTMAN - Restore Windows Desktop ===" -ForegroundColor Cyan
Write-Host ""

# Restore HKLM shell
$HKLMPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
$original = (Get-ItemProperty -Path $HKLMPath -Name "Shell_Original" -ErrorAction SilentlyContinue).Shell_Original
if ($original) {
    Set-ItemProperty -Path $HKLMPath -Name "Shell" -Value $original
    Write-Host "  HKLM shell restored to: $original" -ForegroundColor Green
} else {
    Set-ItemProperty -Path $HKLMPath -Name "Shell" -Value "explorer.exe"
    Write-Host "  HKLM shell restored to: explorer.exe" -ForegroundColor Green
}

# Remove HKCU shell override
$HKCUPath = "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
Remove-ItemProperty -Path $HKCUPath -Name "Shell" -ErrorAction SilentlyContinue
Write-Host "  HKCU shell override removed" -ForegroundColor Green

Write-Host ""
Write-Host "  Desktop will be restored on next reboot." -ForegroundColor Yellow
Write-Host "  Run: Restart-Computer" -ForegroundColor Yellow
Write-Host ""
