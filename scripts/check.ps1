<#
.SYNOPSIS
    Runs every automated check for BuilderGPT: typecheck plus the five test
    suites.

.DESCRIPTION
    Runs, in order:
      * typecheck   — tsc over main/preload/shared, svelte-check over the renderer
      * hello       — smallest possible proof the QuickJS/WASM sandbox loads
      * smoke       — end-to-end pipeline: JS build script -> blocks, .schem -> GLB
      * sandbox     — RULEBOOK.md section 3 containment guarantees
      * services    — main-process services, incl. the schematic write/read round-trip
      * schematics  — Sponge v2/v3 and MCEdit all decode to the same voxel grid
      * blocks       — block geometry: shapes, culling, texture orientation

    Unlike build.ps1, this does NOT stop at the first failure: a test runner that
    aborts early hides how much else is broken. Every suite runs, results are
    summarised, and the script exits non-zero if any of them failed.

.EXAMPLE
    .\scripts\check.ps1
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot '_common.ps1')

Install-DependenciesIfMissing

$steps = @(
    @{ Name = 'typecheck'; Script = 'typecheck' }
    @{ Name = 'hello';     Script = 'smoke:hello' }
    @{ Name = 'smoke';     Script = 'smoke' }
    @{ Name = 'sandbox';   Script = 'smoke:sandbox' }
    @{ Name = 'services';   Script = 'smoke:services' }
    @{ Name = 'schematics'; Script = 'smoke:schematics' }
    @{ Name = 'blocks';     Script = 'smoke:blocks' }
    @{ Name = 'document';   Script = 'smoke:document' }
    @{ Name = 'history';    Script = 'smoke:history' }
    @{ Name = 'formats';    Script = 'smoke:formats' }
)

$failed = @()

foreach ($step in $steps) {
    Write-Step $step.Name
    try {
        # Two separate arguments, not one array: `@(...)` is array construction,
        # not splatting, and would arrive as the single token "run smoke:hello".
        Invoke-Npm run $step.Script
    }
    catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        $failed += $step.Name
    }
}

# ASCII only — the console this runs in is not guaranteed to be UTF-8, and
# box-drawing characters come out as mojibake there.
$separator = '-' * 29

Write-Host ''
Write-Host $separator
foreach ($step in $steps) {
    if ($failed -contains $step.Name) {
        Write-Host ("  FAIL  {0}" -f $step.Name) -ForegroundColor Red
    }
    else {
        Write-Host ("  ok    {0}" -f $step.Name) -ForegroundColor Green
    }
}
Write-Host $separator

if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Host "$($failed.Count) check(s) failed: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host 'All checks passed.' -ForegroundColor Green
