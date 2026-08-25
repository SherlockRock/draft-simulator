import numpy as np
import pandas as pd

import serve


def _solver_rows(match_ids):
    rows = []
    for m in match_ids:
        for side, base in (("blue", 0), ("red", 5)):
            for k in range(5):
                rows.append({"match_id": m, "state_kind": "full", "side": side,
                             "champion": f"C{base + k}", "argmax_role": serve.ROLE_ORDER[k],
                             **{c: float(i == k) for i, c in enumerate(serve.PCOLS)}})
    return pd.DataFrame(rows)


def _ds(match_ids):
    d = {"match_id": match_ids}
    for i in range(10):
        d[f"champ_{i}"] = [i + 2] * len(match_ids)
    return pd.DataFrame(d)


def test_coverage_is_the_fraction_of_rows_the_solver_scored():
    i2a = {i + 2: f"C{i}" for i in range(10)}
    ds = _ds(["a", "b", "c", "d"])
    cov = serve.coverage(ds, _solver_rows(["a", "b"]), i2a)
    assert cov == 0.5
