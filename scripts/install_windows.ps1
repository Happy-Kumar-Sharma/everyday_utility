<#
.SYNOPSIS
    Install Everyday Utility as a desktop app on Windows: Start menu + Desktop shortcuts, no terminal needed.
.DESCRIPTION
    Native mode (default): finds Python 3.10+, creates .venv, installs requirements.txt, checks for Git for
    Windows' bash and creates shortcuts that run launcher.py with pythonw.exe (no console window).
    WSL mode (-Wsl): the repo lives inside WSL and was installed there first (bash scripts/install_linux.sh).
    The shortcuts start it through a hidden wsl.exe and open an Edge / Chrome app window on http://localhost:PORT/.
    Run it again after git pull or after moving the folder. Your data (data\, private\) is never touched.
    Windows PowerShell 5.1 compatible; keep this file ASCII (5.1 reads BOM-less scripts in the ANSI code page).
.EXAMPLE
    scripts\install_windows.bat                                   (double-click)
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_windows.ps1 -Autostart
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install_windows.ps1 -Wsl -Distro Ubuntu -RepoPath /home/me/everyday_utility
#>
[CmdletBinding()]
param(
    [switch]$Autostart,          # also start the server (no window) when you log in
    [switch]$NoDeps,             # skip pip
    [switch]$DryRun,             # print what would happen, change nothing
    [switch]$NoDesktopShortcut,  # only the Start menu entries
    [switch]$Wsl,                # the repo lives inside WSL
    [string]$Distro = '',        # WSL distribution (default: taken from a \\wsl$ path, else Ubuntu)
    [string]$RepoPath = '',      # repo path inside WSL, e.g. /home/me/everyday_utility
    [int]$Port = 0               # default: EU_PORT or 8765
)

$ErrorActionPreference = 'Stop'
$AppName = 'Everyday Utility'
$Repo = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $Repo 'launcher.py'
$IconFile = Join-Path (Join-Path $Repo 'assets') 'icon.ico'
$StateDir = Join-Path $env:LOCALAPPDATA 'EverydayUtility'   # WSL helper + icon copy (uninstall removes it)
$Programs = [Environment]::GetFolderPath('Programs')
$DesktopDir = [Environment]::GetFolderPath('DesktopDirectory')
$StartupDir = [Environment]::GetFolderPath('Startup')
$MainLnk = Join-Path $Programs "$AppName.lnk"
$StopLnk = Join-Path $Programs "Stop $AppName.lnk"
$DesktopLnk = Join-Path $DesktopDir "$AppName.lnk"
$StartupLnk = Join-Path $StartupDir "$AppName (server).lnk"
if ($Port -le 0) { if ($env:EU_PORT) { $Port = [int]$env:EU_PORT } else { $Port = 8765 } }

function Say([string]$Text) { Write-Host $Text }
function Warn([string]$Text) { Write-Host "WARNING: $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host $Text -ForegroundColor Red; exit 1 }

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    # Windows PowerShell 5.1 turns native stderr into terminating errors under 'Stop': run with 'Continue'
    # and judge by the exit code. Output goes to the console, the function returns only the exit code.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments | Out-Host
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $old
    }
}

function Get-PythonInfo([string]$Exe, [string[]]$Pre) {
    # @{Exe; Version} for a working Python, else $null. Running it weeds out the Microsoft Store alias
    # (WindowsApps\python.exe), which only prints a hint / opens the Store and exits with an error.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = @(& $Exe @Pre -c 'import sys; print(sys.version_info[0], sys.version_info[1]); print(sys.executable)' 2>$null)
        if ($LASTEXITCODE -ne 0 -or $out.Count -lt 2) { return $null }
        $v = "$($out[0])".Trim().Split(' ')
        return @{ Exe = "$($out[1])".Trim(); Major = [int]$v[0]; Minor = [int]$v[1] }
    } catch {
        return $null
    } finally {
        $ErrorActionPreference = $old
    }
}

function Find-Python {
    $tooOld = $null
    foreach ($c in @('py -3', 'python', 'python3')) {
        $parts = $c.Split(' ')
        $info = Get-PythonInfo $parts[0] @($parts | Select-Object -Skip 1)
        if ($null -eq $info) { continue }
        if ($info.Major -eq 3 -and $info.Minor -ge 10) { return $info }
        $tooOld = "$($info.Major).$($info.Minor) ($($info.Exe))"
    }
    if ($tooOld) { Say "Found Python $tooOld, but 3.10 or newer is needed." }
    return $null
}

