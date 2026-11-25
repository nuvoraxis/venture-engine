import sys

sys.dont_write_bytecode = True

import http.server
import json
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from venture_engine_sdk import (  # noqa: E402
    BASE_USDC_ADDRESS,
    DEFAULT_GATEWAY_URL,
    RECEIVE_ONLY_TREASURY,
    VentureEngineClient,
    VentureEngineError,
)


class _GatewayFixtureHandler(http.server.BaseHTTPRequestHandler):
    recorded: list[dict] = []

    def do_GET(self) -> None:
        self._handle("GET")

    def do_POST(self) -> None:
        self._handle("POST")

    def _handle(self, method: str) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else ""
        parsed_body = json.loads(raw_body) if raw_body else None

        self.__class__.recorded.append(
            {
                "method": method,
                "path": self.path,
                "api_key": self.headers.get("X-Api-Key"),
                "payment_tx": self.headers.get("X-Payment-Tx"),
                "body": parsed_body,
            }
        )

        if self.path == "/gaspulse/v1/gas?chain=base" and not self.headers.get("X-Api-Key"):
            payload = {
                "error": "Payment Required",
                "protocol": "x402",
                "accepts": [{"payTo": RECEIVE_ONLY_TREASURY, "maxAmountRequired": "10000"}],
            }
            self._write_json(402, payload)
            return

        self._write_json(200, {"ok": True, "path": self.path, "method": method})

    def _write_json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args) -> None:
        return


class TestVentureEnginePythonSdk(unittest.TestCase):
    server: http.server.ThreadingHTTPServer
    thread: threading.Thread
    base_url: str

    @classmethod
    def setUpClass(cls) -> None:
        _GatewayFixtureHandler.recorded = []
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _GatewayFixtureHandler)
        port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{port}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_all_client_methods_against_loopback_http_server(self) -> None:
        _GatewayFixtureHandler.recorded.clear()
        default_client = VentureEngineClient()
        self.assertEqual(default_client.base_url, DEFAULT_GATEWAY_URL)
        self.assertEqual(RECEIVE_ONLY_TREASURY, "0x703d3948cc102bf4bc0ef93ef330f56be2afd69c")
        self.assertEqual(BASE_USDC_ADDRESS, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")

        client = VentureEngineClient(base_url=self.base_url, api_key="ve_live_py")
        client.screen_address("0x2222222222222222222222222222222222222222", chain="ethereum")
        client.estimate_gas("arbitrum")
        client.simulate_transaction({"chain": "base", "to": "0x2222222222222222222222222222222222222222"})
        client.rpc_health(chain="base", probe=True)
        client.inspect_contract(
            "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
            chain="base",
            tokens=["0x1111111111111111111111111111111111111111"],
        )
        client.diff_snapshots({"previous": {"address": "0x2222222222222222222222222222222222222222"}})
        client.kyb_checkout({"companyName": "Acme Ltd", "jurisdiction": "AE", "plan": "starter"})
        client.verify_invoice({"invoiceId": "inv_1234", "txHash": "0x" + "a" * 64})
        client.call_mcp_tool(
            "estimate_gas",
            {"chain": "base"},
            api_key=None,
            payment_tx="0x" + "b" * 64,
        )

        rec = _GatewayFixtureHandler.recorded
        self.assertEqual(len(rec), 9)
        self.assertEqual(rec[0]["path"], "/aegis/v1/screen?address=0x2222222222222222222222222222222222222222&chain=ethereum")
        self.assertEqual(rec[0]["api_key"], "ve_live_py")
        self.assertEqual(rec[1]["path"], "/gaspulse/v1/gas?chain=arbitrum")
        self.assertEqual(rec[2]["path"], "/gaspulse/v1/simulate")
        self.assertEqual(rec[2]["method"], "POST")
        self.assertEqual(rec[3]["path"], "/gaspulse/v1/rpc-health?chain=base&probe=true")
        self.assertEqual(
            rec[4]["path"],
            "/auditpulse/v1/inspect?address=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&chain=base&tokens=0x1111111111111111111111111111111111111111",
        )
        self.assertEqual(rec[5]["path"], "/auditpulse/v1/diff")
        self.assertEqual(rec[6]["path"], "/v1/kyb-checkout")
        self.assertEqual(rec[7]["path"], "/v1/verify-invoice")
        self.assertEqual(rec[8]["path"], "/mcp")
        self.assertIsNone(rec[8]["api_key"])
        self.assertEqual(rec[8]["payment_tx"], "0x" + "b" * 64)
        self.assertEqual(rec[8]["body"]["params"]["name"], "estimate_gas")

    def test_raises_venture_engine_error_on_402(self) -> None:
        unauth_client = VentureEngineClient(base_url=self.base_url)
        with self.assertRaises(VentureEngineError) as ctx:
            unauth_client.estimate_gas("base")
        self.assertEqual(ctx.exception.status, 402)
        self.assertEqual(ctx.exception.body["accepts"][0]["payTo"], RECEIVE_ONLY_TREASURY)


if __name__ == "__main__":
    unittest.main()
