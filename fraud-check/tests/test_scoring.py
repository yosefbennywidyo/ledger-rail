"""Unit tests for the anomaly-scoring function. No Kafka required."""

from __future__ import annotations

from fraud_check.scoring import AnomalyModel, transaction_amount_cents


def test_transaction_amount_cents_uses_largest_absolute_leg():
    entries = [
        {"account_id": "acc-1", "amount_cents": -150_000},
        {"account_id": "acc-2", "amount_cents": 150_000},
    ]
    assert transaction_amount_cents(entries) == 150_000.0


def test_transaction_amount_cents_empty_entries_is_zero():
    assert transaction_amount_cents([]) == 0.0


def test_normal_amount_is_not_flagged():
    model = AnomalyModel(contamination=0.05)
    # Right in the middle of the synthetic "normal" cluster (mean ~150_000).
    result = model.score(150_000.0)
    assert result.flagged is False


def test_extreme_outlier_is_flagged():
    model = AnomalyModel(contamination=0.05)
    # Far outside the synthetic normal cluster, well into the synthetic
    # outlier range used at training time.
    result = model.score(40_000_000.0)
    assert result.flagged is True


def test_outlier_score_is_lower_than_normal_score():
    model = AnomalyModel(contamination=0.05)
    normal = model.score(150_000.0)
    outlier = model.score(40_000_000.0)
    assert outlier.score < normal.score
