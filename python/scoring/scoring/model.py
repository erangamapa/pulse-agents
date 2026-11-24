from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import joblib
import pandas as pd
from sklearn.linear_model import LogisticRegression

FEATURES = ['implied_probability', 'price_move_pct', 'minutes_to_start', 'news_impact']
TARGET = 'won'


@dataclass(frozen=True)
class WinModel:
    """Logistic regression over market features, stamped with the version that trained it."""

    estimator: LogisticRegression
    version: str

    def predict(
        self,
        implied_probability: float,
        price_move_pct: float,
        minutes_to_start: float,
        news_impact: float,
    ) -> float:
        row = pd.DataFrame(
            [[implied_probability, price_move_pct, minutes_to_start, news_impact]],
            columns=FEATURES,
        )
        return float(self.estimator.predict_proba(row)[0][1])


def train(frame: pd.DataFrame, version: str, seed: int = 7) -> WinModel:
    estimator = LogisticRegression(max_iter=500, random_state=seed)
    estimator.fit(frame[FEATURES], frame[TARGET])
    return WinModel(estimator=estimator, version=version)


def save(model: WinModel, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({'estimator': model.estimator, 'version': model.version}, path)


def load(path: Path) -> WinModel:
    artifact = joblib.load(path)
    return WinModel(estimator=artifact['estimator'], version=artifact['version'])
