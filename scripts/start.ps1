<#
.SYNOPSIS
    Starts Schematic AI Studio in development mode.

.DESCRIPTION
    Runs `npm run dev` (electron-vite dev): builds the main and preload bundles,
    starts the Vite dev server for the renderer, and launches the Electron
    window against it with hot reload.

    Blocks until the app is closed. Ctrl+C stops it.

.EXAMPLE
    .\scripts\start.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot '_common.ps1')

Install-DependenciesIfMissing

Write-Step 'Starting Schematic AI Studio (development mode)'
Invoke-Npm run dev
