<#
.SYNOPSIS
    Sequential Pre-Flight Verification for Venture Engine (4 GB RAM safe).
    1. Runs compliance/gate.ps1.
    2. Validates package.json & wrangler.toml manifests across all 6 components.
    3. Sequentially runs `npm test` in products/aegisgate, products/gaspulse,
       products/auditpulse, portal, distribution, and gateway.
    4. Inspects git status (when git CLI is present) without leaving dangling processes.
#>
param(
    [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$CanonicalTreasury = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c"

# Ensure Node.js is on PATH
$nodeDir = Join-Path $env:LOCALAPPDATA "Programs\nodejs"
if (Test-Path $nodeDir) {
    $env:PATH = "$nodeDir;$env:PATH"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "[FAIL] node/npm not found on PATH" -ForegroundColor Red
    exit 1
}

Write-Host "=== Venture Engine Sequential Deploy Preflight ===" -ForegroundColor Cyan

# 1. Compliance Gate
$gateScript = Join-Path $WorkspaceRoot "compliance\gate.ps1"
if (-not (Test-Path $gateScript)) {
    Write-Host "[FAIL] Missing compliance gate script: $gateScript" -ForegroundColor Red
    exit 1
}
& $gateScript -WorkspaceRoot $WorkspaceRoot
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FAIL] compliance/gate.ps1 exited with $LASTEXITCODE" -ForegroundColor Red
    exit 1
}

# 2. Validate manifests & run npm test sequentially across all 6 components
$Components = @(
    @{ RelPath = "products\aegisgate"; ExpectWrangler = $true },
    @{ RelPath = "products\gaspulse"; ExpectWrangler = $true },
    @{ RelPath = "products\auditpulse"; ExpectWrangler = $true },
    @{ RelPath = "portal"; ExpectWrangler = $true },
    @{ RelPath = "distribution"; ExpectWrangler = $false },
    @{ RelPath = "gateway"; ExpectWrangler = $true }
)

$Results = @()

foreach ($comp in $Components) {
    $dir = Join-Path $WorkspaceRoot $comp.RelPath
    if (-not (Test-Path $dir)) {
        Write-Host "[FAIL] Missing required component directory: $($comp.RelPath)" -ForegroundColor Red
        exit 1
    }

    $pkgPath = Join-Path $dir "package.json"
    if (-not (Test-Path $pkgPath)) {
        Write-Host "[FAIL] Missing package.json in $($comp.RelPath)" -ForegroundColor Red
        exit 1
    }
    $pkg = Get-Content -Path $pkgPath -Raw | ConvertFrom-Json
    if (-not $pkg.name -or $pkg.type -ne "module" -or -not $pkg.scripts.test) {
        Write-Host "[FAIL] Invalid ESM package.json in $($comp.RelPath) (require name, type=module, scripts.test)" -ForegroundColor Red
        exit 1
    }

    if ($comp.ExpectWrangler) {
        $wranglerPath = Join-Path $dir "wrangler.toml"
        if (-not (Test-Path $wranglerPath)) {
            Write-Host "[FAIL] Missing wrangler.toml in $($comp.RelPath)" -ForegroundColor Red
            exit 1
        }
        $wranglerRaw = Get-Content -Path $wranglerPath -Raw
        if ($wranglerRaw -notmatch "(?m)^name\s*=" -or $wranglerRaw -notmatch "(?m)^main\s*=" -or $wranglerRaw -notmatch "(?m)^compatibility_date\s*=") {
            Write-Host "[FAIL] wrangler.toml in $($comp.RelPath) missing required name/main/compatibility_date" -ForegroundColor Red
            exit 1
        }
        if ($wranglerRaw -match "TREASURY_ADDRESS\s*=\s*`"([^`"]+)`"") {
            if ($Matches[1].ToLowerInvariant() -ne $CanonicalTreasury.ToLowerInvariant()) {
                Write-Host "[FAIL] Non-canonical TREASURY_ADDRESS in $($comp.RelPath)\wrangler.toml" -ForegroundColor Red
                exit 1
            }
        }
        if ($wranglerRaw -match "(?m)^VE_TOKEN_SECRET\s*=") {
            Write-Host "[FAIL] VE_TOKEN_SECRET must be set via wrangler secret put, not committed in $($comp.RelPath)\wrangler.toml" -ForegroundColor Red
            exit 1
        }
    }

    Write-Host ""
    Write-Host "--- Running npm test in $($comp.RelPath) ---" -ForegroundColor Cyan
    Push-Location $dir
    try {
        npm test
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[FAIL] npm test failed in $($comp.RelPath) (exit $LASTEXITCODE)" -ForegroundColor Red
            exit 1
        }
    } finally {
        Pop-Location
    }

    $Results += [PSCustomObject]@{
        Component = $comp.RelPath
        Package = $pkg.name
        Wrangler = if ($comp.ExpectWrangler) { "OK" } else { "N/A" }
        TestStatus = "PASS"
    }
}

# 3. Git status check (non-fatal if git binary is not installed)
Write-Host ""
Write-Host "--- Checking Git Status ---" -ForegroundColor Cyan
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    $candidates = @(
        (Join-Path $env:ProgramFiles "Git\cmd\git.exe"),
        (Join-Path $env:ProgramFiles "Git\bin\git.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Git\cmd\git.exe")
    )
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) { $gitCmd = Get-Command $found }
}

if ($gitCmd) {
    Push-Location $WorkspaceRoot
    try {
        $isRepo = Test-Path (Join-Path $WorkspaceRoot ".git")
        if ($isRepo) {
            & $gitCmd.Source status --short
        } else {
            Write-Host "[WARN] Workspace is not yet initialized as a git repository (.git missing)" -ForegroundColor Yellow
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "[WARN] git CLI not found on PATH; install Git before pushing to GitHub" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Preflight Summary ===" -ForegroundColor Green
$Results | Format-Table -AutoSize
Write-Host "[PASS] All $($Components.Count) components and compliance/gate.ps1 passed preflight." -ForegroundColor Green
exit 0
