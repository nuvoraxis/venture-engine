/**
 * AuditPulse Contract, ERC-20 & Pool Invariant Inspector
 * Checks live bytecode/proxy slots, owner/admin signals, ERC-20 sanity,
 * and pool/vault reserve balance invariants via JSON-RPC.
 */
import {
  SANCTIONED_OR_MIXER_ADDRESSES,
  ZERO_ADDRESS,
  normalizeAddress,
  resolveChainConfig,
  rpcCall,
  tryEthCall
} from "./chains.mjs";
import {
  analyzeBytecode,
  decodeAddress,
  decodeBool,
  decodeGetReserves,
  decodeStringOrBytes32,
  decodeUint256,
  encodeBalanceOf,
  formatUnits
} from "./abi.mjs";

export const STORAGE_SLOTS = {
  EIP1967_IMPL: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  EIP1967_ADMIN: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  EIP1967_BEACON: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  EIP1822_PROXIABLE: "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
  OZ_LEGACY_IMPL: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  SLOT_0: "0x0000000000000000000000000000000000000000000000000000000000000000"
};

export const ABI_SELECTORS = {
  owner: "0x8da5cb5b",
  admin: "0xf851a440",
  pendingOwner: "0xe30c3978",
  paused: "0x5c975abb",
  implementation: "0x5c60da1b",
  getOwner: "0x893d20e8",
  totalSupply: "0x18160ddd",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
  name: "0x06fdde03",
  balanceOf: "0x70a08231",
  getReserves: "0x0902f1ac",
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  kLast: "0x7464fc3d",
  slot0: "0x3850c7bd",
  liquidity: "0x1a686502",
  asset: "0x38d52e0f",
  totalAssets: "0x01e1d114"
};

const MAX_WATCH_TOKENS = 10;
const SEVERITY_WEIGHT = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };

function addFlag(flags, seenCodes, code, severity, detail) {
  if (seenCodes.has(code)) return;
  seenCodes.add(code);
  flags.push({ code, severity, detail });
}

async function fetchTokenBalanceSnapshot(rpcUrl, tokenAddr, holderAddr, labelHint, fetchImpl) {
  const [balHex, symHex, decHex] = await Promise.all([
    tryEthCall(rpcUrl, tokenAddr, encodeBalanceOf(holderAddr), fetchImpl),
    tryEthCall(rpcUrl, tokenAddr, ABI_SELECTORS.symbol, fetchImpl),
    tryEthCall(rpcUrl, tokenAddr, ABI_SELECTORS.decimals, fetchImpl)
  ]);

  const balance = decodeUint256(balHex);
  const symbol = decodeStringOrBytes32(symHex);
  const decimalsRaw = decodeUint256(decHex);
  const decimals = decimalsRaw !== null && decimalsRaw <= 36n ? Number(decimalsRaw) : null;

  return {
    token: tokenAddr,
    role: labelHint,
    symbol,
    decimals,
    balanceRaw: balance !== null ? balance.toString() : null,
    balanceFormatted: balance !== null && decimals !== null ? formatUnits(balance, decimals) : null
  };
}

function classifyRiskLevel(score, flags) {
  if (score >= 80 || flags.some((f) => f.severity === "CRITICAL")) return "CRITICAL";
  if (score >= 50 || flags.some((f) => f.severity === "HIGH")) return "HIGH";
  if (score >= 25 || flags.some((f) => f.severity === "MEDIUM")) return "MEDIUM";
  if (score > 0 || flags.some((f) => f.severity === "LOW")) return "LOW";
  return "SAFE";
}

function normalizeWatchTokens(tokens, targetAddress) {
  if (!tokens) return [];
  const rawList = Array.isArray(tokens)
    ? tokens
    : typeof tokens === "string"
      ? tokens.split(",").map((t) => t.trim()).filter(Boolean)
      : (() => {
          throw new Error("tokens must be an array or comma-separated string of EVM addresses");
        })();

  if (rawList.length > MAX_WATCH_TOKENS) {
    throw new Error(`Too many watch tokens (max ${MAX_WATCH_TOKENS})`);
  }
  const unique = [];
  const seen = new Set();
  for (const item of rawList) {
    const norm = normalizeAddress(item);
    if (!seen.has(norm) && norm !== ZERO_ADDRESS) {
      seen.add(norm);
      unique.push(norm);
    }
  }
  return unique;
}

