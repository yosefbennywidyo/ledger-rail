"""Entry point: wires up config, the synthetic anomaly model, the /healthz
server, and the Kafka consumer loop, then runs until SIGINT/SIGTERM."""

from __future__ import annotations

import asyncio
import logging
import signal

from fraud_check.config import load_config
from fraud_check.consumer import consume_until_stopped
from fraud_check.health import start_health_server
from fraud_check.scoring import AnomalyModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("fraud_check.main")


async def _main_async() -> None:
    config = load_config()
    logger.info(
        "starting fraud-check: kafka_brokers=%s topic=%s group_id=%s health_port=%d",
        config.kafka_brokers,
        config.kafka_topic,
        config.kafka_group_id,
        config.health_port,
    )

    model = AnomalyModel(contamination=config.anomaly_contamination)
    logger.info("anomaly model trained on synthetic data (illustrative only, see BEST_PRACTICES.md)")

    health_server = start_health_server(config.health_host, config.health_port)

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)

    try:
        await consume_until_stopped(config, model, stop_event)
    finally:
        health_server.shutdown()
        logger.info("fraud-check stopped")


def run() -> None:
    """Synchronous entry point (used by the `fraud-check` console script)."""
    asyncio.run(_main_async())


if __name__ == "__main__":
    run()
