# LIGHTMAN Guardian - Service Health Monitor
# Runs every 5 minutes via Task Scheduler.
# Restarts the NSSM service if it's down. Checks Chrome kiosk health.

$LogDir = "C:\ProgramData\Lightman\logs"
$LogFile = Join-Path $LogDir "guardian.log"
$ServiceName = "LightmanAgent"
$NssmExe = "C:\ProgramData\Lightman\nssm\nssm.exe"

function Write-GuardianLog($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
        Add-Content -Path $LogFile -Value "[$ts] $msg" -ErrorAction SilentlyContinue
        if ((Get-Item $LogFile -ErrorAction SilentlyContinue).Length -gt 1MB) {
            $rotated = "$LogFile.old"
            if (Test-Path $rotated) { Remove-Item $rotated -Force }
            Rename-Item $LogFile $rotated -Force
        }
    } catch { }
}

try {
    # 1. Check LIGHTMAN service
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $svc) {
        $svc = Get-Service -DisplayName "LIGHTMAN*" -ErrorAction SilentlyContinue | Select-Object -First 1
    }

    if (-not $svc) {
        Write-GuardianLog "CRITICAL: Service not found!"
        exit 1
    }

    if ($svc.Status -ne 'Running') {
        Write-GuardianLog "WARNING: Service is $($svc.Status). Restarting..."

        if ($svc.Status -eq 'Stopped') {
            if (Test-Path $NssmExe) {
                & $NssmExe start $ServiceName 2>$null
            } else {
                Start-Service -Name $svc.Name -ErrorAction SilentlyContinue
            }
            Start-Sleep -Seconds 5
            $svc.Refresh()
            Write-GuardianLog "After restart: $($svc.Status)"
        }
        elseif ($svc.Status -in @('StartPending', 'StopPending')) {
            Write-GuardianLog "Service stuck in $($svc.Status). Force killing node.exe..."
            Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 3
            if (Test-Path $NssmExe) { & $NssmExe start $ServiceName 2>$null }
            else { Start-Service -Name $svc.Name -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 5
            $svc.Refresh()
            Write-GuardianLog "After force restart: $($svc.Status)"
        }
    }

    # 2. Check Chrome kiosk
    $chrome = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
    if (-not $chrome) {
        $vbsPath = "C:\Program Files\Lightman\Agent\launch-kiosk.vbs"
        if (Test-Path $vbsPath) {
            Start-Sleep -Seconds 10
            $chromeRecheck = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
            if (-not $chromeRecheck) {
                Write-GuardianLog "Chrome not running. Launching via VBS..."
                Start-Process "wscript.exe" -ArgumentList """$vbsPath""" -WindowStyle Hidden
            }
        }
    }
} catch {
    Write-GuardianLog "Guardian error: $_"
}
