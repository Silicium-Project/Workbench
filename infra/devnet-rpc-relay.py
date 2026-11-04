#!/usr/bin/env python3
"""Small, private Solana Devnet JSON-RPC relay for the VPS worker bridge."""

from __future__ import annotations

import ipaddress
import json
import os
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


UPSTREAM = os.environ.get("SILICIUM_DEVNET_RPC_UPSTREAM", "https://api.devnet.solana.com")
LISTEN_HOST = os.environ.get("SILICIUM_DEVNET_RPC_BIND", "172.23.0.1")
LISTEN_PORT = int(os.environ.get("SILICIUM_DEVNET_RPC_PORT", "8899"))
ALLOWED_CIDRS = tuple(
    ipaddress.ip_network(value.strip())
    for value in os.environ.get("SILICIUM_DEVNET_RPC_ALLOWED_CIDRS", "172.23.0.0/24").split(",")
    if value.strip()
)
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
RETRYABLE_STATUS = {429, 502, 503, 504}
UPSTREAM_SLOTS = threading.BoundedSemaphore(2)
UPSTREAM_PACE_LOCK = threading.Lock()
UPSTREAM_MIN_INTERVAL = 0.2
NEXT_UPSTREAM_START = 0.0
UPSTREAM_BACKOFF_UNTIL = 0.0

upstream = urlsplit(UPSTREAM)
if upstream.scheme != "https" or not upstream.hostname or "devnet" not in upstream.hostname.lower():
    raise SystemExit("RPC relay requires an HTTPS Devnet upstream.")
if not ALLOWED_CIDRS or any(network.version != 4 for network in ALLOWED_CIDRS):
    raise SystemExit("RPC relay requires at least one IPv4 allowlist network.")
if ipaddress.ip_address(LISTEN_HOST) not in {network.network_address + 1 for network in ALLOWED_CIDRS}:
    raise SystemExit("RPC relay bind address must be the worker bridge gateway.")


def retry_delay(headers, attempt: int) -> float:
    advertised = headers.get("Retry-After") if headers else None
    if advertised:
        try:
            return min(12.0, max(0.0, float(advertised)))
        except ValueError:
            pass
    return min(8.0, 0.5 * (2**attempt)) + random.random() * 0.25


def is_json_rpc_rate_limit(payload: bytes) -> bool:
    try:
        body = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    error = body.get("error") if isinstance(body, dict) else None
    return isinstance(error, dict) and error.get("code") == 429


def pace_upstream_request() -> None:
    global NEXT_UPSTREAM_START
    while True:
        with UPSTREAM_PACE_LOCK:
            now = time.monotonic()
            wait_until = max(NEXT_UPSTREAM_START, UPSTREAM_BACKOFF_UNTIL)
            if wait_until <= now:
                NEXT_UPSTREAM_START = now + UPSTREAM_MIN_INTERVAL
                return
        time.sleep(wait_until - now)


def back_off_upstream(delay: float) -> None:
    global UPSTREAM_BACKOFF_UNTIL
    with UPSTREAM_PACE_LOCK:
        UPSTREAM_BACKOFF_UNTIL = max(UPSTREAM_BACKOFF_UNTIL, time.monotonic() + delay)


