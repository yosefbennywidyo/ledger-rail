"""Minimal GET /healthz endpoint.

fraud-check's primary interface is the Kafka consumer loop, not HTTP — but
every ledger-rail component is expected to be health-checkable (docker
healthchecks, orchestration probes, manual curl during development). A
single-endpoint http.server run on a background daemon thread is enough:
no need to pull in an ASGI framework for one route.
"""

from __future__ import annotations

import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logger = logging.getLogger("fraud_check.health")


class _HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 (stdlib method name)
        if self.path == "/healthz":
            body = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        # Silence the default per-request stderr logging; we don't need an
        # access log line for every /healthz probe.
        pass


def start_health_server(host: str, port: int) -> ThreadingHTTPServer:
    """Start the health server on a background daemon thread and return it.

    Caller is responsible for calling .shutdown() on process exit.
    """
    server = ThreadingHTTPServer((host, port), _HealthHandler)
    thread = threading.Thread(target=server.serve_forever, name="healthz", daemon=True)
    thread.start()
    logger.info("healthz listening on http://%s:%d/healthz", host, port)
    return server
