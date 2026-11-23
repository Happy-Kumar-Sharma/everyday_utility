<#
.SYNOPSIS
    Remove the Everyday Utility shortcuts created by install_windows.ps1 (Start menu, Desktop, Startup).
.DESCRIPTION
    Stops the server if the launcher started it, removes only shortcuts that point at this app, and the WSL helper
    folder %LOCALAPPDATA%\EverydayUtility. -PurgeVenv also deletes .venv. Your data (data\, private\) is never touched.
    Windows PowerShell 5.1 compatible; keep this file ASCII.
.EXAMPLE
    scripts\uninstall_windows.bat
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall_windows.ps1 -PurgeVenv
#>
[CmdletBinding()]
param(
    [switch]$PurgeVenv,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AppName = 'Everyday Utility'
$Repo = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $env:LOCALAPPDATA 'EverydayUtility'
$Programs = [Environment]::GetFolderPath('Programs')
$Links = @(
    (Join-Path $Programs "$AppName.lnk"),
    (Join-Path $Programs "Stop $AppName.lnk"),
    (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) "$AppName.lnk"),
    (Join-Path ([Environment]::GetFolderPath('Startup')) "$AppName (server).lnk")
)

function Say([string]$Text) { Write-Host $Text }

# stop a server the launcher started (it refuses to touch anything else); needed before -PurgeVenv can delete files
$venvPy = Join-Path $Repo '.venv\Scripts\python.exe'
if ((Test-Path -LiteralPath $venvPy) -and (Test-Path -LiteralPath (Join-Path $Repo 'launcher.py'))) {
    if ($DryRun) {
        Say "[dry-run] $venvPy launcher.py --stop"
    } else {
        $env:EU_LAUNCHER_NO_DIALOG = '1'
        $old = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & $venvPy (Join-Path $Repo 'launcher.py') --stop | Out-Host
        $ErrorActionPreference = $old
    }
}

$shell = New-Object -ComObject WScript.Shell
foreach ($path in $Links) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $lnk = $shell.CreateShortcut($path)
    $what = "$($lnk.TargetPath) $($lnk.Arguments)"
    if ($what -notmatch 'launcher\.py|everyday-utility-wsl\.vbs') {   # same name, but not ours: leave it
        Say "Skipped $path (it does not start $AppName)"
        continue
    }
    if ($DryRun) { Say "[dry-run] remove $path" } else { Remove-Item -LiteralPath $path -Force; Say "Removed $path" }
}

if (Test-Path -LiteralPath $StateDir) {
    if ($DryRun) { Say "[dry-run] remove $StateDir" } else { Remove-Item -LiteralPath $StateDir -Recurse -Force; Say "Removed $StateDir" }
}

if ($PurgeVenv) {
    $venv = Join-Path $Repo '.venv'
    if (Test-Path -LiteralPath (Join-Path $venv 'pyvenv.cfg')) {
        if ($DryRun) { Say "[dry-run] remove $venv" } else { Remove-Item -LiteralPath $venv -Recurse -Force; Say "Removed $venv" }
    } else {
        Say "No virtual environment at $venv"
    }
}

Say "Kept your data (data\, private\). Reinstall any time: scripts\install_windows.bat"
