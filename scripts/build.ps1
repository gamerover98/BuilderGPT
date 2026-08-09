<#
.SYNOPSIS
    Typechecks and builds the BuilderGPT Electron app, optionally packaging it.

.DESCRIPTION
    Runs `npm run build` (typecheck + electron-vite build), producing
    out/main, out/preload and out/renderer.

    With -Package, continues into electron-builder to produce a distributable in
    release/. electron-builder is invoked directly rather than through the
    `package:*` npm scripts, because those re-run the build that just finished.

    The app has no native dependencies, so no rebuild step is needed for any
    target.

.PARAMETER Package
    Optional distribution target: win, linux or mac. Cross-building is subject
    to electron-builder's own platform limitations (notably, mac targets
    generally require macOS).

.EXAMPLE
    .\scripts\build.ps1

.EXAMPLE
    .\scripts\build.ps1 -Package win
#>
[CmdletBinding()]
param(
    [ValidateSet('win', 'linux', 'mac')]
    [string]$Package
)

. (Join-Path $PSScriptRoot '_common.ps1')

Install-DependenciesIfMissing

Write-Step 'Typechecking and building'
Invoke-Npm run build

if ($Package) {
    Write-Step "Packaging for $Package"
    Invoke-Npm exec -- electron-builder "--$Package"
    Write-Host ''
    Write-Host "Done. Installer(s) written to $(Join-Path $script:RepoRoot 'release')" -ForegroundColor Green
}
else {
    Write-Host ''
    Write-Host "Done. Bundles written to $(Join-Path $script:RepoRoot 'out')" -ForegroundColor Green
}
