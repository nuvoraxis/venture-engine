import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.dirname(__dirname);
const REPO_ROOT = path.dirname(DIST_ROOT);

const CANONICAL_TREASURY = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c";
const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const EXPECTED_MCP_TOOLS = [
  "screen_evm_address",
  "estimate_gas",
  "simulate_transaction",
  "check_rpc_health",
  "inspect_contract_invariants",
  "diff_contract_snapshots",
  "verify_x402_payment"
];

const EXPECTED_GATEWAY_ROUTES = [
  "/mcp",
  "/aegis/v1/screen",
  "/gaspulse/v1/gas",
  "/gaspulse/v1/simulate",
  "/auditpulse/v1/inspect",
  "/auditpulse/v1/diff",
  "/v1/kyb-checkout",
  "/v1/verify-invoice"
];

const FORBIDDEN_PATTERNS = [
  { name: "PRIVATE_KEY_ASSIGNMENT", regex: new RegExp("PRIVATE_" + "KEY\\s*=") },
  { name: "MNEMONIC_ASSIGNMENT", regex: new RegExp("MNEMONIC" + "\\s*=") },
  { name: "SEED_PHRASE_ASSIGNMENT", regex: new RegExp("SEED_" + "PHRASE\\s*=") },
  { name: "ETH_SIGNING_METHOD", regex: new RegExp("eth_send" + "Transaction|sign" + "Transaction") },
  { name: "GITHUB_TOKEN", regex: new RegExp("ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}") },
  { name: "SECRET_TOKEN_PREFIX", regex: new RegExp("\\bsk-[A-Za-z0-9_-]{12,}") },
  { name: "LOCAL_USER_PII_PATH", regex: new RegExp("C:\\\\Users\\\\" + "[^\\\\]+\\\\") },
  { name: "PERSONAL_EMAIL_PII", regex: /[a-zA-Z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|icloud|yandex|mail)\.com/i }
];

function collectFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function stripFencedCodeBlocks(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

test("all JSON manifests in distribution/ parse cleanly and reference canonical Base USDC treasury & Gateway", () => {
  const jsonFiles = collectFiles(DIST_ROOT).filter((f) => f.endsWith(".json"));
  assert.ok(jsonFiles.length >= 4, "Expected at least 4 JSON files in distribution/");

  for (const file of jsonFiles) {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed, "object");
  }

  const suitePkg = JSON.parse(fs.readFileSync(path.join(DIST_ROOT, "mcp-suite", "package.json"), "utf8"));
  assert.equal(suitePkg.payment.treasury, CANONICAL_TREASURY);
  assert.equal(suitePkg.payment.asset, BASE_USDC_ADDRESS);
  assert.equal(suitePkg.payment.receiveOnly, true);

  for (const [name, srv] of Object.entries(suitePkg.servers)) {
    const resolvedEntry = path.resolve(DIST_ROOT, "mcp-suite", srv.entry);
    assert.ok(fs.existsSync(resolvedEntry), `Missing entry for ${name}: ${srv.entry}`);
  }

  const glama = JSON.parse(fs.readFileSync(path.join(DIST_ROOT, "mcp-suite", "glama.json"), "utf8"));
  assert.equal(glama.payment.treasury, CANONICAL_TREASURY);
  assert.equal(glama.remoteGateway.mcpEndpoint, "/mcp");
  assert.equal(glama.remoteGateway.kybCheckoutEndpoint, "/v1/kyb-checkout");
  assert.equal(glama.remoteGateway.verifyInvoiceEndpoint, "/v1/verify-invoice");

  const glamaTools = glama.servers.flatMap((s) => s.tools.map((t) => t.name));
  for (const tool of EXPECTED_MCP_TOOLS) {
    assert.ok(glamaTools.includes(tool), `glama.json missing MCP tool: ${tool}`);
  }
  for (const srv of glama.servers) {
    const target = path.resolve(REPO_ROOT, srv.args[0]);
    assert.ok(fs.existsSync(target), `glama.json target does not exist: ${srv.args[0]}`);
  }

  const x402Dir = JSON.parse(fs.readFileSync(path.join(DIST_ROOT, "catalogs", "x402-directory-entry.json"), "utf8"));
  assert.equal(x402Dir.publisher.receiveOnlyTreasury, CANONICAL_TREASURY);
  assert.equal(x402Dir.settlement.payTo, CANONICAL_TREASURY);
  assert.equal(x402Dir.settlement.asset, BASE_USDC_ADDRESS);
  assert.equal(x402Dir.settlement.statelessApiKeyPrefix, "ve_live_");
  assert.equal(x402Dir.unifiedGateway.mcpHttpEndpoint, "/mcp");
  assert.equal(x402Dir.unifiedGateway.portalOnboarding.kybCheckoutEndpoint, "/v1/kyb-checkout");
  assert.equal(x402Dir.unifiedGateway.portalOnboarding.verifyInvoiceEndpoint, "/v1/verify-invoice");
  assert.equal(x402Dir.services.length, 3);

  const gatewayPaths = x402Dir.services.flatMap((s) => s.endpoints.map((e) => e.gatewayPath));
  for (const expected of [
    "/aegis/v1/screen",
    "/gaspulse/v1/gas",
    "/gaspulse/v1/simulate",
    "/auditpulse/v1/inspect",
    "/auditpulse/v1/diff"
  ]) {
    assert.ok(gatewayPaths.includes(expected), `x402-directory-entry.json missing gatewayPath: ${expected}`);
  }

  const openapiResolved = path.resolve(REPO_ROOT, x402Dir.services[0].openapiPath);
  assert.ok(fs.existsSync(openapiResolved), "Missing referenced OpenAPI spec");
});

