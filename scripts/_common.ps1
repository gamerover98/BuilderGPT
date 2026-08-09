# Shared helpers for the BuilderGPT PowerShell scripts.
#
# Dot-source this from build.ps1 / start.ps1 / check.ps1. It is not meant to be
# run directly.
#
# The scripts are deliberately thin wrappers over the npm scripts in
# package.json: package.json stays the single source of truth for how the app is
# built and tested, and these just make it convenient to invoke from a shell,
# from any working directory, with dependencies bootstrapped.

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is this file's directory (scripts/), so the repo root is its
# parent. Resolving it this way lets the scripts be run from anywhere.
$script:RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Npm {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)

    Push-Location $script:RepoRoot
    try {
        & npm @Arguments
        # $ErrorActionPreference does not apply to native executables, so the
        # exit code has to be checked by hand or failures pass silently.
        if ($LASTEXITCODE -ne 0) {
            throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

function Install-DependenciesIfMissing {
    if (Test-Path (Join-Path $script:RepoRoot 'node_modules')) {
        return
    }
    Write-Step 'node_modules is missing — installing dependencies'
    if (Test-Path (Join-Path $script:RepoRoot 'package-lock.json')) {
        Invoke-Npm ci
    }
    else {
        Invoke-Npm install
    }
}
