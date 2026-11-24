/**
 * Node.js HTTP Server for GasPulse & Mempool Guard.
 * Delegates all routing, auth, and simulation logic to src/app.mjs.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createGasPulseHandler } from "./app.mjs";

const MAX_INCOMING_BYTES = 65536;

function collectNodeRequestBody(req) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > MAX_INCOMING_BYTES) {
      const err = new Error(`Request body exceeds ${MAX_INCOMING_BYTES} byte limit`);
      err.statusCode = 413;
      err.oversized = true;
      req.resume();
      reject(err);
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_INCOMING_BYTES) {
        settled = true;
        chunks.length = 0;
        const err = new Error(`Request body exceeds ${MAX_INCOMING_BYTES} byte limit`);
        err.statusCode = 413;
        err.oversized = true;
        req.resume();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function toWebHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, String(value));
    }
  }
  return headers;
}

export function createGasPulseServer(options = {}) {
  const handleWebRequest = createGasPulseHandler(options);

  return http.createServer(async (req, res) => {
    try {
      const method = (req.method || "GET").toUpperCase();
      const url = `http://${req.headers.host || "127.0.0.1"}${req.url || "/"}`;
      const headers = toWebHeaders(req.headers);

      let body = undefined;
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        const rawBody = await collectNodeRequestBody(req);
        body = rawBody.length > 0 ? rawBody : "";
      }

      const webReq = new Request(url, { method, headers, body });
      const webRes = await handleWebRequest(webReq);

      const outHeaders = {};
      webRes.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      res.writeHead(webRes.status, outHeaders);
      const responseText = await webRes.text();
      res.end(responseText);
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      const outHeaders = {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      };
      if (err?.oversized) {
        outHeaders.Connection = "close";
      }
      res.writeHead(status, outHeaders);
      res.end(JSON.stringify({ error: err?.message || "Bad Request" }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8788);
  const host = process.env.HOST || "127.0.0.1";
  const server = createGasPulseServer({
    apiKeys: process.env.GASPULSE_API_KEYS || "",
    rpcOverrides: {
      base: process.env.BASE_RPCS,
      ethereum: process.env.ETHEREUM_RPCS,
      arbitrum: process.env.ARBITRUM_RPCS
    }
  });

  server.listen(port, host, () => {
    console.log(`GasPulse listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
