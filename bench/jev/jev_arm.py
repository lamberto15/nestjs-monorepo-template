"""Arm B: Jev over raw HTTP (stdlib only, no SDK install).

Reads TYPESAFE_API_KEY from the environment (never printed). One request per
item with four Noul questions, per the skill's "all questions in one call".
usage: jev_arm.py data.jsonl preds_jev.jsonl [limit]
Writes preds plus jev_runs.jsonl (latency, input tokens, model) for cost/latency.
"""
import json, os, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent

def inside(arg):  # file arguments must name files in bench/jev (SonarCloud S8707)
    path = (HERE / arg).resolve()
    if not path.is_relative_to(HERE):
        raise SystemExit(f"{arg}: not a file in {HERE}")
    return path

URL = os.environ.get("TYPESAFE_BASE_URL", "https://api.typesafe.ai") + "/v1/systemone"
MODEL = "jev-1.13.0"  # pinned: thresholds are tuned against this version
KEY = os.environ["TYPESAFE_API_KEY"]

# One Noul per label: several areas can apply at once.
QUESTIONS = {
    "backend": {"type": "noul",
        "instructions": "Does fixing or building what `issue.text` describes require changing the REST API server (NestJS code in apps/api: routes, services, database tables, migrations, queue workers, mail, auth) or the generated API client?",
        "criteria": {"true": "Server-side behaviour, data, or the API's contract must change",
                     "false": "Only the web UI, CI/deployment, or documentation changes"}},
    "frontend": {"type": "noul",
        "instructions": "Does fixing or building what `issue.text` describes require changing the web app (React pages, components, forms, browser behaviour in apps/web or packages/ui) or its browser tests?",
        "criteria": {"true": "Something a user sees or does in the browser must change",
                     "false": "Nothing in the browser UI changes"}},
    "ci": {"type": "noul",
        "instructions": "Does fixing or building what `issue.text` describes require changing CI workflows, Docker images, Compose files, Helm/Kubernetes, Caddy, monitoring, backups, or deployment infrastructure?",
        "criteria": {"true": "Build, pipeline, container, or deployment configuration must change",
                     "false": "No pipeline, image, or deployment configuration changes"}},
    "documentation": {"type": "noul",
        "instructions": "Is what `issue.text` describes a change to documentation ONLY, with no code, UI, or configuration change at all?",
        "criteria": {"true": "Only docs or README text changes",
                     "false": "Some code, UI, or configuration also changes"}},
}

def call(row):
    body = json.dumps({"model": MODEL, "state": {"issue": {"text": row["text"]}},
                       "questions": QUESTIONS}).encode()
    for attempt in range(5):
        req = urllib.request.Request(URL, data=body, headers={
            "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                out = json.load(resp)
            ms = (time.perf_counter() - start) * 1000
            p = {a: out["answers"][a]["noul"] for a in QUESTIONS}
            return row["id"], p, {"id": row["id"], "ms": ms, "model": out.get("model"),
                                  "input_tokens": out.get("usage", {}).get("input_tokens"), "retries": attempt}
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) or e.code >= 500:
                time.sleep(min(2 ** attempt, 16)); continue
            raise SystemExit(f"HTTP {e.code}: {e.read()[:300]!r}")  # 401/422: stop, don't burn calls
    return row["id"], None, {"id": row["id"], "error": "gave up after retries"}

rows = [json.loads(l) for l in open(inside(sys.argv[1]))]
if len(sys.argv) > 3:
    rows = rows[: int(sys.argv[3])]
with ThreadPoolExecutor(max_workers=6) as pool:  # skill: <= 8 workers per key
    results = list(pool.map(call, rows))
with open(inside(sys.argv[2]), "w") as preds, open(HERE / "jev_runs.jsonl", "w") as runs:
    for rid, p, run in results:
        runs.write(json.dumps(run) + "\n")
        if p is not None:
            preds.write(json.dumps({"id": rid, "p": p}) + "\n")
ok = [r for _, p, r in results if p is not None]
ms = sorted(r["ms"] for r in ok)
toks = sum(r["input_tokens"] or 0 for r in ok)
if ms:
    print(f"{len(ok)}/{len(rows)} ok; p50 {ms[len(ms)//2]:.0f} ms, p95 {ms[int(len(ms)*0.95)-1]:.0f} ms; "
          f"{toks} input tokens = ${toks * 0.042 / 1e6:.5f}; model {ok[0]['model']}")
