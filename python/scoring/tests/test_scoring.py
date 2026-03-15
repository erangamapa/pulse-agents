from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from scoring.app import create_app
from scoring.model import FEATURES, load, save
from scoring.train_fixture import FIXTURE_VERSION, train_fixture

SELECTION = {'eventId': 'evt-1', 'marketId': 'mkt-1', 'selectionId': 'sel-1', 'price': '2.0000'}


@pytest.fixture(scope='module')
def model():
    return train_fixture()


@pytest.fixture()
def client(model):
    return TestClient(create_app(model))


def body(**overrides):
    return {
        'selection': SELECTION,
        'price_move_pct': -2.0,
        'minutes_to_start': 120,
        'news_impact': 0.4,
    } | overrides


def test_probability_stays_inside_bounds(model):
    for implied in (0.01, 0.2, 0.5, 0.8, 0.99):
        probability = model.predict(implied, 0.0, 60.0, 0.0)
        assert 0.0 <= probability <= 1.0


def test_training_is_deterministic():
    first = train_fixture()
    second = train_fixture()
    assert first.estimator.coef_.tolist() == second.estimator.coef_.tolist()
    assert first.version == FIXTURE_VERSION


def test_higher_implied_probability_raises_the_estimate(model):
    low = model.predict(0.3, 0.0, 60.0, 0.0)
    high = model.predict(0.7, 0.0, 60.0, 0.0)
    assert high > low
    assert len(FEATURES) == model.estimator.coef_.shape[1]


def test_artifact_round_trips(model, tmp_path: Path):
    target = tmp_path / 'model.joblib'
    save(model, target)
    restored = load(target)
    assert restored.version == model.version
    assert restored.predict(0.5, 1.0, 30.0, 0.2) == model.predict(0.5, 1.0, 30.0, 0.2)


def test_endpoint_returns_probability_and_version(client):
    response = client.post('/v1/score/win-probability', json=body())
    assert response.status_code == 200
    payload = response.json()
    assert 0.0 <= payload['probability'] <= 1.0
    assert payload['model_version'] == FIXTURE_VERSION


def test_endpoint_rejects_out_of_range_features(client):
    url = '/v1/score/win-probability'
    assert client.post(url, json=body(news_impact=3)).status_code == 422
    assert client.post(url, json=body(minutes_to_start=-1)).status_code == 422


def test_endpoint_rejects_a_price_that_is_not_above_one(client):
    response = client.post(
        '/v1/score/win-probability',
        json=body(selection=SELECTION | {'price': '1.0000'}),
    )
    assert response.status_code == 422


def test_service_loads_the_model_from_the_artifact_path(model, tmp_path: Path, monkeypatch):
    target = tmp_path / 'model.joblib'
    save(model, target)
    monkeypatch.setenv('SCORING_MODEL_PATH', str(target))
    response = TestClient(create_app()).post('/v1/score/win-probability', json=body())
    assert response.status_code == 200


def test_service_reports_unavailable_without_an_artifact(tmp_path: Path, monkeypatch):
    monkeypatch.setenv('SCORING_MODEL_PATH', str(tmp_path / 'missing.joblib'))
    response = TestClient(create_app()).post('/v1/score/win-probability', json=body())
    assert response.status_code == 503
    assert TestClient(create_app()).get('/healthz').status_code == 200
