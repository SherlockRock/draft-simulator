"""Masking and augmentation for training rows (section B3).

Masking is 70% draft-order PREFIX and 30% LoLDraftAI-style strategic random.

The prefix branch is what makes the training distribution match the states the
search actually evaluates: draw a root turn (v1 assumption: uniform over the 20
turns), draw a depth from the distribution Task 1b-b MEASURED, and read the
fill pattern off the Task 1b-a table. Ban visibility in this branch is
DETERMINED by the same turn index - drawing bans independently would produce
unreachable states such as "all 10 bans with under 3 picks per side", which is
exactly the reachability the branch exists for. The independent ban regimes
apply only to the strategic branch.

Two augmentations, aimed at two different serve-time failures:

* role noise - smooth a team's role_probs toward the population prior. Never a
  role permutation: a per-slot re-slot could produce duplicate or missing roles
  that the bijective solver can never emit, while a smoothing cannot.
* transposition - swap two of a team's champions between slots and recompute
  that team's role_probs as the solver POSTERIOR for the swapped placement.
  This is bijective, so it is a state the solver really can emit, and it is the
  solver's actual failure mode: 27% of teams get at least one champion in the
  wrong slot (Task 2b).
"""

import json

import numpy as np

from mask_table import TOTAL_TURNS, pattern_at
from roles import team_posterior

PREFIX_SHARE = 0.70
# Strategic-branch ban regimes (section B3). i.i.d. p=0.3 alone would show a
# full ban set in 0.7^10 = 2.8% of samples, so the mixture pins the phases.
BAN_REGIMES = [("all", 0.25), ("first_phase", 0.30), ("none", 0.20), ("iid", 0.25)]


def load_depth_distribution(path):
    """Task 1b-b's measured achieved depths; uniform 1..8 if it has not been run."""
    try:
        doc = json.loads(path.read_text())
        d = {int(k): float(v) for k, v in doc["achieved_depth_distribution"].items()}
        return d, "measured"
    except (FileNotFoundError, KeyError, json.JSONDecodeError):
        return {k: 1 / 8 for k in range(1, 9)}, "UNIFORM FALLBACK (Task 1b-b not run)"


class Masker:
    def __init__(self, depth_dist, seed=0):
        self.rng = np.random.default_rng(seed)
        depths = np.array(sorted(depth_dist), dtype=int)
        probs = np.array([depth_dist[d] for d in depths], dtype=float)
        self.depths, self.depth_probs = depths, probs / probs.sum()
        # Precompute the fill pattern of every leaf turn once.
        self.pattern = np.array(
            [
                [
                    pattern_at(t)["blue_picks"],
                    pattern_at(t)["red_picks"],
                    pattern_at(t)["blue_bans"],
                    pattern_at(t)["red_bans"],
                ]
                for t in range(TOTAL_TURNS + 1)
            ],
            dtype=np.int64,
        )
        from mask_table import leaf_turn

        self.leaf = np.array(
            [[leaf_turn(r, d) for d in range(9)] for r in range(TOTAL_TURNS)],
            dtype=np.int64,
        )

    def draw(self, n):
        """-> (visible_picks (n,10) bool, visible_bans (n,10) bool)."""
        rng = self.rng
        prefix = rng.random(n) < PREFIX_SHARE

        counts = np.empty((n, 4), dtype=np.int64)

        # --- prefix branch: reachable states only ---
        n_pre = int(prefix.sum())
        if n_pre:
            roots = rng.integers(0, TOTAL_TURNS, n_pre)
            depths = rng.choice(self.depths, size=n_pre, p=self.depth_probs)
            counts[prefix] = self.pattern[self.leaf[roots, np.clip(depths, 0, 8)]]

        # --- strategic branch: random, as regularisation ---
        n_str = n - n_pre
        if n_str:
            picks = rng.integers(0, 6, size=(n_str, 2))
            regimes = rng.choice(
                [r for r, _ in BAN_REGIMES], size=n_str, p=[p for _, p in BAN_REGIMES]
            )
            bans = np.zeros((n_str, 2), dtype=np.int64)
            bans[regimes == "all"] = 5
            bans[regimes == "first_phase"] = 3
            bans[regimes == "none"] = 0
            iid = regimes == "iid"
            if iid.any():
                bans[iid] = rng.binomial(5, 0.3, size=(int(iid.sum()), 2))
            counts[~prefix] = np.concatenate([picks, bans], axis=1)

        # Which ROLES are filled is the second stated assumption: uniform over
        # role subsets of the required size. Riot's data carries no pick order.
        vp = np.zeros((n, 10), dtype=bool)
        order = rng.random((n, 2, 5)).argsort(axis=2)
        for side in (0, 1):
            k = counts[:, side][:, None]
            vp[:, side * 5 : side * 5 + 5] = order[:, side] < k

        vb = np.zeros((n, 10), dtype=bool)
        idx = np.arange(5)[None, :]
        vb[:, :5] = idx < counts[:, 2][:, None]
        vb[:, 5:] = idx < counts[:, 3][:, None]
        return vp, vb


