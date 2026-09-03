"""Build the shipped artifact from a trained AntisymmetricFM — design §1."""
import json

import numpy as np

from common import ALIAS_OVERRIDES
from fm_serve import ROLE_ORDER


class MissingRolePrior(Exception):
    pass


def alias_key(alias):
    return ALIAS_OVERRIDES.get(alias, alias)


def role_prior_vector(entry):
    roles = entry["roles"]
    p = np.array([roles.get(r, 0.0) for r in ROLE_ORDER], float)
    if p.sum() <= 0:
        raise MissingRolePrior(entry.get("alias", "?"))
    return p / p.sum()


def linear_expected(w5, prior5):
    return float(np.asarray(w5, float) @ np.asarray(prior5, float))


def round6(x):
    return float(f"{float(x):.6g}")


def _round_list(v):
    return [round6(x) for x in np.asarray(v, float).tolist()]


def build_artifact(model, vocab, role_pct, version, scale, trained_on):
    W = model.linear.weight.detach().numpy()
    S = model.synergy.weight.detach().numpy()
    A = model.counter_a.weight.detach().numpy()
    B = model.counter_b.weight.detach().numpy()
    prior_by_alias = {e["alias"]: e for e in role_pct.values()}
    champions, missing = {}, []
    for k, alias in vocab["index_to_alias"].items():
        i = int(k)
        entry = prior_by_alias.get(alias)
        if entry is None:
            missing.append(alias)
            continue
        prior = role_prior_vector(entry)
        champions[alias_key(alias)] = {
            "linear_expected": round6(linear_expected(W[i], prior)),
            "linear": _round_list(W[i]),
            "synergy": _round_list(S[i]),
            "counter_a": _round_list(A[i]),
            "counter_b": _round_list(B[i]),
        }
    if missing:
        raise MissingRolePrior(f"champions without role prior: {missing}")
    return {
        "version": version,
        "format": 1,
        "rank": int(S.shape[1]),
        "scale": round6(scale),
        "clamp": [0, 1],
        "linear_roles": list(ROLE_ORDER),
        "trained_on": trained_on,
        "champions": champions,
    }


def write_json(path, obj):
    path.write_text(json.dumps(obj, indent=1, sort_keys=False) + "\n", encoding="utf-8")
