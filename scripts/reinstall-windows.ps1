#Requires -RunAsAdministrator
<#
.SYNOPSIS
    LIGHTMAN Agent - Reinstall (install-windows.ps1 handles cleanup automatically)
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\reinstall-windows.ps1 -Slug "F-AV04" -Server "http://192.168.1.180:3401" -ShellReplace
#>
param(
    [Parameter(Mandatory=$true)] [string]$Slug,
    [Parameter(Mandatory=$true)] [string]$Server,
    [switch]$ShellReplace = $false,
    [string]$Timezone = "Asia/Kolkata",
    [switch]$NoReboot = $false
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$args = @("-ExecutionPolicy", "Bypass", "-File", "$ScriptDir\install-windows.ps1", "-Slug", $Slug, "-Server", $Server, "-Timezone", $Timezone)
if ($ShellReplace) { $args += "-ShellReplace" }
& powershell @args

if (-not $NoReboot) {
    Write-Host "  Rebooting in 10 seconds... (Ctrl+C to cancel)" -ForegroundColor Yellow
    Start-Sleep -Seconds 10
    Restart-Computer -Force
}
