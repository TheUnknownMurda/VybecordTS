Set WshShell = CreateObject("WScript.Shell")
Set objEnv = WshShell.Environment("Process")
objEnv("VYBECORD_TRAY_MODE") = "1"
WshShell.Run "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & Replace(WScript.ScriptFullName, ".vbs", ".ps1") & """", 0, False
