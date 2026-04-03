' LIGHTMAN Kiosk Launcher
' Runs at user logon AND at system startup to start the kiosk browser.
' Waits for the agent service to be ready before launching Chrome.
' If the agent is already managing Chrome, this script exits gracefully.

Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' --- Configuration ---
configPath = "C:\Program Files\Lightman\Agent\agent.config.json"
maxWaitSeconds = 120  ' Max time to wait for agent service
checkIntervalMs = 5000 ' Check every 5 seconds

' --- Wait for config file to exist (agent might still be installing) ---
If Not objFSO.FileExists(configPath) Then
    WScript.Sleep 10000
    If Not objFSO.FileExists(configPath) Then
        WScript.Quit 1
    End If
End If

' --- Read config ---
Set objFile = objFSO.OpenTextFile(configPath, 1)
jsonText = objFile.ReadAll
objFile.Close

browserPath = ExtractJsonValue(jsonText, "browserPath")
defaultUrl = ExtractJsonValue(jsonText, "defaultUrl")

If browserPath = "" Or defaultUrl = "" Then
    WScript.Quit 1
End If

' --- Wait for network connectivity ---
' Try to ping the server (extract hostname from URL)
waitedMs = 0
Do While waitedMs < (maxWaitSeconds * 1000)
    ' Check if Chrome is already running (agent's KioskManager may have launched it)
    Set objWMI = GetObject("winmgmts:\\.\root\cimv2")
    Set colProcesses = objWMI.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'chrome.exe'")
    If colProcesses.Count > 0 Then
        ' Chrome already running - agent is handling it. Exit gracefully.
        WScript.Quit 0
    End If

    ' Check if LIGHTMAN service is running
    Set colServices = objWMI.ExecQuery("SELECT State FROM Win32_Service WHERE DisplayName LIKE 'LIGHTMAN%'")
    serviceRunning = False
    For Each svc In colServices
        If LCase(svc.State) = "running" Then
            serviceRunning = True
        End If
    Next

    If serviceRunning Then
        ' Service is running - give it a few more seconds to launch Chrome itself
        WScript.Sleep 15000

        ' Re-check if Chrome appeared (agent launched it)
        Set colProcesses2 = objWMI.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'chrome.exe'")
        If colProcesses2.Count > 0 Then
            ' Agent launched Chrome successfully. Exit.
            WScript.Quit 0
        End If

        ' Agent is running but hasn't launched Chrome yet - we'll do it
        Exit Do
    End If

    WScript.Sleep checkIntervalMs
    waitedMs = waitedMs + checkIntervalMs
Loop

' --- Build Chrome kiosk args ---
chromeArgs = "--kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --no-first-run --no-default-browser-check --start-fullscreen --disable-translate --disable-extensions --autoplay-policy=no-user-gesture-required"

userDataDir = ExtractJsonValue(jsonText, "user-data-dir")
If userDataDir = "" Then
    userDataDir = "C:\ProgramData\Lightman\chrome-kiosk"
End If
chromeArgs = chromeArgs & " --user-data-dir=""" & userDataDir & """"

' --- Launch Chrome ---
objShell.Run """" & browserPath & """ " & chromeArgs & " """ & defaultUrl & """", 1, False

' ========================================================
' Helper: extract a string value from JSON by key
' ========================================================
Function ExtractJsonValue(json, key)
    ExtractJsonValue = ""
    pos = InStr(json, """" & key & """")
    If pos = 0 Then Exit Function
    pos = InStr(pos, json, ":")
    If pos = 0 Then Exit Function
    pos = InStr(pos, json, """")
    If pos = 0 Then Exit Function
    pos = pos + 1
    endPos = InStr(pos, json, """")
    If endPos = 0 Then Exit Function
    ExtractJsonValue = Mid(json, pos, endPos - pos)
End Function
