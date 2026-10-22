"""Arm A: deterministic keyword rules. Writes preds_keyword.jsonl (p is 0 or 1)."""
import json, re, sys

RULES = {
    "backend": r"\b(api|endpoint|route|controller|service|migration|drizzle|postgres|sql|queue|bullmq|worker|tenant|rls|nestjs|dto|schema|webhook|mail|sms|push|audit|permission|token|auth|client)\b",
    "frontend": r"\b(web|page|ui|component|button|form|panel|banner|react|router|i18n|shadcn|dice ?ui|toast|dialog|pwa|browser|playwright|tab|sidebar|nav|dashboard|screen)\b",
    "ci": r"\b(ci|workflow|github actions?|docker|dockerfile|image|compose|helm|kubernetes|caddy|deploy|swarm|blue-green|prometheus|alert|grafana|loki|trivy|scan|backup|pgbouncer|gotenberg|clamav|devcontainer|load ?test|k6)\b",
    "documentation": r"\b(docs?|documentation|readme|guide|typo|wording|explain)\b",
}

data = [json.loads(l) for l in open(sys.argv[1])]
with open(sys.argv[2], "w") as out:
    for row in data:
        text = row["text"].lower()
        p = {a: 1.0 if re.search(rx, text) else 0.0 for a, rx in RULES.items()}
        if p["documentation"] and any(p[a] for a in ("backend", "frontend", "ci")):
            p["documentation"] = 0.0  # documentation means docs only
        out.write(json.dumps({"id": row["id"], "p": p}) + "\n")
