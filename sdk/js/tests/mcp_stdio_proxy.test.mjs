import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createStdioProxy, forwardJsonRpc } from "../src/mcp_stdio_proxy.mjs";

test("forwardJsonRpc sends JSON-RPC with X-Api-Key and parses response", async () => {
  let capturedUrl = null;
  let capturedInit = null;
  const mockFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const res = await forwardJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { mcpUrl: "https://example.test/mcp", apiKey: "ve_live_test", fetchImpl: mockFetch }
  );

  assert.equal(capturedUrl, "https://example.test/mcp");
  assert.equal(capturedInit.headers["X-Api-Key"], "ve_live_test");
  assert.deepEqual(res, { jsonrpc: "2.0", id: 1, result: { tools: [] } });
});

test("createStdioProxy forwards stdin lines to stdout and handles errors", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", (c) => chunks.push(c.toString("utf8")));

  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "fail") {
      throw new Error("upstream down");
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }), {
      status: 200
    });
  };

  const proxy = createStdioProxy({
    input,
    output,
    mcpUrl: "https://example.test/mcp",
    fetchImpl: mockFetch
  });

  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "fail" }) + "\n");
  input.end();

  await new Promise((r) => setTimeout(r, 40));
  await proxy.close();

  const lines = chunks.join("").trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(lines[1].id, 2);
  assert.equal(lines[1].error.code, -32603);
});
