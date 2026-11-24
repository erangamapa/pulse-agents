from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sportsbook_contracts import Selection

from scoring.model import WinModel, load

DEFAULT_ARTIFACT = 'artifacts/win_model.joblib'


class WinProbabilityRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    selection: Selection
    price_move_pct: float = Field(ge=-100, le=1000)
    minutes_to_start: float = Field(ge=0)
    news_impact: float = Field(ge=-1, le=1)


class WinProbabilityResponse(BaseModel):
    probability: float = Field(ge=0, le=1)
    model_version: str


def create_app(model: WinModel | None = None) -> FastAPI:
    """Pass a model in tests. In the service it is loaded once from the artifact path."""
    app = FastAPI(title='pulse-scoring')
    loaded = model

    def current_model() -> WinModel:
        nonlocal loaded
        if loaded is None:
            path = Path(os.environ.get('SCORING_MODEL_PATH', DEFAULT_ARTIFACT))
            if not path.exists():
                raise HTTPException(status_code=503, detail='model artifact is not available')
            loaded = load(path)
        return loaded

    @app.get('/healthz')
    def healthz() -> dict[str, str]:
        return {'status': 'ok'}

    @app.post('/v1/score/win-probability', response_model=WinProbabilityResponse)
    def win_probability(request: WinProbabilityRequest) -> WinProbabilityResponse:
        price = float(request.selection.price)
        if price <= 1:
            raise HTTPException(status_code=422, detail='price must be above 1')
        active = current_model()
        probability = active.predict(
            implied_probability=1 / price,
            price_move_pct=request.price_move_pct,
            minutes_to_start=request.minutes_to_start,
            news_impact=request.news_impact,
        )
        return WinProbabilityResponse(probability=probability, model_version=active.version)

    return app
