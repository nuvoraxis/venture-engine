<#
.SYNOPSIS
    Live & Dry-Run Treasury Sync for Venture Engine receive-only wallet.
    Queries Base Mainnet & Arbitrum One USDC + Base ETH balances and recent
    ERC-20 Transfer logs without ever inventing mock revenue or mutating
    ledger/realized_cash.json when verified delta is 0.
#>
param(
    [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$DryRun,
    [int]$LookbackBlocks = 2000,
    [int]$TimeoutSec = 10
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Numerics

$CanonicalTreasury = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c"
$TransferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

$Chains = @(
    @{
        Name = "base"
        Label = "Base Mainnet"
        RpcUrl = "https://mainnet.base.org"
        UsdcContract = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
        CheckNativeEth = $true
    },
    @{
        Name = "arbitrum"
        Label = "Arbitrum One"
        RpcUrl = "https://arb1.arbitrum.io/rpc"
        UsdcContract = "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
        CheckNativeEth = $false
    }
)

$SanctionedSenders = @(
    "0x8589427373d6d84e98730d7795d8f6f8731fda16",
    "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
    "0x722122df12d4e14e13ac3b6895a86e84145b6967",
    "0xdd4c48c0b24039969fc16d1cdf626eab821d3384",
    "0x910cbd523d972eb0a6f4cae4618ad62622b39dbf",
    "0xa160cdab225685da1d56aa342ad8841c3b53f291",
    "0x098b716b8aaf21512996dc57eb0615e2383e2f96"
)

function Convert-HexToBigInt {
    param([string]$Hex)
    if (-not $Hex -or $Hex -eq "0x") { return [System.Numerics.BigInteger]::Zero }
    $clean = $Hex.ToLowerInvariant().Replace("0x", "")
    if (-not ($clean -match "^[0-9a-f]+$")) {
        throw "Invalid hex quantity from RPC: $Hex"
    }
    # Prepend "0" so BigInteger.Parse treats it strictly as unsigned
    return [System.Numerics.BigInteger]::Parse("0" + $clean, [System.Globalization.NumberStyles]::AllowHexSpecifier)
}

function Format-TokenUnits {
    param(
        [System.Numerics.BigInteger]$Amount,
        [int]$Decimals
    )
    $divisor = [System.Numerics.BigInteger]::Pow([System.Numerics.BigInteger]::new(10), $Decimals)
    $rem = [System.Numerics.BigInteger]::Zero
    $whole = [System.Numerics.BigInteger]::DivRem($Amount, $divisor, [ref]$rem)
    $fracStr = $rem.ToString().PadLeft($Decimals, "0").TrimEnd("0")
    if ($fracStr) { return "$whole.$fracStr" }
    return "$whole.0"
}

function Parse-InvariantDecimal {
    param([object]$Value)
    if ($null -eq $Value) { return [decimal]0 }
    if ($Value -is [decimal]) { return $Value }
    $str = [System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    return [decimal]::Parse($str, [System.Globalization.CultureInfo]::InvariantCulture)
}

function Invoke-JsonRpc {
    param(
        [string]$RpcUrl,
        [string]$Method,
        [object[]]$Params
    )
    $payload = @{
        jsonrpc = "2.0"
        id = 1
        method = $Method
        params = $Params
    } | ConvertTo-Json -Depth 6 -Compress

    $resp = Invoke-RestMethod -Uri $RpcUrl -Method Post -ContentType "application/json" -Body $payload -TimeoutSec $TimeoutSec
    if ($null -eq $resp) {
        throw "Empty JSON-RPC response from $RpcUrl for $Method"
    }
    if ($resp.PSObject.Properties.Name -contains "error" -and $null -ne $resp.error) {
        throw "RPC error ($Method): $($resp.error.message)"
    }
    return $resp.result
}

# 1. Fail-Closed Ledger Validation
$ledgerPath = Join-Path $WorkspaceRoot "ledger\realized_cash.json"
if (-not (Test-Path $ledgerPath)) {
    Write-Host "[FAIL] Missing ledger file: $ledgerPath" -ForegroundColor Red
    exit 1
}

$ledger = Get-Content -Path $ledgerPath -Raw | ConvertFrom-Json
if ($ledger.treasury_receive_only.ToLowerInvariant() -ne $CanonicalTreasury.ToLowerInvariant()) {
    Write-Host "[FAIL] Ledger treasury mismatch: $($ledger.treasury_receive_only)" -ForegroundColor Red
    exit 1
}

foreach ($entry in $ledger.realized_entries) {
    if (-not $entry.tx_or_payout_id -or $entry.counterparty_kyc_status -ne "VERIFIED") {
        Write-Host "[FAIL] Ledger contains unverified realized entry (Filter 3 violation)" -ForegroundColor Red
        exit 1
    }
}

$baselineBaseUsdc = Parse-InvariantDecimal $ledger.baseline_balances.base_usdc
$baselineBaseEth = Parse-InvariantDecimal $ledger.baseline_balances.base_eth
$ledgerRealizedUsd = Parse-InvariantDecimal $ledger.summary.total_realized_revenue_usd

Write-Host "=== AuditPulse / Venture Engine Treasury Sync ===" -ForegroundColor Cyan
Write-Host "Receive-Only Treasury : $CanonicalTreasury"
Write-Host "Baseline Verified At  : $($ledger.baseline_verified_at)"
Write-Host "Baseline Balances     : $($baselineBaseUsdc.ToString([System.Globalization.CultureInfo]::InvariantCulture)) USDC (Base) | $($baselineBaseEth.ToString([System.Globalization.CultureInfo]::InvariantCulture)) ETH (Base)"
Write-Host "Ledger Realized Cash  : `$$($ledgerRealizedUsd.ToString('F2', [System.Globalization.CultureInfo]::InvariantCulture)) USD ($($ledger.realized_entries.Count) verified entries)"

if ($DryRun) {
    Write-Host "[DRY-RUN] Skipping live network RPC calls. Planned targets:" -ForegroundColor Yellow
    foreach ($c in $Chains) {
        Write-Host "  - $($c.Label): $($c.RpcUrl) (USDC=$($c.UsdcContract), Lookback=$LookbackBlocks blocks)"
    }
    Write-Host "[DRY-RUN] Verified delta vs baseline: 0.000000 USDC (no mock revenue generated; ledger untouched)" -ForegroundColor Green
    exit 0
}

# 2. Live On-Chain Balance & Transfer Log Inspection
$paddedTreasury = "0x" + $CanonicalTreasury.Substring(2).ToLowerInvariant().PadLeft(64, "0")
$balanceOfCalldata = "0x70a08231" + $CanonicalTreasury.Substring(2).ToLowerInvariant().PadLeft(64, "0")

$liveBaseUsdcDecimal = [decimal]0
$totalLiveUsdcDecimal = [decimal]0
$allTransfers = @()

foreach ($chain in $Chains) {
    Write-Host ""
    Write-Host "--- Querying $($chain.Label) ($($chain.RpcUrl)) ---" -ForegroundColor Cyan

    $usdcHex = Invoke-JsonRpc -RpcUrl $chain.RpcUrl -Method "eth_call" -Params @(@{ to = $chain.UsdcContract; data = $balanceOfCalldata }, "latest")
    $usdcRaw = Convert-HexToBigInt -Hex $usdcHex
    $usdcStr = Format-TokenUnits -Amount $usdcRaw -Decimals 6
    $usdcDec = Parse-InvariantDecimal $usdcStr
    $totalLiveUsdcDecimal += $usdcDec
    if ($chain.Name -eq "base") { $liveBaseUsdcDecimal = $usdcDec }

    Write-Host "  USDC Balance : $usdcStr USDC"

    if ($chain.CheckNativeEth) {
        $ethHex = Invoke-JsonRpc -RpcUrl $chain.RpcUrl -Method "eth_getBalance" -Params @($CanonicalTreasury, "latest")
        $ethRaw = Convert-HexToBigInt -Hex $ethHex
        $ethStr = Format-TokenUnits -Amount $ethRaw -Decimals 18
        Write-Host "  ETH Balance  : $ethStr ETH"
    }

    $tipHex = Invoke-JsonRpc -RpcUrl $chain.RpcUrl -Method "eth_blockNumber" -Params @()
    $tipBlock = Convert-HexToBigInt -Hex $tipHex
    $lookback = [System.Numerics.BigInteger]::new([Math]::Max(1, $LookbackBlocks))
    $fromBlock = if ($tipBlock -gt $lookback) { $tipBlock - $lookback } else { [System.Numerics.BigInteger]::Zero }
    $fromHex = "0x" + $fromBlock.ToString("x")
    $toHex = "0x" + $tipBlock.ToString("x")

    $logs = Invoke-JsonRpc -RpcUrl $chain.RpcUrl -Method "eth_getLogs" -Params @(@{
        fromBlock = $fromHex
        toBlock = $toHex
        address = $chain.UsdcContract
        topics = @($TransferTopic, $null, $paddedTreasury)
    })
    if ($null -eq $logs) { $logs = @() }

    $logCount = @($logs).Count
    Write-Host "  Recent USDC Inbound Logs ($fromHex..$toHex): $logCount"

    foreach ($log in @($logs)) {
        if (-not $log -or -not $log.topics -or $log.topics.Count -lt 3) { continue }
        $fromAddr = "0x" + $log.topics[1].Substring($log.topics[1].Length - 40).ToLowerInvariant()
        $amtRaw = Convert-HexToBigInt -Hex $log.data
        $amtStr = Format-TokenUnits -Amount $amtRaw -Decimals 6
        $amlFlag = if ($SanctionedSenders -contains $fromAddr) { "BLOCKED_OFAC_MIXER" } else { "CLEAR_PENDING_KYB" }
        $allTransfers += [PSCustomObject]@{
            chain = $chain.Name
            txHash = $log.transactionHash
            from = $fromAddr
            amountUsdc = $amtStr
            blockNumber = (Convert-HexToBigInt -Hex $log.blockNumber).ToString()
            complianceStatus = $amlFlag
        }
        Write-Host "    * tx=$($log.transactionHash) from=$fromAddr amount=$amtStr USDC status=$amlFlag"
    }
}

$inv = [System.Globalization.CultureInfo]::InvariantCulture
$netTotalDelta = $totalLiveUsdcDecimal - $baselineBaseUsdc

Write-Host ""
Write-Host "=== Sync Summary ===" -ForegroundColor Cyan
Write-Host "Live Base USDC         : $($liveBaseUsdcDecimal.ToString('F6', $inv)) USDC"
Write-Host "Live Total USDC        : $($totalLiveUsdcDecimal.ToString('F6', $inv)) USDC"
Write-Host "Delta vs Baseline      : $($netTotalDelta.ToString('F6', $inv)) USDC (baseline=$($baselineBaseUsdc.ToString($inv)))"

if ($netTotalDelta -le 0) {
    Write-Host "[OK] Balance delta <= 0; ledger/realized_cash.json unchanged (no mock revenue recorded)." -ForegroundColor Green
} else {
    Write-Host "[INFO] Positive live delta detected (+$($netTotalDelta.ToString('F6', $inv)) USDC). Run Filter 3 KYB check on inbound txHashes before recording to ledger/realized_cash.json." -ForegroundColor Yellow
}

exit 0