def fetch_upstream(payload: bytes) -> tuple[int, bytes, str]:
    """Sends one request to Devnet, paced and retried; returns status, body, content type."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    request = Request(UPSTREAM, data=payload, headers=headers, method="POST")
    for attempt in range(4):
        status = 502
        response_headers = None
        try:
            with UPSTREAM_SLOTS:
                pace_upstream_request()
                with urlopen(request, timeout=25) as response:
                    status = response.status
                    response_headers = response.headers
                    body = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as error:
            status = error.code
            response_headers = error.headers
            body = error.read(MAX_RESPONSE_BYTES + 1)
        except (TimeoutError, URLError, OSError):
            body = b'{"error":{"code":-32000,"message":"Devnet RPC upstream unavailable"}}'
        if len(body) > MAX_RESPONSE_BYTES:
            return 502, b'{"error":"upstream response too large"}', "application/json"
        should_retry = status in RETRYABLE_STATUS or (status == 200 and is_json_rpc_rate_limit(body))
        if should_retry:
            # Even the last failed attempt slows every worker down.
            back_off_upstream(retry_delay(response_headers, attempt))
        if not should_retry or attempt == 3:
            content_type = "application/json"
            if response_headers:
                content_type = response_headers.get("Content-Type", content_type)
            return status, body, content_type
    raise AssertionError("unreachable")


# Read-only methods whose identical, simultaneous requests share one Devnet
# call. Twenty workers checking the same escrow ask for the same accounts at
# nearly the same time, and each upstream call costs a paced slot. Nothing is
# kept after the answer: a request that arrives later asks Devnet again, so a
# worker never reads state older than a request already waiting in the queue.
COALESCED_METHODS = frozenset(
    {"getAccountInfo", "getMultipleAccounts", "getBalance", "getLatestBlockhash", "getHealth"}
)
FLIGHT_WAIT_SECONDS = 150.0


class Flight:
    """One upstream request in progress, and the answer its followers wait for."""

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: tuple[int, bytes, str] | None = None


FLIGHTS: dict[str, Flight] = {}
FLIGHTS_LOCK = threading.Lock()


def coalescing_key(request_json) -> str | None:
    """Key shared by identical read requests, or None when the request must go alone."""
    if not isinstance(request_json, dict) or request_json.get("method") not in COALESCED_METHODS:
        return None
    params = request_json.get("params", [])
    if not isinstance(params, list):
        return None
    # The id is the caller's own: it is not part of what is asked.
    return json.dumps([request_json["method"], params], sort_keys=True, separators=(",", ":"))


def with_request_id(result: tuple[int, bytes, str], request_json) -> tuple[int, bytes, str]:
    """Gives a shared answer the id of the request it now answers."""
    status, body, content_type = result
    try:
        answer = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return result
    if not isinstance(answer, dict) or "id" not in answer:
        return result
    answer["id"] = request_json.get("id")
    return status, json.dumps(answer, separators=(",", ":")).encode(), content_type


def coalesced_fetch(request_json, payload: bytes) -> tuple[int, bytes, str]:
    key = coalescing_key(request_json)
    if key is None:
        return fetch_upstream(payload)
    with FLIGHTS_LOCK:
        flight = FLIGHTS.get(key)
        leader = flight is None
        if leader:
            flight = FLIGHTS[key] = Flight()
    if leader:
        try:
            flight.result = fetch_upstream(payload)
        finally:
            with FLIGHTS_LOCK:
                FLIGHTS.pop(key, None)
            flight.done.set()
        return flight.result
    flight.done.wait(FLIGHT_WAIT_SECONDS)
    if flight.result is None:
        # The leader failed or took too long: ask on our own.
        return fetch_upstream(payload)
    return with_request_id(flight.result, request_json)


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "SiliciumDevnetRelay/1"
    sys_version = ""

    def _allowed(self) -> bool:
        try:
            address = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            return False
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return address in ipaddress.ip_network("127.0.0.0/8") or any(
            address in network for network in ALLOWED_CIDRS
        )

    def _respond(self, status: int, body: bytes, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._respond(200, b'{"status":"ok","cluster":"devnet"}')
            return
        self._respond(404, b'{"error":"not found"}')

    def do_POST(self) -> None:
        if not self._allowed():
            self._respond(403, b'{"error":"forbidden"}')
            return
        if self.path not in {"/devnet", "/devnet/"}:
            self._respond(404, b'{"error":"not found"}')
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 1 or length > MAX_REQUEST_BYTES:
            self._respond(413, b'{"error":"invalid request size"}')
            return
        if "application/json" not in self.headers.get("Content-Type", "").lower():
            self._respond(415, b'{"error":"application/json required"}')
            return
        payload = self.rfile.read(length)
        try:
            request_json = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._respond(400, b'{"error":"invalid JSON"}')
            return
        if not isinstance(request_json, (dict, list)):
            self._respond(400, b'{"error":"invalid JSON-RPC request"}')
            return

        status, body, content_type = coalesced_fetch(request_json, payload)
        self._respond(status, body, content_type)

    def log_message(self, _format: str, *_args) -> None:
        return


class RelayServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64


if __name__ == "__main__":
    server = RelayServer((LISTEN_HOST, LISTEN_PORT), RelayHandler)
    server.serve_forever(poll_interval=0.5)
