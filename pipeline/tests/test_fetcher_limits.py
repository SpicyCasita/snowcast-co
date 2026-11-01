import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_forecasts  # noqa: E402
from fetch_forecasts import Fetcher, StopFetching  # noqa: E402


class FakeResponse:
    def __init__(self, status: int, text: str = ""):
        self.status_code = status
        self.text = text

    def json(self):
        return {}

    def raise_for_status(self):
        pass


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)

    def get(self, *args, **kwargs):
        return self.responses.pop(0)


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(fetch_forecasts.time, "sleep", lambda s: None)


def fetcher_with(responses, budget=100.0):
    f = Fetcher(budget)
    f.session = FakeSession(responses)
    return f


def test_hourly_limit_stops_without_retrying():
    f = fetcher_with([FakeResponse(429, "Hourly API request limit exceeded. Please try again in the next hour.")])
    with pytest.raises(StopFetching, match="Hourly"):
        f.get({}, 1)


def test_persistent_minutely_limit_stops_instead_of_crashing():
    f = fetcher_with([FakeResponse(429, "Minutely API request limit exceeded")] * 6)
    with pytest.raises(StopFetching, match="kept failing"):
        f.get({}, 1)


def test_transient_limit_then_success():
    f = fetcher_with([FakeResponse(429, "Minutely API request limit exceeded"), FakeResponse(200)])
    assert f.get({}, 1) == {}
    assert f.spent == 1


def test_budget_stops_before_calling():
    f = fetcher_with([], budget=1)
    with pytest.raises(StopFetching, match="budget"):
        f.get({}, 2)
