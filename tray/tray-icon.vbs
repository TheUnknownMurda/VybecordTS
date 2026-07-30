Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' Create a temporary VBScript that will run the tray icon
scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
tempScript = scriptDir & "\temp-tray.vbs"

' Create the actual tray icon script
Set fso = CreateObject("Scripting.FileSystemObject")
Set file = fso.CreateTextFile(tempScript, True)

file.WriteLine "Set shell = CreateObject(""WScript.Shell"")"
file.WriteLine "Set fso = CreateObject(""Scripting.FileSystemObject"")"
file.WriteLine "scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)"
file.WriteLine ""
file.WriteLine "Do While True"
file.WriteLine "    ' Check if node process is running"
file.WriteLine "    Set wmi = GetObject(""winmgmts:\\.\root\cimv2"")"
file.WriteLine "    Set processes = wmi.ExecQuery(""SELECT * FROM Win32_Process WHERE Name='node.exe'"")"
file.WriteLine "    nodeRunning = False"
file.WriteLine "    For Each proc In processes"
file.WriteLine "        If InStr(proc.CommandLine, ""index.js"") > 0 Then"
file.WriteLine "            nodeRunning = True"
file.WriteLine "            Exit For"
file.WriteLine "        End If"
file.WriteLine "    Next"
file.WriteLine "    "
file.WriteLine "    If Not nodeRunning Then"
file.WriteLine "        Exit Do"
file.WriteLine "    End If"
file.WriteLine "    "
file.WriteLine "    WScript.Sleep 3000"
file.WriteLine "Loop"

file.Close

' Run the temporary script
objShell.Run "wscript.exe """ & tempScript & """", 0, False

' Clean up
WScript.Sleep 1000
fso.DeleteFile tempScript
