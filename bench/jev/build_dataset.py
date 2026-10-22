"""Build the issue-area gold set from main's squash-merge commits.

Input text = PR title + description with every conventional-commit
`type(scope):` prefix and PR/issue number removed, so the scope can't leak
the answer. Gold labels come from the paths each commit changed.
"""
import hashlib, json, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

def inside(arg):  # file arguments must name files in bench/jev (SonarCloud S8707)
    path = (HERE / arg).resolve()
    if not path.is_relative_to(HERE):
        raise SystemExit(f"{arg}: not a file in {HERE}")
    return path

REPO = sys.argv[1]
OUT = inside(sys.argv[2])

def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], check=True,
                          capture_output=True, text=True).stdout

AREAS = ["backend", "frontend", "ci", "documentation"]

def area_of(path):
    if path.startswith(("apps/api/", "packages/api-client/")):
        return "backend"
    if path.startswith(("apps/web/", "apps/web-e2e/", "packages/ui/")):
        return "frontend"
    if (path.startswith((".github/", "deploy/", "caddy/", "clamav/", "backup/",
                         "gotenberg/", "pgbouncer/", "redis/", "monitoring/",
                         "loadtest/", ".devcontainer/"))
            or re.match(r"compose(\.[\w-]+)?\.yaml$", path)
            or path.endswith("Dockerfile")):
        return "ci"
    if path.startswith("docs/") or path.endswith(".md"):
        return "doc"
    return None  # tools/, root config, lockfile: no area

SCOPE = re.compile(r"\b(feat|fix|chore|ci|docs|test|refactor|perf|build|style|revert)(\([^)]*\))?!?:\s*", re.I)
REFS = re.compile(r"\s*\(?#\d+\)?")

def clean(text):
    return re.sub(r"[ \t]+", " ", REFS.sub("", SCOPE.sub("", text))).strip()

shas = git("log", "origin/main", "--no-merges", "--format=%H").split()
rows = []
for sha in shas:
    subject = git("log", "-1", "--format=%s", sha).strip()
    if re.match(r"(chore|build)\(deps", subject) or "dependabot" in subject.lower():
        continue  # dependency bumps aren't issue-like
    body = git("log", "-1", "--format=%b", sha)
    paths = [p for p in git("show", "--format=", "--name-only", sha).splitlines() if p]
    areas = {a for a in map(area_of, paths) if a}
    labels = {a for a in areas if a != "doc"}
    if areas == {"doc"}:
        labels = {"documentation"}  # documentation = docs only
    if not labels:
        continue
    text = clean(subject) + "\n\n" + clean(body)[:1200]
    split = "dev" if int(hashlib.sha1(sha.encode(), usedforsecurity=False).hexdigest(), 16) % 10 < 4 else "test"
    rows.append({"id": sha[:10], "split": split, "text": text,
                 "labels": {a: a in labels for a in AREAS}})

with open(OUT, "w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")

print(len(rows), "items;", sum(r["split"] == "test" for r in rows), "test")
for a in AREAS:
    print(a, sum(r["labels"][a] for r in rows))
