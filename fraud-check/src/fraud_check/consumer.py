"""Async Kafka consumer for the `transactions` topic.

Per the ledger-rail design (bahasa-teknologi-perbankan.md section 7,
"Bagaimana antar komponen berkomunikasi", and project-requirements.md
section 5), Ledger Service publishes a transaction event to Kafka/Redpanda
*after* recording it — this is the async, out-of-the-critical-path fan-out
consumed by Fraud Check, notifications, and reconciliation. It is NOT the
synchronous pre-settlement call described in the older table in section 7;
see BEST_PRACTICES.md for why this consumer follows the later, more
detailed design instead.

Expected message value (JSON, UTF-8), one message per transaction:

    {"idempotency_key": "string", "entries": [{"account_id": "string", "amount_cents": <int64>}]}

Note: ledger-service does not publish to Kafka yet (that wiring hasn't been
built on the Go side), so there is no live producer as of this writing.
This consumer is tested by hand-producing sample messages with
`rpk topic produce transactions` — see BEST_PRACTICES.md for the exact
commands.
"""

from __future__ import annotations

import asyncio
import json
import logging

from aiokafka import AIOKafkaConsumer

from fraud_check.config import Config
from fraud_check.scoring import AnomalyModel, transaction_amount_cents

logger = logging.getLogger("fraud_check.consumer")


_POLL_TIMEOUT_SECONDS = 1.0


async def consume_until_stopped(config: Config, model: AnomalyModel, stop_event: asyncio.Event) -> None:
    """Subscribe to config.kafka_topic and score events until stop_event is set.

    Deliberately cooperative rather than cancellation-based: we poll for one
    message at a time with a short timeout and check stop_event between
    polls, then call consumer.stop() exactly once outside of any cancelled
    await. Task-cancellation-based shutdown (cancelling a task sitting in
    `async for message in consumer`) turned out to race with aiokafka's own
    internal shutdown coroutines during manual testing and could leave the
    process hanging — this polling loop avoids that entirely.
    """
    consumer = AIOKafkaConsumer(
        config.kafka_topic,
        bootstrap_servers=config.kafka_brokers,
        group_id=config.kafka_group_id,
        auto_offset_reset="earliest",
        enable_auto_commit=True,
    )
    await consumer.start()
    logger.info(
        "consumer started: topic=%s group_id=%s brokers=%s",
        config.kafka_topic,
        config.kafka_group_id,
        config.kafka_brokers,
    )
    try:
        while not stop_event.is_set():
            try:
                message = await asyncio.wait_for(consumer.getone(), timeout=_POLL_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                continue
            _process_message(message.value, model)
    finally:
        await consumer.stop()
        logger.info("consumer stopped")


def _process_message(raw_value: bytes, model: AnomalyModel) -> None:
    try:
        event = json.loads(raw_value.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        logger.warning("skipping malformed message: %s raw=%r", exc, raw_value[:200])
        return

    idempotency_key = event.get("idempotency_key", "<missing>")
    entries = event.get("entries", [])
    amount_cents = transaction_amount_cents(entries)
    result = model.score(amount_cents)

    logger.info(
        "processed transaction idempotency_key=%s amount_cents=%.0f anomaly_score=%.4f flagged=%s",
        idempotency_key,
        amount_cents,
        result.score,
        result.flagged,
    )