test("smithery.yaml contains required stdio schema and valid product entrypoint paths", () => {
  const smitheryPath = path.join(DIST_ROOT, "mcp-suite", "smithery.yaml");
  const yaml = fs.readFileSync(smitheryPath, "utf8");

  for (const requiredToken of ["startCommand:", "type: stdio", "configSchema:", "commandFunction:", "exampleConfig:"]) {
    assert.ok(yaml.includes(requiredToken), `smithery.yaml missing '${requiredToken}'`);
  }

  for (const product of ["aegisgate", "gaspulse", "auditpulse"]) {
    const relPath = `products/${product}/src/mcp_server.mjs`;
    assert.ok(yaml.includes(relPath), `smithery.yaml missing ${relPath}`);
    assert.ok(fs.existsSync(path.resolve(REPO_ROOT, relPath)), `Missing MCP entrypoint ${relPath}`);
  }
});

test("Unified Gateway docs, relative markdown links, and guides validate cleanly", () => {
  const mdFiles = collectFiles(DIST_ROOT).filter((f) => f.endsWith(".md"));
  assert.ok(mdFiles.length >= 6, "Expected at least 6 markdown files in distribution/");

  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;

  for (const mdFile of mdFiles) {
    const content = stripFencedCodeBlocks(fs.readFileSync(mdFile, "utf8"));
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      const rawTarget = match[1].trim();
      if (/^(https?:|mailto:|#)/i.test(rawTarget)) continue;
      const cleanTarget = rawTarget.split("#")[0];
      if (!cleanTarget) continue;
      const resolved = path.resolve(path.dirname(mdFile), cleanTarget);
      assert.ok(fs.existsSync(resolved), `Broken relative link in ${path.relative(DIST_ROOT, mdFile)}: ${rawTarget}`);
    }
  }

  const suiteReadme = fs.readFileSync(path.join(DIST_ROOT, "mcp-suite", "README.md"), "utf8");
  const prTemplate = fs.readFileSync(path.join(DIST_ROOT, "catalogs", "awesome-mcp-servers-pr.md"), "utf8");

  for (const route of EXPECTED_GATEWAY_ROUTES) {
    assert.ok(suiteReadme.includes(route), `mcp-suite/README.md missing Unified Gateway route: ${route}`);
    assert.ok(prTemplate.includes(route), `awesome-mcp-servers-pr.md missing Unified Gateway route: ${route}`);
  }
  assert.ok(suiteReadme.includes("ve_live_"), "mcp-suite/README.md missing stateless ve_live_ token reference");
  assert.ok(prTemplate.includes("ve_live_"), "awesome-mcp-servers-pr.md missing stateless ve_live_ token reference");

  const guideChecks = [
    { file: "01-x402-agent-aml-guard.md", routes: ["/aegis/v1/screen", "/v1/kyb-checkout", "/v1/verify-invoice", "/mcp"] },
    { file: "02-pre-flight-tx-simulation.md", routes: ["/gaspulse/v1/gas", "/gaspulse/v1/simulate", "/mcp"] },
    { file: "03-continuous-defi-invariant-monitoring.md", routes: ["/auditpulse/v1/inspect", "/auditpulse/v1/diff", "/mcp"] }
  ];

  for (const { file, routes } of guideChecks) {
    const guide = fs.readFileSync(path.join(DIST_ROOT, "guides", file), "utf8");
    assert.ok(guide.includes(CANONICAL_TREASURY), `${file} missing canonical treasury`);
    assert.ok(guide.includes(BASE_USDC_ADDRESS), `${file} missing Base USDC address`);
    assert.ok(guide.includes("ve_live_"), `${file} missing stateless ve_live_ API key mention`);
    assert.ok(guide.includes("curl "), `${file} missing cURL snippet`);
    assert.ok(guide.includes("fetch("), `${file} missing Node.js fetch snippet`);
    assert.ok(guide.includes("urllib.request"), `${file} missing Python snippet`);
    for (const r of routes) {
      assert.ok(guide.includes(r), `${file} missing Unified Gateway route: ${r}`);
    }
  }
});

test("zero forbidden secret patterns, signing calls, or PII paths exist in distribution/", () => {
  const files = collectFiles(DIST_ROOT);
  assert.ok(files.length >= 11);

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const rule of FORBIDDEN_PATTERNS) {
      assert.equal(
        rule.regex.test(content),
        false,
        `Forbidden pattern [${rule.name}] matched in ${path.relative(DIST_ROOT, file)}`
      );
    }
  }
});
