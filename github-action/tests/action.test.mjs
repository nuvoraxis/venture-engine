import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAddressList, runGuardCheck, validateInputs, verdictShouldFail } from "../src/guard_check.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION_ROOT = path.resolve(__dirname, "..");

function makeMockGatewayFetch(handler) {
  return async (url, init) => {
    const res = await handler(String(url), init);
    return new Response(JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { "Content-Type": "application/json" }
    });
  };
}

test("PASS: screens comma/newline addresses with api-key and writes GitHub outputs", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ve-gh-action-"));
  const outputFile = path.join(tmpDir, "github_output.txt");
  const summaryFile = path.join(tmpDir, "github_summary.md");
  const seenUrls = [];

  try {
    const fetchImpl = makeMockGatewayFetch((url, init) => {
      seenUrls.push({ url, apiKey: init.headers["X-Api-Key"] });
      const addr = new URL(url).searchParams.get("address");
      return {
        status: 200,
        body: {
          report: { address: addr, chain: "base", verdict: "ALLOW", riskScore: 0, isContract: true }
        }
      };
    });

    const outcome = await runGuardCheck(
      {
        addresses: "0x1111111111111111111111111111111111111111,\n0x2222222222222222222222222222222222222222",
        chain: "base",
        apiKey: "ve_live_test_secret",
        failOnVerdict: "BLOCK"
      },
      {
        fetchImpl,
        env: { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile },
        log: () => {},
        errorLog: () => {}
      }
    );

    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.mode, "live");
    assert.equal(outcome.highestVerdict, "ALLOW");
    assert.equal(seenUrls.length, 2);
    assert.equal(seenUrls[0].apiKey, "ve_live_test_secret");

    const outputContent = fs.readFileSync(outputFile, "utf8");
    assert.ok(outputContent.includes("highest_verdict=ALLOW"));
    assert.ok(outputContent.includes("results_json="));

    const summaryContent = fs.readFileSync(summaryFile, "utf8");
    assert.ok(summaryContent.includes("0x1111111111111111111111111111111111111111"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("FAIL on BLOCK and REVIEW threshold enforcement", async () => {
  const errors = [];
  const blockFetch = makeMockGatewayFetch((url) => {
    const addr = new URL(url).searchParams.get("address");
    const isBad = addr === "0x8589427373d6d84e98730d7795d8f6f8731fda16";
    return {
      status: 200,
      body: {
        report: {
          address: addr,
          chain: "ethereum",
          verdict: isBad ? "BLOCK" : "ALLOW",
          riskScore: isBad ? 100 : 0,
          isContract: false
        }
      }
    };
  });

  const blockOutcome = await runGuardCheck(
    {
      addresses: "0x1111111111111111111111111111111111111111,0x8589427373d6d84e98730d7795d8f6f8731fda16",
      chain: "ethereum",
      apiKey: "test-key",
      failOnVerdict: "BLOCK"
    },
    { fetchImpl: blockFetch, env: {}, log: () => {}, errorLog: (m) => errors.push(m) }
  );

  assert.equal(blockOutcome.exitCode, 1);
  assert.equal(blockOutcome.highestVerdict, "BLOCK");
  assert.ok(errors.some((e) => e.includes("::error::EVM Guard BLOCK")));

  assert.equal(verdictShouldFail("REVIEW", "BLOCK"), false);
  assert.equal(verdictShouldFail("REVIEW", "REVIEW"), true);
  assert.equal(verdictShouldFail("BLOCK", "REVIEW"), true);
});

test("invalid address, chain, and threshold inputs fail fast before network calls", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error("Should not be called");
  };

  const badAddr = await runGuardCheck(
    { addresses: "not-an-evm-address", chain: "base", apiKey: "k" },
    { fetchImpl, env: {}, log: () => {}, errorLog: () => {} }
  );
  assert.equal(badAddr.exitCode, 1);
  assert.equal(called, false);

  assert.throws(() => parseAddressList(""), /at least one/);
  assert.throws(
    () => validateInputs({ addresses: "0x1111111111111111111111111111111111111111", chain: "solana" }),
    /Unsupported chain/
  );
  assert.throws(
    () => validateInputs({ addresses: "0x1111111111111111111111111111111111111111", failOnVerdict: "ALLOW" }),
    /Expected BLOCK or REVIEW/
  );
});

test("dry-demo fallback runs /v1/demo?check=aegis when neither api-key nor payment-tx is provided", async () => {
  const calledUrls = [];
  const logs = [];
  const fetchImpl = makeMockGatewayFetch((url) => {
    calledUrls.push(url);
    return {
      status: 200,
      body: {
        demo: true,
        check: "aegis",
        result: { address: "0x8589427373d6d84e98730d7795d8f6f8731fda16", verdict: "BLOCK", riskScore: 100 }
      }
    };
  });

  const outcome = await runGuardCheck(
    { addresses: "0x1111111111111111111111111111111111111111" },
    { fetchImpl, env: {}, log: (m) => logs.push(m), errorLog: () => {} }
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.mode, "demo");
  assert.equal(calledUrls.length, 1);
  assert.ok(calledUrls[0].endsWith("/v1/demo?check=aegis"));
  assert.ok(logs.some((l) => l.includes("::notice::Dry-demo mode")));
});

test("supports x402 payment-tx header and fails cleanly on HTTP 402", async () => {
  const txHash = "0x" + "a".repeat(64);
  const fetch402 = makeMockGatewayFetch((_url, init) => {
    assert.equal(init.headers["X-Payment-Tx"], txHash);
    return { status: 402, body: { error: "Payment Required", paymentError: "INSUFFICIENT_USDC_AMOUNT" } };
  });

  const outcome = await runGuardCheck(
    { addresses: "0x1111111111111111111111111111111111111111", paymentTx: txHash },
    { fetchImpl: fetch402, env: {}, log: () => {}, errorLog: () => {} }
  );
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.error, "INSUFFICIENT_USDC_AMOUNT");
});

test("github-action files contain zero local PII paths", async () => {
  const userPathRegex = new RegExp(["C:", "Users", "[^\\\\]+", ""].join("\\\\"));
  for (const rel of ["action.yml", "package.json", "README.md", "src/guard_check.mjs", "tests/action.test.mjs"]) {
    const content = fs.readFileSync(path.join(ACTION_ROOT, rel), "utf8");
    assert.equal(userPathRegex.test(content), false, `${rel} must not contain local home path`);
  }
});
