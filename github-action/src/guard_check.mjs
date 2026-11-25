/**
 * Venture Engine CI/CD EVM Guard Check
 * Zero-dependency Node 20+ ESM runner for GitHub Actions & CLI.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_GATEWAY_URL = "https://venture-engine-gateway.leonid-ai-global.workers.dev";
const SUPPORTED_CHAINS = new Set(["base", "ethereum", "arbitrum"]);
const VALID_FAIL_VERDICTS = new Set(["BLOCK", "REVIEW"]);
const VERDICT_RANK = { ALLOW: 0, REVIEW: 1, BLOCK: 2 };
const MAX_ADDRESSES = 50;
const REQUEST_TIMEOUT_MS = 10000;

export function parseAddressList(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("Input 'addresses' is required and must contain at least one EVM address");
  }
  const tokens = raw
    .split(/[,\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error("Input 'addresses' must contain at least one EVM address");
  }
  if (tokens.length > MAX_ADDRESSES) {
    throw new Error(`Too many addresses (${tokens.length}); maximum allowed per run is ${MAX_ADDRESSES}`);
  }

  const seen = new Set();
  const unique = [];
  for (const addr of tokens) {
    const norm = addr.toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      unique.push(addr);
    }
  }
  return unique;
}

export function validateInputs({
  addresses,
  chain = "base",
  gatewayUrl = DEFAULT_GATEWAY_URL,
  apiKey = "",
  paymentTx = "",
  failOnVerdict = "BLOCK"
}) {
  const parsedAddresses = parseAddressList(addresses);
  const invalid = parsedAddresses.filter((a) => !/^0x[0-9a-fA-F]{40}$/.test(a));
  if (invalid.length > 0) {
    throw new Error(`Invalid EVM address format: ${invalid.join(", ")}`);
  }

  const normalizedChain = String(chain || "base").trim().toLowerCase();
  if (!SUPPORTED_CHAINS.has(normalizedChain)) {
    throw new Error(`Unsupported chain '${chain}'. Supported: ${[...SUPPORTED_CHAINS].join(", ")}`);
  }

  const rawUrl = String(gatewayUrl || DEFAULT_GATEWAY_URL).trim().replace(/\/+$/, "");
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid gateway-url '${gatewayUrl}'`);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error(`Invalid gateway-url protocol '${parsedUrl.protocol}' (expected https or http)`);
  }

  const normalizedFail = String(failOnVerdict || "BLOCK").trim().toUpperCase();
  if (!VALID_FAIL_VERDICTS.has(normalizedFail)) {
    throw new Error(`Invalid fail-on-verdict '${failOnVerdict}'. Expected BLOCK or REVIEW`);
  }

  const cleanApiKey = String(apiKey || "").trim();
  const cleanPaymentTx = String(paymentTx || "").trim();
  if (cleanPaymentTx && !/^0x[0-9a-fA-F]{64}$/.test(cleanPaymentTx)) {
    throw new Error("Invalid payment-tx format (expected 0x + 64 hex chars)");
  }

  return {
    addresses: parsedAddresses.map((a) => a.toLowerCase()),
    chain: normalizedChain,
    gatewayUrl: rawUrl,
    apiKey: cleanApiKey,
    paymentTx: cleanPaymentTx,
    failOnVerdict: normalizedFail
  };
}

export function verdictShouldFail(verdict, failOnVerdict) {
  const vRank = VERDICT_RANK[String(verdict || "ALLOW").toUpperCase()] ?? 0;
  const tRank = VERDICT_RANK[failOnVerdict] ?? VERDICT_RANK.BLOCK;
  return vRank >= tRank;
}

async function fetchJsonWithTimeout(url, headers, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON upstream error
    }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function writeGitHubOutput(outputPath, key, value) {
  if (!outputPath) return;
  const serialized = String(value).replace(/[\r\n]+/g, " ");
  fs.appendFileSync(outputPath, `${key}=${serialized}\n`, "utf8");
}

function writeStepSummary(summaryPath, markdown) {
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, markdown + "\n", "utf8");
}

/**
 * Executes the EVM guard check and returns `{ exitCode, mode, highestVerdict, results }`.
 */
