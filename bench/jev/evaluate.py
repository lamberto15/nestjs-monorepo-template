"""Score prediction files against the gold set.

usage: evaluate.py data.jsonl preds_a.jsonl [preds_b.jsonl ...]
Each preds line: {"id": ..., "p": {area: P(label applies)}}.
Thresholds for auto-labelling are tuned on the dev split, reported on test.
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

def inside(arg):  # file arguments must name files in bench/jev (SonarCloud S8707)
    path = (HERE / arg).resolve()
    if not path.is_relative_to(HERE):
        raise SystemExit(f"{arg}: not a file in {HERE}")
    return path

AREAS = ["backend", "frontend", "ci", "documentation"]
gold = {r["id"]: r for r in map(json.loads, open(inside(sys.argv[1])))}

def load(path):
    return {r["id"]: r["p"] for r in map(json.loads, open(inside(path)))}

def f1(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return 2 * p * r / (p + r) if p + r else 0.0

def metrics(preds, ids):
    per = {}
    for a in AREAS:
        tp = sum(preds[i][a] >= 0.5 and gold[i]["labels"][a] for i in ids)
        fp = sum(preds[i][a] >= 0.5 and not gold[i]["labels"][a] for i in ids)
        fn = sum(preds[i][a] < 0.5 and gold[i]["labels"][a] for i in ids)
        per[a] = f1(tp, fp, fn)
    exact = sum(all((preds[i][a] >= 0.5) == gold[i]["labels"][a] for a in AREAS) for i in ids) / len(ids)
    pairs = [(preds[i][a], gold[i]["labels"][a]) for i in ids for a in AREAS]
    brier = sum((p - y) ** 2 for p, y in pairs) / len(pairs)
    bins = [[] for _ in range(10)]
    for p, y in pairs:
        bins[min(int(p * 10), 9)].append((p, y))
    ece = sum(len(b) * abs(sum(p for p, _ in b) / len(b) - sum(y for _, y in b) / len(b))
              for b in bins if b) / len(pairs)
    return per, exact, brier, ece

def auto(preds, ids, band):
    """Auto-label an item only when every label's p is outside (band, 1-band)."""
    taken = [i for i in ids if all(preds[i][a] <= band or preds[i][a] >= 1 - band for a in AREAS)]
    right = sum(all((preds[i][a] >= 0.5) == gold[i]["labels"][a] for a in AREAS) for i in taken)
    return len(taken) / len(ids), (right / len(taken) if taken else 0.0)

dev = [i for i, r in gold.items() if r["split"] == "dev"]
test = [i for i, r in gold.items() if r["split"] == "test"]

print(f"items: dev {len(dev)}, test {len(test)}\n")
hdr = f"{'arm':<14}{'backend':>8}{'front':>8}{'ci':>8}{'docs':>8}{'macroF1':>9}{'exact':>8}{'brier':>8}{'ECE':>7}{'band':>6}{'cover':>7}{'prec':>7}"
print(hdr)
for path in sys.argv[2:]:
    preds = load(path)
    missing = [i for i in gold if i not in preds]
    if missing:
        print(f"{path}: {len(missing)} items missing, skipped"); continue
    per, exact, brier, ece = metrics(preds, test)
    # widest band whose dev precision is >= 0.95 (largest coverage)
    best = max(((auto(preds, dev, b)[0], b) for b in [x / 100 for x in range(0, 50)]
                if auto(preds, dev, b)[1] >= 0.95), default=(0.0, None))[1]
    cover, prec = auto(preds, test, best) if best is not None else (0.0, 0.0)
    best = best if best is not None else float("nan")
    name = path.removeprefix("preds_").removesuffix(".jsonl")
    print(f"{name:<14}" + "".join(f"{per[a]:>8.2f}" for a in AREAS)
          + f"{sum(per.values()) / 4:>9.2f}{exact:>8.2f}{brier:>8.3f}{ece:>7.3f}{best:>6.2f}{cover:>7.2f}{prec:>7.2f}")
