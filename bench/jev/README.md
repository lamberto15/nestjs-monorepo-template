# Jev issue-area benchmark (do not merge)

A one-off experiment: can TypeSafe's Jev label an issue's area (backend,
frontend, ci, documentation) well enough to triage issues automatically?
It lives on this branch only so a new session can run the Jev arm; nothing
here is part of the template.

## Data

`data.jsonl`: 282 squash-merge commits from `main` (dependency bumps left
out). Each item's `text` is the PR title and description with every
`type(scope):` prefix and `#n` reference removed, so the scope can't give the
answer away. The labels come from the paths the commit changed
(`build_dataset.py`); `documentation` means docs only. Split 40/60 by a hash
of the SHA into `dev` (thresholds are tuned here) and `test` (reported).

The labels come from paths, so they include infrastructure a description
never mentions. A feature that also edits Caddy or Helm is labelled `ci`, and
no text model can see that: treat the `ci` scores as a floor shared by every
arm.

## Arms

| File | Arm |
| --- | --- |
| `preds_keyword.jsonl` | Keyword rules (`keyword_baseline.py`) |
| `preds_haiku.jsonl` | Haiku 5.5, as a Claude Code subagent (accuracy only: no API latency or cost) |
| `preds_sonnet.jsonl` | Sonnet 5.5, the same way |
| `preds_jev.jsonl` | Jev, from `jev_arm.py` (four Noul questions in one request, pinned to `jev-1.13.0`) |

## Running the Jev arm

Needs `TYPESAFE_API_KEY` in the environment and `api.typesafe.ai` allowed by
the network policy. Python's standard library only: no install.

```bash
cd bench/jev
python3 -I jev_arm.py data.jsonl preds_jev.jsonl 3   # probe: 3 calls
python3 -I jev_arm.py data.jsonl preds_jev.jsonl     # all 282
python3 -I evaluate.py data.jsonl preds_*.jsonl      # F1, exact match, Brier, ECE
python3 -I apply_metric.py data.jsonl preds_*.jsonl  # add a label at >= 95% dev precision
```

`jev_arm.py` also writes `jev_runs.jsonl` (latency, input tokens, model per
call) and prints p50/p95 latency and the cost.

## Results (test, 172 items)

| Arm | Macro-F1 | Exact | ECE | Frontend auto-label |
| --- | --- | --- | --- | --- |
| Keyword | 0.60 | 0.43 | – | none at 95% |
| Haiku 5.5 | 0.69 | 0.61 | 0.031 | P 0.97, R 0.76 |
| Sonnet 5.5 | 0.79 | 0.74 | 0.047 | P 0.97, R 0.90 |
| Jev (`jev-1.13.0`) | 0.59 | 0.49 | 0.034 | P 0.91, R 0.63 |

The bar, set before the run: Jev is worth adopting for triage if it roughly matches Haiku (macro-F1 about
0.69, frontend precision about 0.97 when auto-labelling) with calibrated
probabilities. Either way, record its p95 latency and the cost per 1,000 issues.

**Verdict: Jev doesn't clear the bar.** Its macro-F1 (0.59) matches the keyword
rules (0.60), not Haiku (0.69). Frontend auto-labelling reaches P 0.91 against
Haiku's 0.97, and backend gets P 0.97 only by applying the label to a third of
the items that need it (R 0.33). `documentation` is the weakest (F1 0.15 vs
Haiku's 0.40). Its probabilities are well calibrated (ECE 0.034, near Haiku's
0.031), so its errors are honest rather than overconfident. It is fast and
cheap: p50 165 ms, p95 274 ms, $0.0086 for all 282 calls (about $0.03 per
1,000 issues, 722 input tokens per call), no retries.
