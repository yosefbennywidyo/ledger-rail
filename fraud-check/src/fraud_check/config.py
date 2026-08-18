"""Runtime configuration, read from environment variables with sane local defaults.

Mirrors the convention used by the other ledger-rail components: no config
files, no secret manager wiring yet (Vault integration is out of scope for
this skeleton) — just env vars with defaults that work against the local
docker-compose stack.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    kafka_brokers: str
    kafka_topic: str
    kafka_group_id: str
    health_host: str
    health_port: int
    anomaly_contamination: float


def load_config() -> Config:
    return Config(
        kafka_brokers=os.environ.get("KAFKA_BROKERS", "localhost:9092"),
        kafka_topic=os.environ.get("KAFKA_TOPIC", "transactions"),
        kafka_group_id=os.environ.get("KAFKA_GROUP_ID", "fraud-check"),
        health_host=os.environ.get("HEALTH_HOST", "0.0.0.0"),
        health_port=int(os.environ.get("HEALTH_PORT", "8090")),
        # Fraction of synthetic training data treated as outliers. Matches
        # the outlier ratio we generate in scoring.py's synthetic dataset.
        anomaly_contamination=float(os.environ.get("ANOMALY_CONTAMINATION", "0.05")),
    )
