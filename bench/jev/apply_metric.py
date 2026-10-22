"""Realistic triage action: add a label when P >= tau (tau tuned on dev for
precision >= 0.95 per label); report test precision and the share of true
labels it applied (recall)."""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python3 -I leaves bench/jev off the path
from evaluate import AREAS, dev, gold, inside, test  # noqa: E402

def pr(p, ids, a, t):
    hit = [i for i in ids if p[i][a] >= t]; pos = sum(gold[i]["labels"][a] for i in ids)
    tp = sum(gold[i]["labels"][a] for i in hit)
    return (tp / len(hit) if hit else 1.0), (tp / pos if pos else 0.0)
for path in sys.argv[2:]:
    p = {r["id"]: r["p"] for r in map(json.loads, open(inside(path)))}
    cells, applied, right, pos = [], 0, 0, 0
    for a in AREAS:
        ok = [t / 100 for t in range(5, 101) if pr(p, dev, a, t / 100)[0] >= 0.95 and any(p[i][a] >= t / 100 for i in dev)]
        if not ok: cells.append(f"{a[:5]}: none"); continue
        t = min(ok); prec, rec = pr(p, test, a, t)
        cells.append(f"{a[:5]} t={t:.2f} P={prec:.2f} R={rec:.2f}")
    print(f"{path.removeprefix('preds_').removesuffix('.jsonl'):<8}", " | ".join(cells))