/**
 * Inspects a smart contract, ERC-20 token, or DEX/Vault pool via live JSON-RPC.
 */
export async function inspectContractAndInvariants(
  address,
  { chain = "base", tokens = [], fetchImpl = fetch, rpcOverrides = {} } = {}
) {
  const target = normalizeAddress(address);
  if (target === ZERO_ADDRESS) {
    throw new Error("Cannot inspect the zero address");
  }
  const chainCfg = resolveChainConfig(chain, rpcOverrides);
  const customWatchTokens = normalizeWatchTokens(tokens, target);

  const flags = [];
  const seenCodes = new Set();
  let riskScore = 0;

  const sanctionedTarget = SANCTIONED_OR_MIXER_ADDRESSES.get(target);
  if (sanctionedTarget) {
    addFlag(flags, seenCodes, sanctionedTarget.category, "CRITICAL", sanctionedTarget.label);
    riskScore += 100;
  }

  // Phase 1: Base state + bytecode + proxy/admin storage slots
  const [
    blockNumberHex,
    nativeBalanceHex,
    codeHex,
    implSlotHex,
    adminSlotHex,
    beaconSlotHex,
    eip1822SlotHex,
    ozImplSlotHex,
    slot0Hex
  ] = await Promise.all([
    rpcCall(chainCfg.rpc, "eth_blockNumber", [], fetchImpl),
    rpcCall(chainCfg.rpc, "eth_getBalance", [target, "latest"], fetchImpl),
    rpcCall(chainCfg.rpc, "eth_getCode", [target, "latest"], fetchImpl),
    rpcCall(chainCfg.rpc, "eth_getStorageAt", [target, STORAGE_SLOTS.EIP1967_IMPL, "latest"], fetchImpl),
    rpcCall(chainCfg.rpc, "eth_getStorageAt", [target, STORAGE_SLOTS.EIP1967_ADMIN, "latest"], fetchImpl),
    rpcCall(chainCfg.rpc, "eth_getStorageAt", [target, STORAGE_SLOTS.EIP1967_BEACON, "latest"], fetchImpl),
    rpcCall(chainCfg.rpc, "eth_getStorageAt", [target, STORAGE_SLOTS.EIP1822_PROXIABLE, "latest"], fetchImpl),
    rpcCall(chainCfg.rpc, "eth_getStorageAt", [target, STORAGE_SLOTS.OZ_LEGACY_IMPL, "latest"], fetchImpl),
    rpcCall(chainCfg.rpc, "eth_getStorageAt", [target, STORAGE_SLOTS.SLOT_0, "latest"], fetchImpl)
  ]);

  const blockNumber = Number(BigInt(blockNumberHex || "0x0"));
  const nativeBalanceWei = BigInt(nativeBalanceHex || "0x0");
  const bytecode = await analyzeBytecode(codeHex);

  // If EOA / self-destructed contract (no bytecode), snapshot native + custom tokens and exit cleanly
  if (!bytecode.isContract) {
    addFlag(
      flags,
      seenCodes,
      "NOT_A_CONTRACT",
      "LOW",
      "Target address has no deployed bytecode on this chain (EOA or self-destructed)"
    );
    riskScore += 15;

    const customSnapshots = await Promise.all(
      customWatchTokens.map((tok) => fetchTokenBalanceSnapshot(chainCfg.rpc, tok, target, "custom", fetchImpl))
    );

    const clamped = Math.min(100, riskScore);
    const riskLevel = classifyRiskLevel(clamped, flags);
    return {
      address: target,
      chain,
      chainId: chainCfg.chainId,
      blockNumber,
      contractType: "EOA_OR_EMPTY",
      riskScore: clamped,
      riskLevel,
      invariantsPassed: !flags.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH"),
      bytecode,
      proxy: { isProxy: false, kind: null, implementationAddress: null, beaconAddress: null, implementationHasCode: null },
      admin: { proxyAdmin: null, owner: null, getOwner: null, adminView: null, effectiveAdmin: null, effectiveAdminIsEoa: null, pendingOwner: null, paused: null, slot0AddressCandidate: null },
      erc20: null,
      pool: null,
      reserves: {
        nativeWei: nativeBalanceWei.toString(),
        nativeFormatted: formatUnits(nativeBalanceWei, 18),
        tokens: customSnapshots
      },
      flags,
      inspectedAt: new Date().toISOString()
    };
  }

  // Phase 2: Read-only contract views (admin, ERC-20, V2/V3 pool, ERC-4626 vault)
  const [
    ownerHex,
    adminViewHex,
    pendingOwnerHex,
    pausedHex,
    implViewHex,
    getOwnerHex,
    totalSupplyHex,
    decimalsHex,
    symbolHex,
    nameHex,
    getReservesHex,
    token0Hex,
    token1Hex,
    kLastHex,
    slot0ViewHex,
    liquidityHex,
    assetHex,
    totalAssetsHex
  ] = await Promise.all([
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.owner, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.admin, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.pendingOwner, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.paused, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.implementation, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.getOwner, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.totalSupply, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.decimals, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.symbol, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.name, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.getReserves, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.token0, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.token1, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.kLast, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.slot0, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.liquidity, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.asset, fetchImpl),
    tryEthCall(chainCfg.rpc, target, ABI_SELECTORS.totalAssets, fetchImpl)
  ]);

  // Proxy resolution
  const eip1967Impl = decodeAddress(implSlotHex);
  const eip1967Admin = decodeAddress(adminSlotHex);
  const eip1967Beacon = decodeAddress(beaconSlotHex);
  const eip1822Impl = decodeAddress(eip1822SlotHex);
  const ozLegacyImpl = decodeAddress(ozImplSlotHex);
  const implView = decodeAddress(implViewHex);

  let proxyKind = null;
  let implementationAddress = null;
  if (eip1967Impl) {
    proxyKind = "EIP1967_TRANSPARENT_OR_UUPS";
    implementationAddress = eip1967Impl;
  } else if (eip1967Beacon) {
    proxyKind = "EIP1967_BEACON";
  } else if (eip1822Impl) {
    proxyKind = "EIP1822_UUPS";
    implementationAddress = eip1822Impl;
  } else if (ozLegacyImpl) {
    proxyKind = "OZ_LEGACY_PROXY";
    implementationAddress = ozLegacyImpl;
  } else if (bytecode.minimalProxyTarget) {
    proxyKind = "EIP1167_MINIMAL_PROXY";
    implementationAddress = bytecode.minimalProxyTarget;
  } else if (implView) {
    proxyKind = "CUSTOM_PROXY_VIEW";
    implementationAddress = implView;
  }
  const isProxy = proxyKind !== null;

  if (isProxy) {
    addFlag(
      flags,
      seenCodes,
      "UPGRADEABLE_PROXY_DETECTED",
      "MEDIUM",
      `Proxy (${proxyKind}) detected${implementationAddress ? ` pointing to ${implementationAddress}` : ""}`
    );
    riskScore += 15;
  }

  if (bytecode.opcodes.selfdestruct) {
    addFlag(flags, seenCodes, "SELFDESTRUCT_OPCODE_PRESENT", "HIGH", "Bytecode contains active SELFDESTRUCT opcode");
    riskScore += 45;
  }
  if (bytecode.opcodes.callcode) {
    addFlag(flags, seenCodes, "CALLCODE_OPCODE_PRESENT", "MEDIUM", "Bytecode contains legacy CALLCODE opcode");
    riskScore += 20;
  }
  if (bytecode.opcodes.delegatecall && !isProxy) {
    addFlag(
      flags,
      seenCodes,
      "DELEGATECALL_IN_NON_PROXY",
      "LOW",
      "Contract contains DELEGATECALL without standard proxy slot"
    );
    riskScore += 10;
  }

  // Admin / Owner resolution
  const owner = decodeAddress(ownerHex);
  const adminView = decodeAddress(adminViewHex);
  const getOwner = decodeAddress(getOwnerHex);
  const pendingOwner = decodeAddress(pendingOwnerHex);
  const paused = decodeBool(pausedHex);
  const slot0AddressCandidate = decodeAddress(slot0Hex);
  const effectiveAdmin = eip1967Admin || adminView || owner || getOwner || null;

  // Phase 3: Check code on implementation & effectiveAdmin + fetch reserve token balances
  const token0 = decodeAddress(token0Hex);
  const token1 = decodeAddress(token1Hex);
  const vaultAsset = decodeAddress(assetHex);

  const reserveTokenRequests = [];
  const addedReserveKeys = new Set();
  const queueReserveToken = (tok, role) => {
    if (!tok || tok === ZERO_ADDRESS || addedReserveKeys.has(tok)) return;
    addedReserveKeys.add(tok);
    reserveTokenRequests.push({ token: tok, role });
  };
  queueReserveToken(token0, "token0");
  queueReserveToken(token1, "token1");
  if (vaultAsset) queueReserveToken(vaultAsset, "vaultAsset");
  for (const customTok of customWatchTokens) {
    queueReserveToken(customTok, "custom");
  }

  const [implCodeHex, adminCodeHex, ...reserveSnapshots] = await Promise.all([
    implementationAddress
      ? rpcCall(chainCfg.rpc, "eth_getCode", [implementationAddress, "latest"], fetchImpl)
      : Promise.resolve(null),
    effectiveAdmin
      ? rpcCall(chainCfg.rpc, "eth_getCode", [effectiveAdmin, "latest"], fetchImpl)
      : Promise.resolve(null),
    ...reserveTokenRequests.map((item) =>
      fetchTokenBalanceSnapshot(chainCfg.rpc, item.token, target, item.role, fetchImpl)
    )
  ]);

  let implementationHasCode = null;
  if (implementationAddress) {
    implementationHasCode = Boolean(implCodeHex && implCodeHex !== "0x" && implCodeHex !== "0x0");
    if (!implementationHasCode) {
      addFlag(
        flags,
        seenCodes,
        "PROXY_IMPLEMENTATION_NO_CODE",
        "CRITICAL",
        `Proxy implementation ${implementationAddress} has no bytecode`
      );
      riskScore += 65;
    }
  }

  let effectiveAdminIsEoa = null;
  if (effectiveAdmin) {
    effectiveAdminIsEoa = !adminCodeHex || adminCodeHex === "0x" || adminCodeHex === "0x0";
    if (effectiveAdminIsEoa) {
      addFlag(
        flags,
        seenCodes,
        "EOA_ADMIN_CONTROL",
        "MEDIUM",
        `Privileged admin/owner ${effectiveAdmin} is an EOA rather than a multisig or timelock`
      );
      riskScore += 25;
    }
  }

  // Sanctions check on discovered privileged/implementation addresses
  for (const [roleLabel, addr] of [
    ["admin", effectiveAdmin],
    ["implementation", implementationAddress],
    ["beacon", eip1967Beacon],
    ["pendingOwner", pendingOwner]
  ]) {
    if (!addr) continue;
    const match = SANCTIONED_OR_MIXER_ADDRESSES.get(addr);
    if (match) {
      addFlag(
        flags,
        seenCodes,
        "SANCTIONED_RELATED_ADDRESS",
        "CRITICAL",
        `Related ${roleLabel} ${addr} matched ${match.label}`
      );
      riskScore += 100;
    }
  }

  if (pendingOwner) {
    addFlag(
      flags,
      seenCodes,
      "PENDING_OWNERSHIP_TRANSFER",
      "MEDIUM",
      `Pending ownership transfer to ${pendingOwner}`
    );
    riskScore += 15;
  }

  if (paused === true) {
    addFlag(flags, seenCodes, "CONTRACT_PAUSED", "HIGH", "Contract reports paused() === true");
    riskScore += 30;
  }

  // ERC-20 analysis & sanity checks
  const totalSupply = decodeUint256(totalSupplyHex);
  const decimalsBig = decodeUint256(decimalsHex);
  const symbol = decodeStringOrBytes32(symbolHex);
  const name = decodeStringOrBytes32(nameHex);
  const isErc20Like = totalSupply !== null || (decimalsBig !== null && symbol !== null);

  let erc20 = null;
  if (isErc20Like) {
    const decimals = decimalsBig !== null && decimalsBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(decimalsBig) : null;
    const isValidDecimals = decimals !== null && decimals >= 0 && decimals <= 36;

    if (decimals === null && totalSupply !== null) {
      addFlag(flags, seenCodes, "ERC20_MISSING_DECIMALS", "LOW", "Token exposes totalSupply() without readable decimals()");
      riskScore += 10;
    } else if (decimals !== null && decimals > 36) {
      addFlag(flags, seenCodes, "ERC20_INVALID_DECIMALS", "HIGH", `ERC-20 decimals(${decimals}) exceeds sane upper bound (36)`);
      riskScore += 40;
    } else if (decimals !== null && decimals > 18) {
      addFlag(flags, seenCodes, "ERC20_UNUSUAL_DECIMALS", "MEDIUM", `ERC-20 decimals(${decimals}) exceeds standard 18`);
      riskScore += 15;
    }

    if (totalSupply !== null) {
      if (totalSupply === 0n && (symbol !== null || decimals !== null)) {
        addFlag(flags, seenCodes, "ERC20_ZERO_TOTAL_SUPPLY", "HIGH", "Token contract reports totalSupply() === 0");
        riskScore += 30;
      }
      if (totalSupply >= (1n << 250n)) {
        addFlag(flags, seenCodes, "ERC20_EXTREME_TOTAL_SUPPLY", "HIGH", "Token totalSupply() is near uint256 overflow range");
        riskScore += 35;
      }
    }

    erc20 = {
      name,
      symbol,
      decimals,
      decimalsSane: isValidDecimals,
      totalSupplyRaw: totalSupply !== null ? totalSupply.toString() : null,
      totalSupplyFormatted: totalSupply !== null && isValidDecimals ? formatUnits(totalSupply, decimals) : null
    };
  }

  // Pool / Vault Invariant Analysis
  const reservesDecoded = decodeGetReserves(getReservesHex);
  const kLast = decodeUint256(kLastHex);
  const liquidity = decodeUint256(liquidityHex);
  const hasSlot0 = slot0ViewHex !== null && slot0ViewHex.length >= 130;
  const totalAssets = decodeUint256(totalAssetsHex);

  const snapshotByToken = new Map(reserveSnapshots.map((s) => [s.token, s]));
  let pool = null;

  if (reservesDecoded && token0 && token1) {
    const { reserve0, reserve1, blockTimestampLast } = reservesDecoded;
    const snap0 = snapshotByToken.get(token0);
    const snap1 = snapshotByToken.get(token1);
    const actual0 = snap0?.balanceRaw !== null && snap0?.balanceRaw !== undefined ? BigInt(snap0.balanceRaw) : null;
    const actual1 = snap1?.balanceRaw !== null && snap1?.balanceRaw !== undefined ? BigInt(snap1.balanceRaw) : null;

    if (reserve0 === 0n || reserve1 === 0n) {
      addFlag(
        flags,
        seenCodes,
        "POOL_ZERO_RESERVES",
        "HIGH",
        `V2 pool has empty reserve (reserve0=${reserve0}, reserve1=${reserve1})`
      );
      riskScore += 60;
    }

    for (const [label, reserve, actual] of [
      ["token0", reserve0, actual0],
      ["token1", reserve1, actual1]
    ]) {
      if (actual === null) continue;
      if (actual < reserve) {
        addFlag(
          flags,
          seenCodes,
          "POOL_RESERVE_UNDERCOLLATERALIZED",
          "CRITICAL",
          `${label} actual balance (${actual}) is below reported reserve (${reserve})`
        );
        riskScore += 85;
      } else if (reserve > 0n && (actual - reserve) * 100n > reserve * 5n) {
        addFlag(
          flags,
          seenCodes,
          "POOL_RESERVE_UNSYNCED_SURPLUS",
          "MEDIUM",
          `${label} actual balance (${actual}) exceeds reported reserve (${reserve}) by >5%`
        );
        riskScore += 20;
      }
    }

    pool = {
      protocolStyle: "UNISWAP_V2",
      token0,
      token1,
      reserve0: reserve0.toString(),
      reserve1: reserve1.toString(),
      actualBalance0: actual0 !== null ? actual0.toString() : null,
      actualBalance1: actual1 !== null ? actual1.toString() : null,
      constantProductK: (reserve0 * reserve1).toString(),
      kLast: kLast !== null ? kLast.toString() : null,
      blockTimestampLast
    };
  } else if (token0 && token1 && (hasSlot0 || liquidity !== null)) {
    if (liquidity === 0n) {
      addFlag(
        flags,
        seenCodes,
        "POOL_V3_ZERO_LIQUIDITY",
        "HIGH",
        "Concentrated-liquidity pool reports active liquidity() === 0"
      );
      riskScore += 35;
    }
    const snap0 = snapshotByToken.get(token0);
    const snap1 = snapshotByToken.get(token1);
    pool = {
      protocolStyle: "UNISWAP_V3",
      token0,
      token1,
      liquidity: liquidity !== null ? liquidity.toString() : null,
      actualBalance0: snap0?.balanceRaw ?? null,
      actualBalance1: snap1?.balanceRaw ?? null
    };
  } else if (vaultAsset && totalAssets !== null) {
    const assetSnap = snapshotByToken.get(vaultAsset);
    const actualAsset = assetSnap?.balanceRaw !== null && assetSnap?.balanceRaw !== undefined ? BigInt(assetSnap.balanceRaw) : null;

    if (totalSupply !== null && totalSupply > 0n && totalAssets === 0n) {
      addFlag(
        flags,
        seenCodes,
        "VAULT_INSOLVENT_ZERO_ASSETS",
        "CRITICAL",
        "ERC-4626 vault has non-zero shares but totalAssets() === 0"
      );
      riskScore += 85;
    } else if (actualAsset !== null && actualAsset < totalAssets) {
      addFlag(
        flags,
        seenCodes,
        "VAULT_ASSET_SHORTFALL",
        "CRITICAL",
        `Vault underlying balance (${actualAsset}) is less than totalAssets (${totalAssets})`
      );
      riskScore += 75;
    }

    pool = {
      protocolStyle: "ERC4626_VAULT",
      asset: vaultAsset,
      totalAssets: totalAssets.toString(),
      actualAssetBalance: actualAsset !== null ? actualAsset.toString() : null,
      totalShares: totalSupply !== null ? totalSupply.toString() : null
    };
  }

  let contractType = "CONTRACT";
  if (pool) contractType = pool.protocolStyle;
  else if (isProxy && erc20) contractType = "PROXY_ERC20";
  else if (isProxy) contractType = "PROXY";
  else if (erc20) contractType = "ERC20";

  flags.sort((a, b) => (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0));

  const clampedScore = Math.min(100, riskScore);
  const riskLevel = classifyRiskLevel(clampedScore, flags);
  const invariantsPassed = !flags.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH");

  return {
    address: target,
    chain,
    chainId: chainCfg.chainId,
    blockNumber,
    contractType,
    riskScore: clampedScore,
    riskLevel,
    invariantsPassed,
    bytecode,
    proxy: {
      isProxy,
      kind: proxyKind,
      implementationAddress,
      beaconAddress: eip1967Beacon,
      implementationHasCode
    },
    admin: {
      proxyAdmin: eip1967Admin,
      owner,
      getOwner,
      adminView,
      effectiveAdmin,
      effectiveAdminIsEoa,
      pendingOwner,
      paused,
      slot0AddressCandidate
    },
    erc20,
    pool,
    reserves: {
      nativeWei: nativeBalanceWei.toString(),
      nativeFormatted: formatUnits(nativeBalanceWei, 18),
      tokens: reserveSnapshots
    },
    flags,
    inspectedAt: new Date().toISOString()
  };
}
