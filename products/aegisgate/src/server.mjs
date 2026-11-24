import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createAegisHandler, parseApiKeys } from "./app.mjs";

const PORT = Number(process.env.PORT || 8787);

function loadLandingHtml() {
  try {
    return readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  } catch {
    return null;
  }
}

function toWebRequest(req) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return new Request(url.toString(), { method: req.method || "GET", headers });
}

export function createAegisServer({
  fetchImpl = fetch,
  apiKeys = parseApiKeys(process.env.AEGISGATE_API_KEYS),
  consumedTxHashes = new Set(),
  landingHtml = loadLandingHtml()
} = {}) {
  const handleRequest = createAegisHandler({
    fetchImpl,
    apiKeys,
    consumedTxHashes,
    landingHtml
  });

  return http.createServer(async (req, res) => {
    const webRes = await handleRequest(toWebRequest(req));
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    const body = Buffer.from(await webRes.arrayBuffer());
    res.end(body);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createAegisServer();
  server.listen(PORT, () => {
    console.log(`AegisGate listening on http://localhost:${PORT}`);
  });
}
