/**
 * Pure-ESM EVM ABI decoders, storage-slot decoders, and push-aware bytecode analyzer.
 * Strictly validates untrusted RPC outputs without eval, dynamic code, or external libs.
 */
import { ZERO_ADDRESS } from "./chains.mjs";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });
const MAX_DECODED_STRING_BYTES = 256;

export function isHexString(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * Decodes the first 32-byte ABI word as an unsigned integer (BigInt).
 */
export function decodeUint256(hex) {
  if (!isHexString(hex) || hex.length < 66) return null;
  try {
    return BigInt("0x" + hex.slice(2, 66));
  } catch {
    return null;
  }
}

/**
 * Decodes the first 32-byte ABI word as a strict boolean (0 or 1).
 */
export function decodeBool(hex) {
  const val = decodeUint256(hex);
  if (val === 0n) return false;
  if (val === 1n) return true;
  return null;
}

/**
 * Decodes a 32-byte ABI word as an EVM address, verifying the upper 12 bytes are zero.
 */
export function decodeAddress(hex, { allowZero = false } = {}) {
  if (!isHexString(hex) || hex.length < 66) return null;
  const word = hex.slice(2, 66).toLowerCase();
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) {
    return null;
  }
  const addr = "0x" + word.slice(24);
  if (!allowZero && addr === ZERO_ADDRESS) return null;
  return addr;
}

function hexToBytes(hexBody) {
  const bytes = new Uint8Array(hexBody.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexBody.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function sanitizeText(bytes) {
  // Strip null bytes and ASCII control chars (keep printable ASCII + valid UTF-8)
  const raw = TEXT_DECODER.decode(bytes).replace(/\0+$/g, "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned || null;
}

/**
 * Decodes either a standard ABI dynamic `string` or a legacy `bytes32` ASCII string (e.g., MKR).
 */
export function decodeStringOrBytes32(hex) {
  if (!isHexString(hex) || hex.length < 66) return null;
  const body = hex.slice(2);

  // Legacy bytes32 (single 32-byte word)
  if (body.length === 64) {
    return sanitizeText(hexToBytes(body));
  }

  // Standard ABI dynamic string: [offset (32B), length (32B), data...]
  if (body.length >= 128) {
    const offset = BigInt("0x" + body.slice(0, 64));
    if (offset === 32n) {
      const lengthBig = BigInt("0x" + body.slice(64, 128));
      if (lengthBig <= 0n || lengthBig > BigInt(MAX_DECODED_STRING_BYTES)) {
        return null;
      }
      const length = Number(lengthBig);
      const dataStart = 128;
      const dataEnd = dataStart + length * 2;
      if (dataEnd <= body.length) {
        return sanitizeText(hexToBytes(body.slice(dataStart, dataEnd)));
      }
    }
  }

  return null;
}

/**
 * Decodes Uniswap V2 / Solidly getReserves() -> (uint112, uint112, uint32).
 */
export function decodeGetReserves(hex) {
  if (!isHexString(hex) || hex.length < 194) return null;
  const body = hex.slice(2);
  const reserve0 = BigInt("0x" + body.slice(0, 64));
  const reserve1 = BigInt("0x" + body.slice(64, 128));
  const blockTimestampLastBig = BigInt("0x" + body.slice(128, 192));
  // uint112 max = (1n << 112n) - 1n; uint32 max = 0xffffffffn
  const maxUint112 = (1n << 112n) - 1n;
  if (reserve0 > maxUint112 || reserve1 > maxUint112 || blockTimestampLastBig > 0xffffffffn) {
    return null;
  }
  return {
    reserve0,
    reserve1,
    blockTimestampLast: Number(blockTimestampLastBig)
  };
}

/**
 * Encodes balanceOf(address) calldata (`0x70a08231`).
 */
export function encodeBalanceOf(accountAddress) {
  return "0x70a08231" + accountAddress.toLowerCase().slice(2).padStart(64, "0");
}

/**
 * Formats an unsigned BigInt token amount into a decimal string without floating-point precision loss.
 */
export function formatUnits(value, decimals = 18) {
  if (typeof value !== "bigint" || value < 0n) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  if (decimals === 0) return value.toString();

  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Computes basis-point difference ((curr - prev) * 10000 / prev) safely in BigInt.
 */
export function computeChangeBps(prev, curr) {
  if (typeof prev !== "bigint" || typeof curr !== "bigint") return null;
  if (prev === 0n) return curr === 0n ? 0 : null;
  return Number(((curr - prev) * 10000n) / prev);
}

/**
 * Computes SHA-256 hex digest of a string using Web Crypto (Node >=20 & Cloudflare Workers).
 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Walks EVM bytecode instructions skipping PUSH1..PUSH32 immediate data bytes so
 * embedded constants never trigger false opcode positives.
 */
export async function analyzeBytecode(codeHex) {
  const normalized = typeof codeHex === "string" ? codeHex.toLowerCase() : "0x";
  const isContract = Boolean(normalized && normalized !== "0x" && normalized !== "0x0" && /^0x[0-9a-f]+$/.test(normalized));

  if (!isContract) {
    return {
      isContract: false,
      bytecodeBytes: 0,
      bytecodeSha256: null,
      minimalProxyTarget: null,
      opcodes: {
        delegatecall: false,
        selfdestruct: false,
        callcode: false,
        create2: false
      }
    };
  }

  const hexBody = normalized.slice(2);
  const bytecodeBytes = Math.floor(hexBody.length / 2);

  // EIP-1167 Minimal Proxy: 363d3d373d3d3d363d73<20B>5af43d82803e903d91602b57fd5bf3
  let minimalProxyTarget = null;
  const eip1167Match = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(hexBody);
  if (eip1167Match) {
    minimalProxyTarget = "0x" + eip1167Match[1];
  }

  let delegatecall = false;
  let selfdestruct = false;
  let callcode = false;
  let create2 = false;

  for (let i = 0; i < bytecodeBytes; ) {
    const op = parseInt(hexBody.slice(i * 2, i * 2 + 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      // PUSH1 (0x60) skips 1 byte ... PUSH32 (0x7f) skips 32 bytes
      const pushLen = op - 0x5f;
      i += 1 + pushLen;
      continue;
    }
    if (op === 0xf2) callcode = true;
    else if (op === 0xf4) delegatecall = true;
    else if (op === 0xf5) create2 = true;
    else if (op === 0xff) selfdestruct = true;
    i += 1;
  }

  const bytecodeSha256 = await sha256Hex(normalized);
  return {
    isContract: true,
    bytecodeBytes,
    bytecodeSha256,
    minimalProxyTarget,
    opcodes: { delegatecall, selfdestruct, callcode, create2 }
  };
}
