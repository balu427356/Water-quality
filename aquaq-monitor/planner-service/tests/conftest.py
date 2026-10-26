import json
from pathlib import Path

import pytest

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def plan_fixture():
    return json.loads((FIX / "plan_fixture.json").read_text())


@pytest.fixture(scope="session")
def score_fixture():
    return json.loads((FIX / "score_fixture.json").read_text())
