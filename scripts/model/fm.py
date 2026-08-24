"""Antisymmetric factorisation machine — the floor the MLP has to beat.

A PLAIN FM cannot be this floor: its pairwise term sum_{i<j} <v_i, v_j> is
invariant under swapping the two teams, so it can only represent a symmetric
function of the draft, while "does blue win" is antisymmetric. Using one would
be building an artificially weak baseline. This version is antisymmetric by
construction:

    logit = b_region
          + ( sum_B w[c_i, r_i]        - sum_R w[c_j, r_j] )
          + ( sum_{i<j in B} <s_i,s_j> - sum_{i<j in R} <s_i,s_j> )
          + ( <C_B, D_R>               - <C_R, D_B> )

where s is a rank-16 within-team synergy table and (c, d) are the two rank-16
cross-team counter tables. Swapping the sides negates every bracket, so
logit(r,b) = -logit(b,r) + 2*b_region exactly.

Parameters: 3 x 175 x 16 = 8,400 factors + 175 x 5 = 875 linear + 3 region
biases = 9,278.
"""

import numpy as np
import torch
from torch import nn

RANK = 16


class AntisymmetricFM(nn.Module):
    def __init__(self, vocab_size, n_regions, rank=RANK):
        super().__init__()
        self.vocab_size = vocab_size
        # Row 0 is UNKNOWN (a masked slot) and row 1 is NONE (an empty ban
        # slot); both are held at exactly zero so an absent slot contributes
        # nothing to any term rather than contributing a learned "absent" vector.
        self.synergy = nn.Embedding(vocab_size, rank, padding_idx=0)
        self.counter_a = nn.Embedding(vocab_size, rank, padding_idx=0)
        self.counter_b = nn.Embedding(vocab_size, rank, padding_idx=0)
        self.linear = nn.Embedding(vocab_size, 5, padding_idx=0)
        self.region_bias = nn.Parameter(torch.zeros(n_regions))
        for emb in (self.synergy, self.counter_a, self.counter_b):
            nn.init.normal_(emb.weight, std=0.01)
            with torch.no_grad():
                emb.weight[0].zero_()
        nn.init.zeros_(self.linear.weight)

    @staticmethod
    def _within(vecs, mask):
        """sum_{i<j} <v_i, v_j> = (||sum v||^2 - sum ||v||^2) / 2, masked."""
        v = vecs * mask.unsqueeze(-1)
        total = v.sum(dim=1)
        return 0.5 * ((total * total).sum(-1) - (v * v).sum(dim=(1, 2)))

    def forward(self, champ, region, visible=None):
        """champ: (B,10) dense vocab indices, blue slots 0-4 then red 5-9."""
        if visible is None:
            visible = champ != 0
        mask = visible.float()
        blue, red = slice(0, 5), slice(5, 10)

        # champion x role linear term. Slot index is canonical role order, so
        # the role of slot i is i % 5 on both sides.
        lin = self.linear(champ)                                  # (B,10,5)
        role = torch.arange(5, device=champ.device).repeat(2)     # (10,)
        lin = lin.gather(2, role.view(1, 10, 1).expand(lin.size(0), 10, 1)).squeeze(-1)
        lin = lin * mask
        linear_term = lin[:, blue].sum(-1) - lin[:, red].sum(-1)

        s = self.synergy(champ)
        synergy_term = self._within(s[:, blue], mask[:, blue]) - self._within(
            s[:, red], mask[:, red]
        )

        ca, cb = self.counter_a(champ), self.counter_b(champ)
        ca, cb = ca * mask.unsqueeze(-1), cb * mask.unsqueeze(-1)
        C_B, C_R = ca[:, blue].sum(1), ca[:, red].sum(1)
        D_B, D_R = cb[:, blue].sum(1), cb[:, red].sum(1)
        counter_term = (C_B * D_R).sum(-1) - (C_R * D_B).sum(-1)

        return self.region_bias[region] + linear_term + synergy_term + counter_term

    def n_parameters(self):
        return sum(p.numel() for p in self.parameters())


def fit(champ_tr, region_tr, y_tr, champ_va, region_va, y_va, vocab_size, n_regions,
        visible_tr=None, visible_va=None, weight_decay=1e-3, epochs=30, batch=4096,
        lr=3e-3, seed=0, verbose=False):
    """Train to the best val log-loss and return (model, val_logloss, epoch)."""
    torch.manual_seed(seed)
    model = AntisymmetricFM(vocab_size, n_regions)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    n = len(y_tr)
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=lr, total_steps=epochs * max(1, n // batch), pct_start=0.2
    )
    loss_fn = nn.BCEWithLogitsLoss()
    best = (float("inf"), -1, None)
    g = torch.Generator().manual_seed(seed)
    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(n, generator=g)
        for i in range(0, n - batch + 1, batch):
            idx = perm[i : i + batch]
            opt.zero_grad()
            v = visible_tr[idx] if visible_tr is not None else None
            out = model(champ_tr[idx], region_tr[idx], v)
            loss = loss_fn(out, y_tr[idx])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            with torch.no_grad():   # keep the reserved rows at exactly zero
                for emb in (model.synergy, model.counter_a, model.counter_b, model.linear):
                    emb.weight[0].zero_()
        model.eval()
        with torch.no_grad():
            vl = float(
                nn.functional.binary_cross_entropy_with_logits(
                    model(champ_va, region_va, visible_va), y_va
                )
            )
        if vl < best[0]:
            best = (vl, epoch, {k: v.clone() for k, v in model.state_dict().items()})
        if verbose:
            print(f"    epoch {epoch:>2}  val logloss {vl:.5f}")
    model.load_state_dict(best[2])
    model.eval()
    return model, best[0], best[1]


@torch.no_grad()
def predict_logit(model, champ, region, visible=None):
    model.eval()
    return model(champ, region, visible).numpy()