class Augmenter:
    def __init__(self, factors, role_prior, p=0.5, lam_lo=0.3, lam_hi=1.0,
                 p_swap=0.1, seed=0):
        self.factors = factors          # (V,5) position factors, matching the Rust solver
        self.role_prior = role_prior    # (V,5) population role shares
        self.p, self.lam_lo, self.lam_hi, self.p_swap = p, lam_lo, lam_hi, p_swap
        self.rng = np.random.default_rng(seed)

    def apply(self, champ, visible_picks):
        """-> (champ, role_probs) with masking, transposition and role noise applied.

        `champ` is modified on a copy; masked slots become UNKNOWN (index 0) and
        take the team-level residual role distribution.
        """
        rng = self.rng
        n = champ.shape[0]
        champ = champ.copy()
        role = np.zeros((n, 10, 5), dtype=np.float32)
        eye = np.eye(5, dtype=np.float32)
        role[:, :5] = eye                      # slot index IS the role, both sides
        role[:, 5:] = eye

        for side in (0, 1):
            sl = slice(side * 5, side * 5 + 5)
            vis = visible_picks[:, sl]

            # --- transposition: a bijective PLACEMENT error ---
            if self.p_swap > 0:
                hit = (rng.random(n) < self.p_swap) & (vis.sum(1) >= 2)
                rows = np.flatnonzero(hit)
                if len(rows):
                    team = champ[rows, sl]
                    for r_i, row in enumerate(rows):
                        v = np.flatnonzero(vis[row])
                        a, b = rng.choice(v, size=2, replace=False)
                        team[r_i, a], team[r_i, b] = team[r_i, b], team[r_i, a]
                    champ[rows, sl] = team
                    # The team's role_probs become the solver's posterior for the
                    # placement it now shows - which is what the engine would
                    # hand the model at serve time for exactly this mistake.
                    post = self._posterior(team, vis[rows])
                    role[rows, sl] = post

            # --- role noise: smooth toward the population prior ---
            if self.p > 0:
                hit = rng.random(n) < self.p
                rows = np.flatnonzero(hit)
                if len(rows):
                    lam = rng.uniform(self.lam_lo, self.lam_hi, size=(len(rows), 1, 1))
                    prior = self.role_prior[champ[rows, sl]]
                    role[rows, sl] = (1 - lam) * role[rows, sl] + lam * prior

            # --- masked slots: UNKNOWN + the residual convention ---
            hidden = ~vis
            if hidden.any():
                masked_role = role[:, sl].copy()
                masked_role[hidden] = 0.0
                residual = np.maximum(0.0, 1.0 - masked_role.sum(axis=1))
                s = residual.sum(axis=1, keepdims=True)
                residual = np.divide(
                    residual, s, out=np.full_like(residual, 0.2), where=s > 0
                )
                masked_role[hidden] = np.repeat(
                    residual[:, None, :], 5, axis=1
                )[hidden]
                role[:, sl] = masked_role
                champ[:, sl][hidden] = 0        # UNKNOWN

        return champ, role

    def _posterior(self, team, vis):
        """Solver posterior per SLOT for a partially visible team."""
        out = np.zeros((len(team), 5, 5), dtype=np.float32)
        # Group by visible-count so each group is one vectorised solve.
        counts = vis.sum(1)
        for k in np.unique(counts):
            if k == 0:
                continue
            sel = counts == k
            slots = np.array([np.flatnonzero(v) for v in vis[sel]])
            champs = np.take_along_axis(team[sel], slots, axis=1)
            post = team_posterior(self.factors[champs])        # (m,k,5)
            for j in range(k):
                out[np.flatnonzero(sel), slots[:, j]] = post[:, j]
        return out
