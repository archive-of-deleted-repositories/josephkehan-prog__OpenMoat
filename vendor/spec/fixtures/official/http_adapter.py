"""Ephemeral loopback bridge from Streamable HTTP to an MCP stdio server."""

from __future__ import annotations

import argparse
import json
import os
import selectors
import signal
import subprocess
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, cast

MAX_BODY = 1_048_576
RESPONSE_TIMEOUT = 10.0


class BridgeError(RuntimeError):
    """The stdio implementation violated the adapter contract."""


class StdioBridge:
    """Serialize raw JSON-RPC messages over one stdio MCP process."""

    def __init__(self, command: list[str]) -> None:
        if not command:
            raise BridgeError("implementation command is required")
        self._process = subprocess.Popen(  # noqa: S603 - caller selects the binary
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        if self._process.stdin is None:
            raise BridgeError("implementation stdin is unavailable")
        self._process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self._process.stdin.flush()

    def request(self, message: dict[str, Any]) -> dict[str, Any]:
        identifier = message.get("id")
        with self._lock:
            self.send(message)
            if self._process.stdout is None:
                raise BridgeError("implementation stdout is unavailable")
            selector = selectors.DefaultSelector()
            selector.register(self._process.stdout, selectors.EVENT_READ)
            try:
                if not selector.select(RESPONSE_TIMEOUT):
                    raise BridgeError("implementation response timed out")
                line = self._process.stdout.readline()
            finally:
                selector.close()
            if not line:
                raise BridgeError(
                    f"implementation exited before response ({self._process.poll()})"
                )
            try:
                response = json.loads(line)
            except json.JSONDecodeError as error:
                raise BridgeError("implementation emitted non-JSON stdout") from error
            if not isinstance(response, dict) or response.get("id") != identifier:
                raise BridgeError("implementation response id mismatch")
            return cast(dict[str, Any], response)

    def close(self) -> None:
        if self._process.stdin is not None and not self._process.stdin.closed:
            self._process.stdin.close()
        try:
            self._process.wait(timeout=1)
            return
        except subprocess.TimeoutExpired:
            pass
        if self._process.poll() is None:
            os.killpg(self._process.pid, signal.SIGTERM)
        try:
            self._process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            os.killpg(self._process.pid, signal.SIGKILL)
            self._process.wait(timeout=1)


class AdapterServer(ThreadingHTTPServer):
    """Loopback-only HTTP server carrying one stateful MCP session."""

    daemon_threads = True

    def __init__(
        self,
        bridge: StdioBridge,
        max_requests: int | None = None,
    ) -> None:
        super().__init__(("127.0.0.1", 0), AdapterHandler)
        self.bridge = bridge
        self.session_id = uuid.uuid4().hex
        self.max_requests = max_requests

    def count_request(self) -> None:
        if self.max_requests is None:
            return
        self.max_requests -= 1
        if self.max_requests == 0:
            threading.Thread(target=self.shutdown, daemon=True).start()


class AdapterHandler(BaseHTTPRequestHandler):
    """Forward POST bodies without interpreting MCP methods or results."""

    server: AdapterServer

    def log_message(self, format: str, *args: object) -> None:
        del format, args

    def _empty(self, status: HTTPStatus) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/mcp":
            self._empty(HTTPStatus.NOT_FOUND)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            self._empty(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        try:
            message = json.loads(self.rfile.read(length))
            if not isinstance(message, dict):
                raise ValueError
            if "id" not in message:
                self.server.bridge.send(cast(dict[str, Any], message))
                self._empty(HTTPStatus.ACCEPTED)
                return
            response = self.server.bridge.request(cast(dict[str, Any], message))
            body = json.dumps(response, separators=(",", ":")).encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Mcp-Session-Id", self.server.session_id)
            self.end_headers()
            self.wfile.write(body)
        except (BridgeError, json.JSONDecodeError, ValueError):
            self._empty(HTTPStatus.BAD_REQUEST)
        finally:
            self.server.count_request()

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._empty(HTTPStatus.OK)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bridge official MCP HTTP conformance traffic to stdio"
    )
    parser.add_argument("--max-requests", type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if not args.command:
        parser.error("an implementation command is required after --")
    return args


def main() -> None:
    args = parse_args()
    bridge = StdioBridge(cast(list[str], args.command))
    server = AdapterServer(bridge, args.max_requests)
    host, port = server.server_address
    print(json.dumps({"url": f"http://{host}:{port}/mcp"}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        bridge.close()


if __name__ == "__main__":
    main()
