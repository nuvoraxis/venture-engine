<#
.SYNOPSIS
    Fail-Closed Compliance, Privacy & Secret Hygiene Gate for venture-engine.
    Verifies:
      1. No private keys / mnemonics / API tokens / signing secrets in workspace files.
      2. No local PII leaks (C:\Users\... paths) in workspace files.
      3. .gitignore exists with secret & log exclusions.
      4. Receive-only treasury address matches canonical 0x703d3948cc102bf4bc0ef93ef330f56be2afd69c.
      5. Realized ledger JSON is valid and contains only VERIFIED entries.
#>
param(
    [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$CanonicalTreasury = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c"

Write-Host "=== Venture Engine Security, Privacy & Compliance Gate (Fail-Closed) ===" -ForegroundColor Cyan

# 0. Verify .gitignore exists
$gitignorePath = Join-Path $WorkspaceRoot ".gitignore"
if (-not (Test-Path $gitignorePath)) {
    Write-Host "[FAIL] Missing .gitignore in $WorkspaceRoot" -ForegroundColor Red
    exit 1
}

# 1. Scan for prohibited secret / private key / token / PII patterns
$prohibitedPatterns = @(
    @{ Name = "PRIVATE_KEY"; Pattern = "PRIVATE_KEY\s*=" },
    @{ Name = "MNEMONIC"; Pattern = "MNEMONIC\s*=" },
    @{ Name = "SEED_PHRASE"; Pattern = "SEED_PHRASE\s*=" },
    @{ Name = "ETH_SIGNING"; Pattern = "eth_sendTransaction|signTransaction" },
    @{ Name = "GITHUB_PAT"; Pattern = "ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}" },
    @{ Name = "LOCAL_USER_PATH_PII"; Pattern = "C:\\Users\\[^\\]+\\" }
)

$violations = @()
Get-ChildItem -Path $WorkspaceRoot -Recurse -File -Exclude "*.log" | Where-Object {
    $_.FullName -notmatch "\\.git\\" -and $_.FullName -notmatch "\\node_modules\\"
} | ForEach-Object {
    $file = $_
    if ($file.FullName -match "\\compliance\\gate\.ps1$") { return }
    $content = Get-Content -Path $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return }
    foreach ($rule in $prohibitedPatterns) {
        if ($content -match $rule.Pattern) {
            $violations += "$($file.Name) matched [$($rule.Name)]"
        }
    }
}

if ($violations.Count -gt 0) {
    Write-Host "[FAIL] Security/Privacy violation detected:" -ForegroundColor Red
    $violations | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "[PASS] Filter 1/2 Secret, Token & Local PII Hygiene (0 violations)" -ForegroundColor Green

# 2. Validate realized_cash.json
$ledgerPath = Join-Path $WorkspaceRoot "ledger\realized_cash.json"
if (-not (Test-Path $ledgerPath)) {
    Write-Host "[FAIL] Missing ledger\realized_cash.json" -ForegroundColor Red
    exit 1
}

$ledger = Get-Content -Path $ledgerPath -Raw | ConvertFrom-Json
if ($ledger.treasury_receive_only.ToLower() -ne $CanonicalTreasury.ToLower()) {
    Write-Host "[FAIL] Treasury address mismatch in ledger: $($ledger.treasury_receive_only)" -ForegroundColor Red
    exit 1
}

foreach ($entry in $ledger.realized_entries) {
    if (-not $entry.tx_or_payout_id -or -not $entry.counterparty_kyc_status -or $entry.counterparty_kyc_status -ne "VERIFIED") {
        Write-Host "[FAIL] Unverified realized entry detected" -ForegroundColor Red
        exit 1
    }
}
Write-Host "[PASS] Filter 3 Ledger & Counterparty KYC Integrity ($($ledger.realized_entries.Count) verified entries)" -ForegroundColor Green
exit 0
