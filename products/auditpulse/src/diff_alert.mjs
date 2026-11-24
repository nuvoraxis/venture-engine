/**
 * AuditPulse Risk Diff Engine & Webhook Alert Formatter
 * Compares two inspection snapshots to detect bytecode mutations, proxy upgrades,
 * admin takeovers, ERC-20 supply anomalies, and pool reserve/invariant drops.
 */
import { computeChangeBps } from "./abi.mjs";

const SEVERITY_RANK = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const VALID_WEBHOOK_FORMATS = new Set(["generic", "slack", "discord"]);

function maxSeverity(a, b) {
  return (SEVERITY_RANK[a] || 0) >= (SEVERITY_RANK[b] || 0) ? a : b;
}

function parseBigIntField(val) {
  if (val === null || val === undefined) return null;
  try {
    return BigInt(val);
  } catch {
    return null;
  }
}

function validateSnapshot(snap, label) {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    throw new Error(`${label} snapshot must be an object`);
  }
  if (typeof snap.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(snap.address)) {
    throw new Error(`${label} snapshot is missing a valid EVM address`);
  }
  if (typeof snap.chain !== "string" || !snap.chain) {
    throw new Error(`${label} snapshot is missing chain`);
  }
}

function pushChange(changes, type, severity, detail, extras = {}) {
  changes.push({ type, severity, detail, ...extras });
}

function validatePctThreshold(val, name) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0 || num > 100) {
    throw new Error(`${name} must be a finite number in (0, 100]`);
  }
  return Math.max(1, Math.round(num * 100));
}

/**
 * Computes a deterministic risk diff between `previous` and `current` inspection snapshots.
 */
