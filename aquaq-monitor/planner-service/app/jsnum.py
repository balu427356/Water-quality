"""Number helpers that reproduce JavaScript behaviour, so results match the app byte for byte."""

import math


def js_round(v: float, dp: int = 2) -> float:
    """Math.round(v * 10**dp) / 10**dp (rounds halves toward +infinity, like JS)."""
    k = 10**dp
    return math.floor(v * k + 0.5) / k


def js_str(v: float) -> str:
    """String(v) for the numbers we format (limits, thresholds)."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return repr(v) if isinstance(v, float) else str(v)


def to_fixed(v: float, digits: int) -> str:
    """Number.prototype.toFixed for values that are already rounded to `digits` places."""
    return f"{js_round(v, digits):.{digits}f}"