export async function runGuardCheck(
  rawOptions = null,
  { fetchImpl = fetch, env = process.env, log = console.log, errorLog = console.error } = {}
) {
  const opts = rawOptions || {
    addresses: env.INPUT_ADDRESSES || "",
    chain: env.INPUT_CHAIN || "base",
    gatewayUrl: env.INPUT_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    apiKey: env.INPUT_API_KEY || "",
    paymentTx: env.INPUT_PAYMENT_TX || "",
    failOnVerdict: env.INPUT_FAIL_ON_VERDICT || "BLOCK"
  };

  let cfg;
  try {
    cfg = validateInputs(opts);
  } catch (err) {
    errorLog(`::error::${err.message}`);
    return { exitCode: 1, mode: "invalid", highestVerdict: "BLOCK", results: [], error: err.message };
  }

  const isAuthenticated = Boolean(cfg.apiKey || cfg.paymentTx);

  if (!isAuthenticated) {
    const demoUrl = `${cfg.gatewayUrl}/v1/demo?check=aegis`;
    const res = await fetchJsonWithTimeout(demoUrl, { Accept: "application/json" }, fetchImpl);
    if (!res.ok || !res.json) {
      const msg = `Gateway demo check failed (HTTP ${res.status}): ${res.json?.error || res.text || "unknown error"}`;
      errorLog(`::error::${msg}`);
      return { exitCode: 1, mode: "demo", highestVerdict: "ALLOW", results: [], error: msg };
    }

    const demoReport = res.json.result || res.json.report || res.json;
    const summaryRows = cfg.addresses.map((a) => `| \`${a}\` | ${cfg.chain} | DRY-DEMO | 0 |`);
    log(
      `::notice::Dry-demo mode: validated ${cfg.addresses.length} address(es) and verified Gateway /v1/demo?check=aegis (demo verdict=${demoReport.verdict || "UNKNOWN"}). Configure api-key or payment-tx for live per-address screening.`
    );
    writeGitHubOutput(env.GITHUB_OUTPUT, "results_json", JSON.stringify([demoReport]));
    writeGitHubOutput(env.GITHUB_OUTPUT, "highest_verdict", String(demoReport.verdict || "ALLOW"));
    writeStepSummary(
      env.GITHUB_STEP_SUMMARY,
      [
        "### Venture Engine EVM Guard (Dry-Demo Mode)",
        "",
        "| Address | Chain | Status | Risk Score |",
        "|---|---|---|---|",
        ...summaryRows
      ].join("\n")
    );
    return { exitCode: 0, mode: "demo", highestVerdict: String(demoReport.verdict || "ALLOW"), results: [demoReport] };
  }

  const headers = { Accept: "application/json" };
  if (cfg.apiKey) headers["X-Api-Key"] = cfg.apiKey;
  if (cfg.paymentTx) headers["X-Payment-Tx"] = cfg.paymentTx;

  const results = [];
  let highestVerdict = "ALLOW";
  let failed = false;

  for (const addr of cfg.addresses) {
    const screenUrl = `${cfg.gatewayUrl}/aegis/v1/screen?address=${encodeURIComponent(addr)}&chain=${encodeURIComponent(cfg.chain)}`;
    const res = await fetchJsonWithTimeout(screenUrl, headers, fetchImpl);
    if (!res.ok || !res.json?.report) {
      const errMsg = res.json?.paymentError || res.json?.error || `HTTP ${res.status}`;
      errorLog(`::error::Screening failed for ${addr} on ${cfg.chain}: ${errMsg}`);
      return { exitCode: 1, mode: "live", highestVerdict: "BLOCK", results, error: errMsg };
    }

    const report = res.json.report;
    const verdict = String(report.verdict || "ALLOW").toUpperCase();
    results.push(report);

    if ((VERDICT_RANK[verdict] ?? 0) > (VERDICT_RANK[highestVerdict] ?? 0)) {
      highestVerdict = verdict;
    }

    if (verdictShouldFail(verdict, cfg.failOnVerdict)) {
      failed = true;
      errorLog(
        `::error::EVM Guard ${verdict} for ${addr} on ${cfg.chain} (riskScore=${report.riskScore}, threshold=${cfg.failOnVerdict})`
      );
    } else if (verdict === "REVIEW") {
      log(`::warning::EVM Guard REVIEW for ${addr} on ${cfg.chain} (riskScore=${report.riskScore})`);
    } else {
      log(`[PASS] ${addr} (${cfg.chain}) -> ${verdict} (riskScore=${report.riskScore})`);
    }
  }

  writeGitHubOutput(env.GITHUB_OUTPUT, "results_json", JSON.stringify(results));
  writeGitHubOutput(env.GITHUB_OUTPUT, "highest_verdict", highestVerdict);
  writeStepSummary(
    env.GITHUB_STEP_SUMMARY,
    [
      "### Venture Engine EVM Guard Results",
      "",
      "| Address | Chain | Verdict | Risk Score | Contract |",
      "|---|---|---|---|---|",
      ...results.map(
        (r) => `| \`${r.address}\` | ${r.chain} | **${r.verdict}** | ${r.riskScore} | ${r.isContract ? "Yes" : "No"} |`
      )
    ].join("\n")
  );

  return { exitCode: failed ? 1 : 0, mode: "live", highestVerdict, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGuardCheck()
    .then((outcome) => {
      process.exitCode = outcome.exitCode;
    })
    .catch((err) => {
      console.error(`::error::Unhandled EVM Guard failure: ${err?.message || err}`);
      process.exitCode = 1;
    });
}
