import http from "node:http";
import { pathToFileURL } from "node:url";
import {
  MAX_JSON_BODY_BYTES,
  createAuditPulseHandler,
  parseApiKeySet
} from "./handler.mjs";
import { createBoundedReplayStore } from "./x402.mjs";

const DEFAULT_PORT = Number(process.env.PORT || 8788);
const DEFAULT_HOST = process.env.HOST || "127.0.0.1";

function readNodeRequestBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        const err = new Error(`Request body exceeds ${maxBytes} byte limit`);
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export function createAuditPulseServer({
  fetchImpl = fetch,
  apiKeys = parseApiKeySet(process.env.AUDITPULSE_API_KEYS),
  consumedTxHashes = createBoundedReplayStore(),
  rpcOverrides = {}
} = {}) {
  const handler = createAuditPulseHandler({
    fetchImpl,
    apiKeys,
    consumedTxHashes,
    rpcOverrides
  });

  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else if (v !== undefined) {
          headers.set(k, v);
        }
      }

      const init = { method: req.method || "GET", headers };
      if (init.method !== "GET" && init.method !== "HEAD") {
        init.body = await readNodeRequestBody(req);
      }

      const webReq = new Request(url.toString(), init);
      const webRes = await handler(webReq);

      const outHeaders = {};
      webRes.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      res.writeHead(webRes.status, outHeaders);
      const buf = Buffer.from(await webRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(JSON.stringify({ error: err?.message || "Bad Request" }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAuditPulseServer();
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`AuditPulse listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  });
}
