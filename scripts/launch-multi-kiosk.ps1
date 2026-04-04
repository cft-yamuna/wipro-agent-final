# LIGHTMAN shell multi-screen launcher
# Runs in the interactive shell session and launches one browser window per display.

param(
    [Parameter(Mandatory = $true)][string]$BrowserPath,
    [Parameter(Mandatory = $true)][string]$MultiConfigPath,
    [Parameter(Mandatory = $true)][string]$FallbackUrl,
    [string]$LogFile = "C:\ProgramData\Lightman\logs\shell.log"
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message)
    try {
        Add-Content -Path $LogFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')] $Message"
    } catch {
        # Logging should never block kiosk startup.
    }
}

function Resolve-DisplayNumber {
    param([string]$HardwareId)
    if ([string]::IsNullOrWhiteSpace($HardwareId)) { return $null }
    $trimmed = $HardwareId.Trim()
    if ($trimmed -match '^\d+$') { return [int]$trimmed }
    if ($trimmed -match 'DISPLAY(\d+)$') { return [int]$matches[1] }
    return $null
}

function Pick-Screen {
    param(
        [array]$Screens,
        [string]$HardwareId,
        [int]$ScreenIndex,
        [System.Collections.Generic.HashSet[string]]$Used
    )

    $displayNo = Resolve-DisplayNumber -HardwareId $HardwareId
    if ($displayNo) {
        $suffix = "DISPLAY$displayNo"
        foreach ($s in $Screens) {
            if ($Used.Contains($s.DeviceName)) { continue }
            if ($s.DeviceName.ToUpperInvariant().EndsWith($suffix)) { return $s }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($HardwareId)) {
        foreach ($s in $Screens) {
            if ($Used.Contains($s.DeviceName)) { continue }
            if ($s.DeviceName.Equals($HardwareId, [System.StringComparison]::OrdinalIgnoreCase)) { return $s }
        }
    }

    if ($ScreenIndex -ge 0 -and $ScreenIndex -lt $Screens.Count) {
        $preferred = $Screens[$ScreenIndex]
        if ($preferred -and -not $Used.Contains($preferred.DeviceName)) { return $preferred }
    }

    foreach ($s in $Screens) {
        if (-not $Used.Contains($s.DeviceName)) { return $s }
    }

    return $null
}

if (-not (Test-Path $BrowserPath)) {
    Write-Log "ERROR: Browser path not found: $BrowserPath"
    exit 1
}

Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.DeviceName }
Write-Log "Detected $($screens.Count) display(s) in shell session"

if (-not (Test-Path $MultiConfigPath)) {
    Write-Log "Multi config not found. Launching fallback URL."
    $fallback = Start-Process -FilePath $BrowserPath -ArgumentList @(
        "--kiosk",
        "--noerrdialogs",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=TranslateUI",
        "--user-data-dir=C:\ProgramData\Lightman\chrome-kiosk",
        $FallbackUrl
    ) -PassThru
    if ($fallback) { Wait-Process -Id $fallback.Id -ErrorAction SilentlyContinue }
    exit 0
}

$json = Get-Content -Raw $MultiConfigPath | ConvertFrom-Json
$entries = @($json.entries)
if ($entries.Count -le 1) {
    Write-Log "Multi config has $($entries.Count) entry. Launching fallback URL."
    $fallback = Start-Process -FilePath $BrowserPath -ArgumentList @(
        "--kiosk",
        "--noerrdialogs",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=TranslateUI",
        "--user-data-dir=C:\ProgramData\Lightman\chrome-kiosk",
        $FallbackUrl
    ) -PassThru
    if ($fallback) { Wait-Process -Id $fallback.Id -ErrorAction SilentlyContinue }
    exit 0
}

$usedScreens = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$processes = @()

for ($i = 0; $i -lt $entries.Count; $i++) {
    $entry = $entries[$i]
    $entryIndex = 0
    try { $entryIndex = [int]$entry.screenIndex } catch { $entryIndex = $i }
    $entryHardwareId = [string]$entry.hardwareId
    $entryUrl = [string]$entry.url
    if ([string]::IsNullOrWhiteSpace($entryUrl)) { $entryUrl = $FallbackUrl }

    $screen = Pick-Screen -Screens $screens -HardwareId $entryHardwareId -ScreenIndex $entryIndex -Used $usedScreens
    if (-not $screen) {
        Write-Log "WARN: No available screen for mapping index $i (hardwareId='$entryHardwareId')."
        continue
    }

    $null = $usedScreens.Add($screen.DeviceName)

    $screenSlot = [Array]::IndexOf($screens, $screen)
    if ($screenSlot -lt 0) { $screenSlot = $entryIndex }
    $userDataDir = "C:\ProgramData\Lightman\chrome-kiosk-screen-$screenSlot"
    New-Item -ItemType Directory -Path $userDataDir -Force | Out-Null

    $x = [int]$screen.Bounds.X
    $y = [int]$screen.Bounds.Y
    $w = [int]$screen.Bounds.Width
    $h = [int]$screen.Bounds.Height

    Write-Log "Launching $($screen.DeviceName) at ${w}x${h}@${x},${y} -> $entryUrl"

    $proc = Start-Process -FilePath $BrowserPath -ArgumentList @(
        "--kiosk",
        "--noerrdialogs",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=TranslateUI",
        "--window-position=$x,$y",
        "--window-size=$w,$h",
        "--user-data-dir=$userDataDir",
        $entryUrl
    ) -PassThru

    if ($proc) { $processes += $proc }
    Start-Sleep -Milliseconds 300
}

if ($processes.Count -eq 0) {
    Write-Log "WARN: Multi launch created no browser process. Starting fallback."
    $fallback = Start-Process -FilePath $BrowserPath -ArgumentList @(
        "--kiosk",
        "--noerrdialogs",
        "--disable-infobars",
        "--disable-session-crashed-bubble",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=TranslateUI",
        "--user-data-dir=C:\ProgramData\Lightman\chrome-kiosk",
        $FallbackUrl
    ) -PassThru
    if ($fallback) { Wait-Process -Id $fallback.Id -ErrorAction SilentlyContinue }
    exit 0
}

$pids = $processes | ForEach-Object { $_.Id }
Write-Log "Waiting on multi-screen browser processes: $($pids -join ', ')"
Wait-Process -Id $pids -ErrorAction SilentlyContinue
Write-Log "Multi-screen browser session ended"
