#!/usr/bin/env python
"""Task 7 — ONNX export, the Phase 3 contract.

    .venv/bin/python export_onnx.py [--checkpoint model_seed0.pt]

Inputs   champions int64[B,10], role_probs float32[B,10,5], bans int64[B,10],
         patch int64[B], region int64[B], elo int64[B]
Outputs  logit float32[B]  and  p_blue_win float32[B]

`role_probs` is one tensor for four different things - a one-hot training row,
the solver's posterior, a champion pool's {champion, role} prior, or the
population prior - which is the whole point of a soft role input.

`elo` is ACCEPTED AND IGNORED in v1. The corpus is 100% apex, so a `diamond`
row would never receive a gradient and passing one in Phase 3 would return a
random vector. The input exists so the contract does not have to change the day
Diamond seeds are material.

The search should consume `logit`, not `p_blue_win`: probabilities compress
near 0.5 and alpha-beta bounds live naturally in logit space. `p_blue_win`
carries a SINGLE GLOBAL temperature and is calibrated at full drafts only.
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from common import ROOT
from model import DraftModel
from train import load_all

TRAIN_DIR = ROOT / "data/training"
OPSET = 17


class ExportWrapper(nn.Module):
    """Adds the temperature-scaled probability and the accepted-and-ignored elo."""

    def __init__(self, model, temperature):
        super().__init__()
        self.model = model
        self.register_buffer("temperature", torch.tensor(float(temperature)))

    def forward(self, champions, role_probs, bans, patch, region, elo):
        # `elo` is consumed so the graph declares the input, then discarded.
        _ = elo.sum() * 0
        out = self.model(champions, role_probs, bans, patch, region)
        logit = out["win_logit"]
        return logit, torch.sigmoid(logit / self.temperature)


def sample_inputs(n, n_champ, n_patch, n_region, seed=0):
    g = torch.Generator().manual_seed(seed)
    champs = torch.randint(0, n_champ, (n, 10), generator=g)
    role = torch.rand(n, 10, 5, generator=g)
    role = role / role.sum(-1, keepdim=True)
    return (
        champs,
        role,
        torch.randint(1, n_champ, (n, 10), generator=g),
        torch.randint(0, n_patch, (n,), generator=g),
        torch.randint(0, n_region, (n,), generator=g),
        torch.zeros(n, dtype=torch.long),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default="model_seed0.pt")
    ap.add_argument("--out", default=str(TRAIN_DIR))
    args = ap.parse_args()
    out_dir = Path(args.out)

    ds, i2a, dims, prior, factors = load_all()
    n_champ, n_patch, n_region = dims
    sweep = json.loads((out_dir / "sweep_aug.json").read_text())["winner"]
    ev = json.loads((out_dir / "evaluate.json").read_text())
    T = ev["global_temperature"]["T"]

    model = DraftModel(n_champ, n_patch, n_region, width=sweep["width"],
                       dropout=sweep["dropout"])
    model.load_state_dict(torch.load(out_dir / args.checkpoint))
    model.eval()
    wrapper = ExportWrapper(model, T).eval()      # dropout is stripped by eval()

    onnx_path = out_dir / "model.onnx"
    names = ["champions", "role_probs", "bans", "patch", "region", "elo"]
    torch.onnx.export(
        wrapper,
        sample_inputs(4, n_champ, n_patch, n_region),
        str(onnx_path),
        input_names=names,
        output_names=["logit", "p_blue_win"],
        dynamic_axes={n: {0: "batch"} for n in names + ["logit", "p_blue_win"]},
        opset_version=OPSET,
    )
    print(f"exported {onnx_path} (opset {OPSET}, dynamic batch)")

    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])

    # --- parity ---
    inputs = sample_inputs(256, n_champ, n_patch, n_region, seed=7)
    with torch.no_grad():
        ref_logit, ref_p = wrapper(*inputs)
    feed = {n: v.numpy() for n, v in zip(names, inputs)}
    got_logit, got_p = sess.run(None, feed)
    d_logit = float(np.abs(ref_logit.numpy() - got_logit).max())
    d_p = float(np.abs(ref_p.numpy() - got_p).max())
    print(f"parity vs PyTorch: max |Δlogit| = {d_logit:.2e}, max |Δp| = {d_p:.2e}")
    assert d_logit < 1e-5 and d_p < 1e-5, "ONNX parity failed"

    # --- latency (gate 5) ---
    rates = {}
    for batch in (1, 64, 512):
        inp = sample_inputs(batch, n_champ, n_patch, n_region, seed=batch)
        feed = {n: v.numpy() for n, v in zip(names, inp)}
        for _ in range(5):
            sess.run(None, feed)
        reps = max(3, int(2000 / batch))
        t0 = time.perf_counter()
        for _ in range(reps):
            sess.run(None, feed)
        dt = (time.perf_counter() - t0) / reps
        rates[str(batch)] = batch / dt
        print(f"batch {batch:>4}: {dt * 1e3:8.3f} ms  ->  {batch / dt:12,.0f} evaluations/second")

    (out_dir / "onnx_latency.json").write_text(json.dumps(
        {"parity_max_abs_logit": d_logit, "parity_max_abs_p": d_p,
         "evals_per_second": rates, "opset": OPSET}, indent=2))

    # --- the shipped bundle ---
    card = [
        "# Model card — draft win probability v1\n",
        f"- checkpoint `{args.checkpoint}`, config `{sweep}`",
        f"- parameters: {model.n_parameters():,}",
        f"- global temperature T = {T:.4f}",
        "",
        "## Data window",
        "155,816 apex solo-queue games, patches 16.15/16.16, regions na1/euw1/kr,",
        "extractor v3. Per-region time split; test is pure 16.16.",
        "",
        "## Stated assumptions (v1)",
        "- **Root-turn distribution**: uniform over the 20 turns. A PRODUCT",
        "  assumption about where users open the Navigator, not a measurement.",
        "- **Role-subset order**: uniform over role subsets of the required size.",
        "  Riot's match data carries no pick order, so which roles are filled at a",
        "  partial turn cannot be learned from the corpus.",
        "- **Achieved search depth**: measured (Task 1b-b), not assumed.",
        "",
        "## Contract notes",
        "- Consume `logit`, not `p_blue_win`: probabilities compress near 0.5 and",
        "  alpha-beta bounds live naturally in logit space.",
        "- `p_blue_win` carries a SINGLE GLOBAL temperature and is calibrated at",
        "  FULL drafts. Per-bucket temperatures ship as a JSON table below and are",
        "  graph-baked in Phase 3.",
        "- `elo` is accepted and IGNORED in v1 (the corpus is 100% apex).",
        "- `region = -1` is reserved for averaging the side bias.",
        "",
        "## Per-masked-slot-bucket temperatures",
        "```json",
        json.dumps(ev.get("temperatures", {}), indent=2),
        "```",
    ]
    (out_dir / "model_card.md").write_text("\n".join(card) + "\n")
    print(f"wrote {out_dir}/model_card.md and onnx_latency.json")


if __name__ == "__main__":
    main()
