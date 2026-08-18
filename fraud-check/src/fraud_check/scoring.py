"""Anomaly scoring for transaction events.

IMPORTANT — this is NOT a real fraud model. There is no historical
transaction data available in this portfolio project (ledger-service does
not yet publish real events, see BEST_PRACTICES.md), so the IsolationForest
here is trained on a small SYNTHETIC dataset generated in-process at
startup: a cluster of "normal" amounts plus a handful of extreme outliers.
The only goal is to demonstrate the shape of an ML-in-the-transaction-path
integration (train once, score per-event, log a flag) — not to detect real
fraud. Treat every score/flag this module produces as illustrative only.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.ensemble import IsolationForest

# Synthetic training data parameters. Amounts are in cents, matching the
# wire format's amount_cents field.
_NORMAL_MEAN_CENTS = 150_000.0  # ~ Rp 1,500.00 typical transaction
_NORMAL_STD_CENTS = 40_000.0
_NORMAL_SAMPLE_SIZE = 950
_OUTLIER_SAMPLE_SIZE = 50
_OUTLIER_MIN_CENTS = 5_000_000.0  # far outside the normal cluster
_OUTLIER_MAX_CENTS = 50_000_000.0
_RANDOM_SEED = 42


def _synthetic_training_data(rng: np.random.Generator) -> np.ndarray:
    """Build a synthetic (amount_cents,) feature matrix.

    Mostly a tight cluster of "typical" transaction amounts, plus a small
    minority of extreme outliers so IsolationForest has something to learn
    to isolate. Amounts are clipped at zero since transactions can't be
    negative amounts here (sign/direction is a separate concern from size).
    """
    normal = rng.normal(_NORMAL_MEAN_CENTS, _NORMAL_STD_CENTS, size=_NORMAL_SAMPLE_SIZE)
    normal = np.clip(normal, 0, None)
    outliers = rng.uniform(_OUTLIER_MIN_CENTS, _OUTLIER_MAX_CENTS, size=_OUTLIER_SAMPLE_SIZE)
    amounts = np.concatenate([normal, outliers])
    return amounts.reshape(-1, 1)


@dataclass(frozen=True)
class AnomalyResult:
    score: float
    flagged: bool


class AnomalyModel:
    """Wraps a scikit-learn IsolationForest trained on synthetic data.

    Not thread-safe for concurrent .fit() calls, but .score() (which only
    calls predict/decision_function) is safe to call repeatedly from a
    single consumer loop, which is the only way this class is used here.
    """

    def __init__(self, contamination: float = 0.05, random_state: int = _RANDOM_SEED) -> None:
        rng = np.random.default_rng(random_state)
        training_data = _synthetic_training_data(rng)
        self._model = IsolationForest(
            n_estimators=100,
            contamination=contamination,
            random_state=random_state,
        )
        self._model.fit(training_data)

    def score(self, amount_cents: float) -> AnomalyResult:
        """Score a single transaction's total absolute amount.

        Returns an AnomalyResult with:
          - score: IsolationForest's decision_function output. Lower (more
            negative) means more anomalous; roughly >0 is "normal region".
          - flagged: True when the model's own predict() calls it an
            outlier (label -1), i.e. consistent with the contamination
            threshold the model was trained with.
        """
        features = np.array([[amount_cents]])
        raw_score = float(self._model.decision_function(features)[0])
        label = int(self._model.predict(features)[0])
        return AnomalyResult(score=raw_score, flagged=label == -1)


def transaction_amount_cents(entries: list[dict]) -> float:
    """Reduce a transaction's ledger entries to a single magnitude feature.

    We use the largest absolute leg amount across entries as a simple proxy
    for "how big is this transaction" — good enough for an illustrative
    anomaly check, not a real feature engineering pipeline.
    """
    if not entries:
        return 0.0
    return max(abs(float(entry.get("amount_cents", 0))) for entry in entries)
