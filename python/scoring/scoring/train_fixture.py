from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

from scoring.model import WinModel, save, train

FIXTURE_CSV = Path(__file__).parent / 'fixtures' / 'training.csv'
FIXTURE_VERSION = 'fixture-2025-03'


def train_fixture(csv_path: Path = FIXTURE_CSV) -> WinModel:
    """Same csv and same seed always give the same coefficients."""
    return train(pd.read_csv(csv_path), version=FIXTURE_VERSION)


def main(argv: list[str]) -> None:
    target = Path(argv[1]) if len(argv) > 1 else Path('artifacts/win_model.joblib')
    save(train_fixture(), target)
    print(f'wrote {target}')


if __name__ == '__main__':
    main(sys.argv)
