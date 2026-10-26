from app.models import ScoreRequest
from app.scoring import score_survey


def test_matches_typescript_fixture(score_fixture):
    """The app's scoring.ts produced these; the service must give identical output."""
    for case in score_fixture:
        got = score_survey(ScoreRequest(**case["request"])).model_dump(mode="json")
        assert got == case["expected"], case["request"]["survey_id"]


def test_false_alarm_survey_flags_zone_b_for_lab_review(score_fixture):
    case = next(c for c in score_fixture if c["request"]["survey_id"] == "SV-003")
    b = next(z for z in score_survey(ScoreRequest(**case["request"])).zone_scores if z.zone_id == "B")
    assert b.trust_T < 0.5 and b.trust_gate == "lab_review"
