"""Venture Engine Unified Edge Gateway Client SDK (Zero-Dependency Python Stdlib)."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_GATEWAY_URL = "https://venture-engine-gateway.leonid-ai-global.workers.dev"
RECEIVE_ONLY_TREASURY = "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c"
BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"

_UNSET = object()


class VentureEngineError(Exception):
    """Raised when the Venture Engine Gateway returns an HTTP >= 400 or JSON-RPC error."""

    def __init__(self, status: int, message: str, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class VentureEngineClient:
    """Zero-dependency urllib.request client for AegisGate, GasPulse, AuditPulse, Portal KYB & MCP."""

    def __init__(
        self,
        base_url: str = DEFAULT_GATEWAY_URL,
        api_key: str | None = None,
        payment_tx: str | None = None,
        timeout_seconds: float = 15.0,
    ) -> None:
        self.base_url = (base_url or DEFAULT_GATEWAY_URL).rstrip("/")
        self.api_key = api_key
        self.payment_tx = payment_tx
        self.timeout_seconds = timeout_seconds

    def _request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        api_key: Any = _UNSET,
        payment_tx: Any = _UNSET,
    ) -> Any:
        url = self.base_url + path
        if query:
            filtered: dict[str, str] = {}
            for k, v in query.items():
                if v is None or v == "":
                    continue
                if isinstance(v, (list, tuple)):
                    filtered[k] = ",".join(str(item) for item in v)
                else:
                    filtered[k] = str(v)
            if filtered:
                url = f"{url}?{urllib.parse.urlencode(filtered)}"

        headers: dict[str, str] = {"Accept": "application/json"}
        effective_key = self.api_key if api_key is _UNSET else api_key
        effective_tx = self.payment_tx if payment_tx is _UNSET else payment_tx

        if effective_key:
            headers["X-Api-Key"] = str(effective_key)
        if effective_tx:
            headers["X-Payment-Tx"] = str(effective_tx)

        data_bytes: bytes | None = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data_bytes = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = {"raw": raw}
            msg = (
                (parsed or {}).get("error")
                or (parsed or {}).get("paymentError")
                or (parsed or {}).get("code")
                or f"HTTP {err.code}"
            )
            raise VentureEngineError(err.code, str(msg), parsed) from None

    def screen_address(
        self,
        address: str,
        *,
        chain: str = "base",
        api_key: Any = _UNSET,
        payment_tx: Any = _UNSET,
    ) -> Any:
        return self._request(
            "GET",
            "/aegis/v1/screen",
            query={"address": address, "chain": chain},
            api_key=api_key,
            payment_tx=payment_tx,
        )

    def estimate_gas(
        self,
        chain: str = "base",
        *,
        api_key: Any = _UNSET,
        payment_tx: Any = _UNSET,
    ) -> Any:
        return self._request(
            "GET",
            "/gaspulse/v1/gas",
            query={"chain": chain},
            api_key=api_key,
            payment_tx=payment_tx,
        )

    def simulate_transaction(
        self,
        payload: dict[str, Any],
        *,
        api_key: Any = _UNSET,
        payment_tx: Any = _UNSET,
    ) -> Any:
        return self._request(
            "POST",
            "/gaspulse/v1/simulate",
            body=payload,
            api_key=api_key,
            payment_tx=payment_tx,
        )

    def rpc_health(self, *, chain: str | None = None, probe: bool | None = None) -> Any:
        query: dict[str, Any] = {}
        if chain:
            query["chain"] = chain
        if probe is not None:
            query["probe"] = "true" if probe else "false"
        return self._request("GET", "/gaspulse/v1/rpc-health", query=query)

    def inspect_contract(
        self,
        address: str,
        *,
        chain: str = "base",
        tokens: list[str] | str | None = None,
        api_key: Any = _UNSET,
        payment_tx: Any = _UNSET,
    ) -> Any:
        return self._request(
            "GET",
            "/auditpulse/v1/inspect",
            query={"address": address, "chain": chain, "tokens": tokens},
            api_key=api_key,
            payment_tx=payment_tx,
        )

    def diff_snapshots(
        self,
        payload: dict[str, Any],
        *,
        api_key: Any = _UNSET,
        payment_tx: Any = _UNSET,
    ) -> Any:
        return self._request(
            "POST",
            "/auditpulse/v1/diff",
            body=payload,
            api_key=api_key,
            payment_tx=payment_tx,
        )

    def kyb_checkout(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/v1/kyb-checkout", body=payload)

    def verify_invoice(self, payload: dict[str, Any]) -> Any:
        return self._request("POST", "/v1/verify-invoice", body=payload)

    def call_mcp_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        *,
        request_id: int = 1,
        api_key: Any = _UNSET,
        payment_tx: Any = _UNSET,
    ) -> Any:
        rpc_res = self._request(
            "POST",
            "/mcp",
            body={
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            },
            api_key=api_key,
            payment_tx=payment_tx,
        )
        if isinstance(rpc_res, dict) and rpc_res.get("error"):
            raise VentureEngineError(400, str(rpc_res["error"].get("message", "MCP tool error")), rpc_res)
        return rpc_res

    # CamelCase aliases for JS SDK parity
    screenAddress = screen_address
    estimateGas = estimate_gas
    simulateTransaction = simulate_transaction
    rpcHealth = rpc_health
    inspectContract = inspect_contract
    diffSnapshots = diff_snapshots
    kybCheckout = kyb_checkout
    verifyInvoice = verify_invoice
    callMcpTool = call_mcp_tool
