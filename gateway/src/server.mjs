import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createGatewayHandler } from "./gateway.mjs";
import { parseStaticKeySet } from "./auth_tokens.mjs";

const DEFAULT_PORT = Number(process.env.PORT || 8780);
const DEFAULT_HOST = process.env.HOST || "127.0.0.1";
const MAX_NODE_BODY_BYTES = 512 * 1024;

function loadPortalAsset(relPath) {
  try {
    return readFileSync(new URL(relPath, import.meta.url), "utf8");
  } catch {
    return null;
  }
}

function readNodeRequestBody(req, maxBytes = MAX_NODE_BODY_BYTES) {
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

function toHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return headers;
}

export function createGatewayServer({
  fetchImpl = fetch,
  tokenSecret = process.env.VE_TOKEN_SECRET || "",
  apiKeys = parseStaticKeySet(process.env.VE_STATIC_API_KEYS),
  rpcOverrides = {},
  landingHtml = loadPortalAsset("../../portal/public/index.html"),
  llmsTxt = loadPortalAsset("../../portal/public/llms.txt")
} = {}) {
  const handleRequest = createGatewayHandler({
    fetchImpl,
    tokenSecret,
    apiKeys,
    rpcOverrides,
    landingHtml,
    llmsTxt
  });

  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);
      const method = req.method || "GET";
      const init = { method, headers: toHeaders(req.headers) };

      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        init.body = await readNodeRequestBody(req);
      }

      const webRes = await handleRequest(new Request(url.toString(), init));
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
      const body = Buffer.from(await webRes.arrayBuffer());
      res.end(body);
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 400;
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(JSON.stringify({ ok: false, error: err?.message || "Bad Request" }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createGatewayServer();
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`Venture Engine Gateway listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  });
}