export function diffInspectionSnapshots(
  previous,
  current,
  { reserveDropPctThreshold = 10, supplyChangePctThreshold = 20 } = {}
) {
  validateSnapshot(previous, "previous");
  validateSnapshot(current, "current");

  if (previous.address.toLowerCase() !== current.address.toLowerCase()) {
    throw new Error("Snapshot address mismatch: previous and current must inspect the same contract");
  }
  if (previous.chain !== current.chain) {
    throw new Error("Snapshot chain mismatch: previous and current must use the same chain");
  }

  const reserveDropBpsThreshold = validatePctThreshold(reserveDropPctThreshold, "reserveDropPctThreshold");
  const supplyBpsThreshold = validatePctThreshold(supplyChangePctThreshold, "supplyChangePctThreshold");

  const changes = [];

  // 1. Bytecode & Proxy Integrity
  const prevIsContract = Boolean(previous.bytecode?.isContract);
  const currIsContract = Boolean(current.bytecode?.isContract);
  if (prevIsContract && !currIsContract) {
    pushChange(changes, "CONTRACT_CODE_REMOVED", "CRITICAL", "Deployed bytecode disappeared (possible SELFDESTRUCT)");
  } else if (
    previous.bytecode?.bytecodeSha256 &&
    current.bytecode?.bytecodeSha256 &&
    previous.bytecode.bytecodeSha256 !== current.bytecode.bytecodeSha256
  ) {
    pushChange(changes, "BYTECODE_CHANGED", "CRITICAL", "Contract bytecode SHA-256 changed between snapshots", {
      previousHash: previous.bytecode.bytecodeSha256,
      currentHash: current.bytecode.bytecodeSha256
    });
  }

  if ((previous.proxy?.implementationAddress || null) !== (current.proxy?.implementationAddress || null)) {
    pushChange(changes, "PROXY_IMPLEMENTATION_CHANGED", "CRITICAL", "Proxy implementation address changed", {
      previous: previous.proxy?.implementationAddress || null,
      current: current.proxy?.implementationAddress || null
    });
  }

  if (!previous.bytecode?.opcodes?.selfdestruct && current.bytecode?.opcodes?.selfdestruct) {
    pushChange(changes, "SELFDESTRUCT_OPCODE_ADDED", "HIGH", "SELFDESTRUCT opcode appeared in active bytecode");
  }

  // 2. Admin / Governance Signals
  if ((previous.admin?.effectiveAdmin || null) !== (current.admin?.effectiveAdmin || null)) {
    pushChange(changes, "ADMIN_CHANGED", "CRITICAL", "Effective owner/admin address changed", {
      previous: previous.admin?.effectiveAdmin || null,
      current: current.admin?.effectiveAdmin || null
    });
  }

  if ((previous.admin?.proxyAdmin || null) !== (current.admin?.proxyAdmin || null)) {
    pushChange(changes, "PROXY_ADMIN_CHANGED", "CRITICAL", "EIP-1967 proxy admin slot changed", {
      previous: previous.admin?.proxyAdmin || null,
      current: current.admin?.proxyAdmin || null
    });
  }

  if ((previous.admin?.pendingOwner || null) !== (current.admin?.pendingOwner || null)) {
    pushChange(changes, "PENDING_OWNER_CHANGED", "MEDIUM", "pendingOwner() changed", {
      previous: previous.admin?.pendingOwner || null,
      current: current.admin?.pendingOwner || null
    });
  }

  if (previous.admin?.paused !== true && current.admin?.paused === true) {
    pushChange(changes, "CONTRACT_PAUSED_TRIGGERED", "HIGH", "Contract transitioned to paused() === true");
  } else if (previous.admin?.paused === true && current.admin?.paused === false) {
    pushChange(changes, "CONTRACT_UNPAUSED", "LOW", "Contract transitioned from paused to unpaused");
  }

  // 3. ERC-20 Supply & Decimals Sanity
  if (previous.erc20 && current.erc20) {
    if (previous.erc20.decimals !== current.erc20.decimals) {
      pushChange(changes, "ERC20_DECIMALS_MUTATED", "CRITICAL", "ERC-20 decimals() changed", {
        previous: previous.erc20.decimals,
        current: current.erc20.decimals
      });
    }

    const prevSup = parseBigIntField(previous.erc20.totalSupplyRaw);
    const currSup = parseBigIntField(current.erc20.totalSupplyRaw);
    if (prevSup !== null && currSup !== null && prevSup !== currSup) {
      const bps = computeChangeBps(prevSup, currSup);
      if (bps !== null && Math.abs(bps) >= supplyBpsThreshold) {
        const direction = bps > 0 ? "SUPPLY_INFLATED" : "SUPPLY_CONTRACTED";
        const pct = (bps / 100).toFixed(2);
        pushChange(changes, direction, Math.abs(bps) >= 5000 ? "CRITICAL" : "HIGH", `ERC-20 totalSupply changed by ${pct}%`, {
          previous: prevSup.toString(),
          current: currSup.toString(),
          changeBps: bps
        });
      }
    }
  }

  // 4. Pool & Reserve Balance Invariant Drift
  const checkDrop = (type, label, prevVal, currVal) => {
    const p = parseBigIntField(prevVal);
    const c = parseBigIntField(currVal);
    if (p === null || c === null || p <= 0n) return;
    const bps = computeChangeBps(p, c);
    if (bps !== null && bps <= -reserveDropBpsThreshold) {
      const dropPct = Math.abs(bps / 100).toFixed(2);
      const sev = bps <= -5000 ? "CRITICAL" : "HIGH";
      pushChange(changes, type, sev, `${label} dropped by ${dropPct}%`, {
        previous: p.toString(),
        current: c.toString(),
        changeBps: bps
      });
    }
  };

  if (previous.pool && current.pool) {
    checkDrop("POOL_RESERVE0_DROP", "Pool reserve0", previous.pool.reserve0, current.pool.reserve0);
    checkDrop("POOL_RESERVE1_DROP", "Pool reserve1", previous.pool.reserve1, current.pool.reserve1);
    checkDrop("POOL_K_INVARIANT_DROP", "Constant product k", previous.pool.constantProductK, current.pool.constantProductK);
    checkDrop("POOL_V3_LIQUIDITY_DROP", "Active V3 liquidity", previous.pool.liquidity, current.pool.liquidity);
    checkDrop("VAULT_TOTAL_ASSETS_DROP", "Vault totalAssets", previous.pool.totalAssets, current.pool.totalAssets);
  }

  checkDrop("NATIVE_BALANCE_DROP", "Contract native balance", previous.reserves?.nativeWei, current.reserves?.nativeWei);

  const prevTokens = new Map((previous.reserves?.tokens || []).map((t) => [t.token?.toLowerCase(), t]));
  for (const currTok of current.reserves?.tokens || []) {
    const prevTok = prevTokens.get(currTok.token?.toLowerCase());
    if (!prevTok) continue;
    const label = currTok.symbol ? `Token ${currTok.symbol} (${currTok.token})` : `Token ${currTok.token}`;
    checkDrop("TOKEN_RESERVE_DROP", label, prevTok.balanceRaw, currTok.balanceRaw);
  }

  // 5. Flag Deltas
  const prevFlagMap = new Map((previous.flags || []).map((f) => [f.code, f]));
  const currFlagMap = new Map((current.flags || []).map((f) => [f.code, f]));

  const newFlags = [];
  for (const [code, flag] of currFlagMap.entries()) {
    if (!prevFlagMap.has(code)) {
      newFlags.push(flag);
      pushChange(changes, `NEW_FLAG_${code}`, flag.severity, `New risk flag raised: ${flag.detail}`);
    }
  }

  const resolvedFlags = [];
  for (const [code, flag] of prevFlagMap.entries()) {
    if (!currFlagMap.has(code)) {
      resolvedFlags.push(flag);
    }
  }

  let highestSeverity = "NONE";
  for (const c of changes) {
    highestSeverity = maxSeverity(highestSeverity, c.severity);
  }

  const riskScoreDelta = (current.riskScore || 0) - (previous.riskScore || 0);
  const alertTriggered = changes.some((c) => SEVERITY_RANK[c.severity] >= SEVERITY_RANK.MEDIUM);
  const summary =
    changes.length === 0
      ? `No material changes for ${current.address} on ${current.chain} (riskScore=${current.riskScore ?? 0})`
      : `[${highestSeverity}] ${changes.length} change(s) detected on ${current.chain}:${current.address}: ${changes
          .slice(0, 3)
          .map((c) => c.type)
          .join(", ")}`;

  return {
    address: current.address.toLowerCase(),
    chain: current.chain,
    blockRange: {
      from: previous.blockNumber ?? null,
      to: current.blockNumber ?? null
    },
    alertTriggered,
    alertSeverity: highestSeverity,
    riskScorePrevious: previous.riskScore ?? 0,
    riskScoreCurrent: current.riskScore ?? 0,
    riskScoreDelta,
    changes,
    newFlags,
    resolvedFlags,
    summary,
    comparedAt: new Date().toISOString()
  };
}

