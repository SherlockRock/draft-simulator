"""The draft win-probability model (section B3).

Two design choices carry the whole architecture:

**Soft roles.** A slot token is
`champ_emb + proj(role_probs @ role_emb) + side_emb`. Roles enter as a
DISTRIBUTION, never a token: a training row is one-hot, an undetermined role is
the champion's population prior, and at serve time the engine passes the role
solver's posterior. One tensor carries all three, which is what lets a champion
pool's {champion, role} prior be expressed at all.

**Antisymmetric trunk.** `A = h(b,r) - h(r,b)` and `S = h(b,r) + h(r,b)`. The
win head reads A, so swapping the sides negates the logit exactly (up to the
region bias) and the side prior is 3 parameters rather than something learned
per champion. This ties blue-TOP to red-TOP: a 2x reduction in first-layer
weights, once per ROLE, not "once instead of ten times" - role slots keep
independent blocks, which is right because strength is role-specific.

Two details that are easy to get wrong and are guarded by probe (a):

* The swap moves each side's WHOLE bundle atomically - champions, role_probs
  AND bans. A fixed blue-then-red order for any one of the three silently
  breaks antisymmetry, and ordinary full-draft rows would not reveal it because
  both teams' role_probs blocks are identical there.
* Dropout uses ONE shared mask across the two passes, so antisymmetry holds in
  train mode too, not only in eval.
"""

import torch
from torch import nn
from torch.nn import functional as F

N_SLOTS = 10
N_ROLES = 5
CHAMP_DIM = 32
ROLE_DIM = 8
BAN_DIM = 8
PATCH_DIM = 16


