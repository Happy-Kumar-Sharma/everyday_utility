<#
.SYNOPSIS
    Starts Everyday Utility server.
.DESCRIPTION
    Runs the FastAPI / Uvicorn server for Everyday Utility on http://127.0.0.1:8765 (or EU_HOST:EU_PORT).
.EXAMPLE
    .\run.ps1
    .\run.ps1 --reload
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$AppArgs
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

# Activate virtualenv if present
if (Test-Path "$ScriptDir\.venv\Scripts\Activate.ps1") {
    & "$ScriptDir\.venv\Scripts\Activate.ps1"
}

# Resolve Python executable (skipping dummy Windows Store stubs)
$Python = $null
foreach ($cmd in @("python", "py", "python3")) {
    $found = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($found) {
        try {
            $ver = & $cmd --version 2>&1
            if ($LASTEXITCODE -eq 0 -and "$ver" -match "Python \d") {
                $Python = $cmd
                break
            }
        } catch {}
    }
}

if (-not $Python) {
    Write-Error "Python not found. Please install Python 3.10+ and add it to your PATH."
    exit 1
}

$HostName = if ($env:EU_HOST) { $env:EU_HOST } else { "127.0.0.1" }
$Port = if ($env:EU_PORT) { $env:EU_PORT } else { "8765" }

& $Python -m uvicorn app.main:app --host $HostName --port $Port @AppArgs