/**
 * Formats a risk diff into a ready-to-deliver webhook payload (generic JSON, Slack, or Discord).
 */
export function formatWebhookPayload(diff, format = "generic") {
  if (!VALID_WEBHOOK_FORMATS.has(format)) {
    throw new Error(`Unsupported webhook format '${format}'. Supported: generic, slack, discord`);
  }

  const eventId = `ap_${diff.chain}_${diff.address.slice(2, 10)}_${diff.blockRange?.to ?? "latest"}`;

  if (format === "slack") {
    const lines = diff.changes.length
      ? diff.changes.map((c) => `• *[${c.severity}] ${c.type}*: ${c.detail}`).join("\n")
      : "• No risk diff alerts triggered.";
    return {
      text: diff.summary,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `AuditPulse Alert [${diff.alertSeverity}]` }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Target:* \`${diff.chain}:${diff.address}\`\n*Risk Score:* ${diff.riskScorePrevious} -> ${diff.riskScoreCurrent}\n${lines}`
          }
        }
      ]
    };
  }

  if (format === "discord") {
    const colorMap = { CRITICAL: 0xdc2626, HIGH: 0xea580c, MEDIUM: 0xd97706, LOW: 0x2563eb, NONE: 0x16a34a };
    return {
      content: diff.summary,
      embeds: [
        {
          title: `AuditPulse Risk Diff [${diff.alertSeverity}]`,
          color: colorMap[diff.alertSeverity] ?? 0x2563eb,
          fields: [
            { name: "Contract", value: `${diff.chain}:${diff.address}`, inline: true },
            { name: "Risk Score", value: `${diff.riskScorePrevious} -> ${diff.riskScoreCurrent}`, inline: true },
            {
              name: "Changes",
              value: diff.changes.length
                ? diff.changes.map((c) => `[${c.severity}] ${c.type}: ${c.detail}`).join("\n").slice(0, 1024)
                : "None"
            }
          ],
          timestamp: diff.comparedAt
        }
      ]
    };
  }

  return {
    event: "auditpulse.risk_diff.v1",
    eventId,
    triggered: diff.alertTriggered,
    severity: diff.alertSeverity,
    address: diff.address,
    chain: diff.chain,
    blockRange: diff.blockRange,
    riskScore: {
      previous: diff.riskScorePrevious,
      current: diff.riskScoreCurrent,
      delta: diff.riskScoreDelta
    },
    summary: diff.summary,
    changes: diff.changes,
    newFlags: diff.newFlags,
    resolvedFlags: diff.resolvedFlags,
    timestamp: diff.comparedAt
  };
}