function Find-GitBash {
    # Git for Windows' bash; never C:\Windows\System32\bash.exe or the WindowsApps alias (those start WSL)
    if ($env:EU_BASH -and (Test-Path -LiteralPath $env:EU_BASH)) { return $env:EU_BASH }
    foreach ($cmd in @(Get-Command bash.exe -All -CommandType Application -ErrorAction SilentlyContinue)) {
        $p = $cmd.Path
        if ($p -and $p -notmatch '\\(System32|Sysnative)\\bash\.exe$' -and $p -notmatch '\\WindowsApps\\') { return $p }
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))) {
        if (-not $base) { continue }
        $cand = Join-Path (Join-Path (Join-Path $base 'Git') 'bin') 'bash.exe'
        if (Test-Path -LiteralPath $cand) { return $cand }
    }
    return $null
}

function Find-AppBrowser {
    # Edge first (always there on Windows 10/11), then Chrome; '' = default browser, normal tab
    $cands = @()
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
        if ($base) { $cands += Join-Path $base 'Microsoft\Edge\Application\msedge.exe' }
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($base) { $cands += Join-Path $base 'Google\Chrome\Application\chrome.exe' }
    }
    foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { return $c } }
    return ''
}

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$Icon, [string]$Description) {
    if ($DryRun) {
        Say "[dry-run] shortcut $Path"
        Say "            -> $Target $Arguments"
        return
    }
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    $lnk.Arguments = $Arguments
    $lnk.WorkingDirectory = $WorkDir
    $lnk.Description = $Description
    if ($Icon -and (Test-Path -LiteralPath $Icon)) { $lnk.IconLocation = "$Icon,0" }
    $lnk.Save()
    Say "Created $Path"
}

function Q([string]$Text) { return '"' + $Text + '"' }   # quote one argument for a shortcut's Arguments

# ---- WSL mode ---------------------------------------------------------------------------------------
if ($Wsl) {
    # run from \\wsl$\<distro>\... or \\wsl.localhost\<distro>\...: take distro and path from there
    if ($Repo -match '^\\\\wsl(\$|\.localhost)\\([^\\]+)(\\.*)$') {
        if (-not $Distro) { $Distro = $Matches[2] }
        if (-not $RepoPath) { $RepoPath = $Matches[3] -replace '\\', '/' }
    }
    if (-not $Distro) { $Distro = 'Ubuntu' }
    if (-not $RepoPath) {
        Fail "Tell me where the repo is inside WSL, e.g.:  install_windows.bat -Wsl -Distro $Distro -RepoPath /home/me/everyday_utility"
    }
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Fail 'wsl.exe was not found: install WSL first (wsl --install).' }
    $rc = Invoke-Native 'wsl.exe' @('-d', $Distro, '--cd', $RepoPath, '--', 'test', '-x', '.venv/bin/python', '-a', '-f', 'launcher.py')
    if ($rc -ne 0) {
        Fail ("No installed Everyday Utility at $RepoPath in WSL '$Distro'. Inside WSL run first:`n" +
              "  cd $RepoPath && bash scripts/install_linux.sh")
    }
    $browser = Find-AppBrowser
    if (-not $browser) { Warn 'Neither Edge nor Chrome found: the app opens in a normal browser tab.' }
    $vbs = Join-Path $StateDir 'everyday-utility-wsl.vbs'
    $icon = Join-Path $StateDir 'icon.ico'
    $d = $Distro -replace '"', '""'
    $r = $RepoPath -replace '"', '""'
    $b = $browser -replace '"', '""'
    $wslCmd = "wsl.exe -d ""$Distro"" --cd ""$RepoPath"" -- ./.venv/bin/python launcher.py --port $Port"
    $script = @"
' Everyday Utility (WSL) launcher, generated by scripts\install_windows.ps1 - run the installer again to update it.
' no argument: start (if needed) and open the window; "server": start only; "stop": stop the server.
Option Explicit
Dim sh, url, mode, i
Set sh = CreateObject("WScript.Shell")
url = "http://localhost:$Port/"
mode = ""
If WScript.Arguments.Count > 0 Then mode = LCase(WScript.Arguments(0))
If mode = "stop" Then
  sh.Run "$($wslCmd -replace '"', '""') --stop", 0, True
  WScript.Quit 0
End If
If Not IsOurs() Then
  ' --foreground keeps the hidden wsl.exe (and so the WSL distro) alive while the server runs
  sh.Run "$($wslCmd -replace '"', '""') --foreground", 0, False
  For i = 1 To 240
    WScript.Sleep 250
    If IsOurs() Then Exit For
  Next
  If Not IsOurs() Then
    MsgBox "Everyday Utility did not start within 60 s." & vbCrLf & "See data/logs/server.log in $r (WSL ""$d"").", 16, "Everyday Utility"
    WScript.Quit 1
  End If