class DraftModel(nn.Module):
    def __init__(self, vocab_size, n_patches, n_regions, width=256, dropout=0.2):
        super().__init__()
        self.vocab_size = vocab_size
        self.dropout = dropout

        self.champ_emb = nn.Embedding(vocab_size, CHAMP_DIM, padding_idx=0)
        self.role_emb = nn.Embedding(N_ROLES, ROLE_DIM)
        self.role_proj = nn.Linear(ROLE_DIM, CHAMP_DIM)
        self.side_emb = nn.Embedding(2, CHAMP_DIM)
        # Row 1 is NONE (an empty ban slot) and row 0 is UNKNOWN; both are held
        # at zero and excluded from the ban mean, so the number of empty slots
        # never becomes a nuisance magnitude.
        self.ban_emb = nn.Embedding(vocab_size, BAN_DIM, padding_idx=0)
        self.patch_emb = nn.Embedding(n_patches, PATCH_DIM)

        in_dim = N_SLOTS * CHAMP_DIM + 2 * BAN_DIM + PATCH_DIM     # 352
        dims = [in_dim, width, width // 2, width // 4]
        self.layers = nn.ModuleList(nn.Linear(a, b) for a, b in zip(dims, dims[1:]))
        # LayerNorm on the HIDDEN layers only. The two branches h(b,r) and
        # h(r,b) are near-collinear; a final-layer LN rescales each by its own
        # sd, which is dominated by the symmetric component, and that starves
        # the antisymmetric win signal.
        self.norms = nn.ModuleList(
            [nn.LayerNorm(d) for d in dims[1:-1]] + [nn.Identity()]
        )

        out_dim = dims[-1]
        self.win_head = nn.Linear(out_dim, 1, bias=False)
        self.region_bias = nn.Parameter(torch.zeros(n_regions))
        self.gold_head = nn.Linear(out_dim, 1, bias=False)
        self.duration_head = nn.Linear(out_dim, 1)

        nn.init.normal_(self.champ_emb.weight, std=0.05)
        nn.init.normal_(self.ban_emb.weight, std=0.05)
        with torch.no_grad():
            self.champ_emb.weight[0].zero_()
            self.ban_emb.weight[0].zero_()
            self.ban_emb.weight[1].zero_()

    # -- input assembly -----------------------------------------------------

    def _bundle(self, champ, role_probs, bans, patch):
        """(B,352) for a given (first team, second team) ordering."""
        b = champ.size(0)
        side = torch.zeros(N_SLOTS, dtype=torch.long, device=champ.device)
        side[5:] = 1
        tok = (
            self.champ_emb(champ)
            + self.role_proj(role_probs @ self.role_emb.weight)
            + self.side_emb(side).unsqueeze(0)
        )                                                        # (B,10,32)

        ban_vec = self.ban_emb(bans)                             # (B,10,8)
        live = (bans > 1).float().unsqueeze(-1)                  # NONE and UNKNOWN excluded
        halves = []
        for s in (slice(0, 5), slice(5, 10)):
            total = (ban_vec[:, s] * live[:, s]).sum(1)
            count = live[:, s].sum(1).clamp(min=1.0)
            halves.append(total / count)                         # masked MEAN, not sum
        return torch.cat(
            [tok.reshape(b, -1), halves[0], halves[1], self.patch_emb(patch)], dim=1
        )

    def _trunk_pair(self, x1, x2):
        """Both branches through the same weights with ONE shared dropout mask."""
        for lin, norm in zip(self.layers, self.norms):
            x1, x2 = norm(lin(x1)), norm(lin(x2))
            x1, x2 = F.gelu(x1), F.gelu(x2)
            if self.training and self.dropout > 0:
                keep = 1.0 - self.dropout
                mask = torch.bernoulli(torch.full_like(x1, keep)) / keep
                x1, x2 = x1 * mask, x2 * mask
        return x1, x2

    @staticmethod
    def _swap(champ, role_probs, bans):
        """Move each side's whole bundle atomically."""
        return (
            torch.cat([champ[:, 5:], champ[:, :5]], dim=1),
            torch.cat([role_probs[:, 5:], role_probs[:, :5]], dim=1),
            torch.cat([bans[:, 5:], bans[:, :5]], dim=1),
        )

    # -- forward ------------------------------------------------------------

    def forward(self, champ, role_probs, bans, patch, region, diagnostics=False):
        x_br = self._bundle(champ, role_probs, bans, patch)
        x_rb = self._bundle(*self._swap(champ, role_probs, bans), patch)
        h_br, h_rb = self._trunk_pair(x_br, x_rb)

        A = h_br - h_rb
        S = h_br + h_rb
        out = {
            # The search should consume this, not the probability: probabilities
            # compress near 0.5 and alpha-beta bounds live naturally in logits.
            "win_logit": self.win_head(A).squeeze(-1) + self.region_bias[region],
            # Standardising the gold target absorbs its side mean, so this head
            # needs no bias of its own.
            "gold_diff15": self.gold_head(A).squeeze(-1),
            # Duration is side-SYMMETRIC, so it reads S and keeps a bias.
            "log_duration": self.duration_head(S).squeeze(-1),
        }
        if diagnostics:
            out["cos_h"] = F.cosine_similarity(h_br, h_rb, dim=1).mean()
            out["a_over_s"] = (A.norm(dim=1) / S.norm(dim=1).clamp(min=1e-8)).mean()
        return out

    def n_parameters(self):
        return sum(p.numel() for p in self.parameters())

    def parameter_groups(self, weight_decay=0.05, champion_decay=0.2):
        """AdamW groups. LayerNorm parameters and biases are excluded from decay;
        the champion table takes a HIGHER decay, which shrinks rare champions
        toward the population rather than letting 1k-game champions keep large
        idiosyncratic vectors."""
        no_decay, champ, rest = [], [], []
        for name, p in self.named_parameters():
            if not p.requires_grad:
                continue
            if name.startswith("champ_emb") or name.startswith("ban_emb"):
                champ.append(p)
            elif p.ndim == 1 or "norm" in name.lower() or name.endswith(".bias"):
                no_decay.append(p)
            else:
                rest.append(p)
        return [
            {"params": rest, "weight_decay": weight_decay},
            {"params": champ, "weight_decay": champion_decay},
            {"params": no_decay, "weight_decay": 0.0},
        ]