End If
If mode = "" Then
  If "$b" <> "" Then
    sh.Run """$b"" --app=" & url, 1, False
  Else
    sh.Run url, 1, False
  End If
End If

Function IsOurs()
  Dim http
  IsOurs = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.Open "GET", url & "api/services", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then IsOurs = (InStr(http.responseText, """id"":""home""") > 0)
  End If
  On Error GoTo 0
End Function
"@
    $script = $script -replace "`r?`n", "`r`n"   # WSH wants CRLF
    if ($DryRun) {
        Say "[dry-run] write $vbs :"
        Say $script
    } else {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
        Set-Content -LiteralPath $vbs -Value $script -Encoding Unicode   # UTF-16 + BOM: WSH reads any path
        if (Test-Path -LiteralPath $IconFile) { Copy-Item -LiteralPath $IconFile -Destination $icon -Force }
    }
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    New-Shortcut $MainLnk $wscript (Q $vbs) $env:USERPROFILE $icon "$AppName (WSL $Distro)"
    New-Shortcut $StopLnk $wscript ((Q $vbs) + ' stop') $env:USERPROFILE $icon "Stop $AppName"
    if (-not $NoDesktopShortcut) { New-Shortcut $DesktopLnk $wscript (Q $vbs) $env:USERPROFILE $icon "$AppName (WSL $Distro)" }
    if ($Autostart -or (Test-Path -LiteralPath $StartupLnk)) {
        New-Shortcut $StartupLnk $wscript ((Q $vbs) + ' server') $env:USERPROFILE $icon "Start the $AppName server"
    }
    Say ''
    Say "Done. Start menu -> '$AppName' starts it inside WSL '$Distro' and opens the app window."
    exit 0
}

# ---- native mode ------------------------------------------------------------------------------------
if ($DryRun) { Say 'Dry run: nothing is changed.' }
Say "$AppName in $Repo"
$py = Find-Python
if ($null -eq $py) {
    Fail ("Python 3.10 or newer was not found. Install it, then run this installer again:`n" +
          "  winget install -e --id Python.Python.3.12`n" +
          "or download it from https://www.python.org/downloads/windows/ (tick 'Add python.exe to PATH').")
}
Say "Python $($py.Major).$($py.Minor): $($py.Exe)"

$venv = Join-Path $Repo '.venv'
$venvPy = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPy)) {
    if ($NoDeps) {
        $venvPy = $py.Exe   # -NoDeps without a venv: the packages must already be installed for this Python
    } elseif ($DryRun) {
        Say "[dry-run] $($py.Exe) -m venv $venv"
    } else {
        Say "Creating the virtual environment $venv"
        if ((Invoke-Native $py.Exe @('-m', 'venv', $venv)) -ne 0) { Fail 'Creating the virtual environment failed.' }
    }
}
if (-not $NoDeps) {
    Say 'Installing the Python packages (requirements.txt)'
    if ($DryRun) {
        Say "[dry-run] $venvPy -m pip install --upgrade pip"
        Say "[dry-run] $venvPy -m pip install -r $(Join-Path $Repo 'requirements.txt')"
    } else {
        [void](Invoke-Native $venvPy @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'))
        $rc = Invoke-Native $venvPy @('-m', 'pip', 'install', '--quiet', '-r', (Join-Path $Repo 'requirements.txt'))
        if ($rc -ne 0) { Fail 'pip install failed (see above). Check your internet connection / proxy and run again.' }
    }
}
$pythonw = Join-Path (Split-Path -Parent $venvPy) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $pythonw) -and -not $DryRun) { $pythonw = $venvPy }

$bash = Find-GitBash
if ($bash) {
    Say "Git for Windows bash: $bash"
} else {
    Warn ("Git for Windows (bash) was not found. Everything else works, but these features need it:`n" +
          "  Library > Run (.sh items), AI pipeline steps, Remote Jupyter, Prod -> Staging sync, SQL export.`n" +
          "  Install it with:  winget install -e --id Git.Git   (then restart Everyday Utility)")
}
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) { Say 'Note: psql is not on PATH (only needed for the SQL steps).' }
if (-not (Find-AppBrowser)) { Warn 'Neither Edge nor Chrome found: the app opens in a normal browser tab.' }

$args0 = Q $Launcher
if ($Port -ne 8765) { $args0 += " --port $Port" }
New-Shortcut $MainLnk $pythonw $args0 $Repo $IconFile $AppName
New-Shortcut $StopLnk $pythonw ($args0 + ' --stop') $Repo $IconFile "Stop the $AppName server"
if (-not $NoDesktopShortcut) { New-Shortcut $DesktopLnk $pythonw $args0 $Repo $IconFile $AppName }
if ($Autostart -or (Test-Path -LiteralPath $StartupLnk)) {
    New-Shortcut $StartupLnk $pythonw ($args0 + ' --server-only --no-window') $Repo $IconFile "Start the $AppName server"
}

Say ''
Say "Done. Open '$AppName' from the Start menu or the Desktop (right-click -> Pin to taskbar / Pin to Start)."
Say "Stop the server: Start menu -> 'Stop $AppName'. Logs: data\logs\launcher.log and data\logs\server.log"
if (-not $Autostart) { Say 'Start the server at login: run this installer again with -Autostart.' }
