#!/usr/bin/env bash
# The restore drill (docs/deployment.md, "Backups and restore", "Restore
# drill"): proves that a backup restores, with the stack, the scripts and the
# procedure a real recovery uses.
#
#   1. starts the production stack under its own Compose project (the load
#      test's: loadtest/run.sh, compose.loadtest.yaml on top) and the backup
#      service, signs in as the seeded administrator and writes a few notes;
#   2. stops api and worker, counts the rows of every table, and takes a
#      backup (`backup`, the scheduled run's own script);
#   3. destroys PostgreSQL's volume: a new, empty cluster;
#   4. restores the dump into it with `restore` (backup/restore.sh), the
#      documented procedure, then counts again: the two must be identical;
#   5. starts the stack (migrate grants the app role what the dump skipped),
#      signs in again and reads a note back;
#   6. reports the durations (job summary in CI) and removes everything.
#
# Fails loudly on the first step that doesn't work; the stack and its logs are
# shown before it is removed. It never reads the repository's .env: the
# stack's settings are generated (loadtest/run.sh).
#
# RESTORE_DRILL_PROJECT     Compose project, loadtest-<name> (default loadtest-drill)
# RESTORE_DRILL_MAX_SECONDS the backup + restore time that fails the drill (default 600)
# RESTORE_DRILL_KEEP        `on` leaves the stack running at the end (default off)
# APP_IMAGE                 an image already built (CI); unset, the stack builds one
set -euo pipefail

cd "$(dirname "$0")/.."

export LOADTEST_PROJECT=${RESTORE_DRILL_PROJECT:-loadtest-drill}
export LOADTEST_OUT=${LOADTEST_OUT:-restore-drill/results}
# Nothing in this drill is a load test: no extra replicas, no bot check.
export LOADTEST_REPLICAS=1
max_seconds=${RESTORE_DRILL_MAX_SECONDS:-600}
keep=${RESTORE_DRILL_KEEP:-off}
if ! [[ "$max_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "RESTORE_DRILL_MAX_SECONDS=$max_seconds: a whole number of seconds" >&2
  exit 2
fi

run() { loadtest/run.sh "$@"; }
compose() { run compose "$@"; }
step() { printf '\n==> %s\n' "$*"; }
now() { date -u +%s; }

# Read from the stack's env file (loadtest/run.sh made it).
setting() { grep -E "^$1=" "$LOADTEST_OUT/stack.env" | cut -d= -f2-; }

# Every table's row count, in every schema the app or its stores own (the
# owner reads past row-level security): one "schema.table count" line each.
# `docker compose exec` over the local socket: PostgreSQL's image trusts it.
count_rows() {
  compose exec -T postgres psql --no-psqlrc -U app -d app -At -F ' ' <<'SQL'
SELECT format('%I.%I', schemaname, tablename),
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text
  FROM pg_tables
 WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 1;
SQL
}

# Signs in as the administrator inside an api container (Node's fetch; no
# port is published) and, with "seed", writes notes. Prints the note ids.
api_script() {
  local mode=$1
  compose exec -T -e MODE="$mode" -e NOTE_IDS="${2:-}" api node --input-type=module -e '
    const base = "http://127.0.0.1:3000";
    const json = { "Content-Type": "application/json" };
    const check = async (res, what) => {
      if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
      return res.json();
    };
    const { accessToken } = await check(
      await fetch(`${base}/v1/auth/token`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
      }),
      "administrator sign-in",
    );
    const auth = { Authorization: `Bearer ${accessToken}` };
    if (process.env.MODE === "seed") {
      for (let i = 1; i <= 12; i++) {
        const note = await check(
          await fetch(`${base}/v1/notes`, {
            method: "POST",
            headers: { ...json, ...auth, "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ title: `Restore drill note ${i}`, body: "Written before the backup." }),
          }),
          `note ${i}`,
        );
        console.log(note.id);
      }
    } else {
      for (const id of process.env.NOTE_IDS.split(",")) {
        const note = await check(await fetch(`${base}/v1/notes/${id}`, { headers: auth }), `note ${id}`);
        if (!String(note.title).startsWith("Restore drill note")) throw new Error(`note ${id} came back as ${JSON.stringify(note)}`);
      }
      console.log("signed in, read back " + process.env.NOTE_IDS.split(",").length + " notes");
    }
  '
}

summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
cleanup() {
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "The drill failed (exit $code). The stack, for the log:" >&2
    compose ps -a >&2 || true
    compose logs --tail 80 backup postgres migrate api >&2 || true
  fi
  if [ "$keep" != on ]; then run down || true; fi
  exit "$code"
}
trap cleanup EXIT

drill_start=$(now)

step "Starting the stack"
run up
compose --profile backup up -d backup
# The service's healthcheck (backup-health) is unhealthy until a run succeeds;
# the drill runs the first one itself.

step "Writing data"
note_ids=$(api_script seed | paste -sd, -)
echo "Notes: $note_ids"

step "Stopping api and worker, counting rows"
compose stop api worker
before=$(count_rows)
head -n 40 <<< "$before"
tables=$(echo "$before" | wc -l)
if [ "$tables" -lt 20 ]; then
  echo "Only $tables tables counted: the check would prove nothing." >&2
  exit 1
fi

step "Backing up"
backup_start=$(now)
compose exec -T backup backup
backup_seconds=$(($(now) - backup_start))
dump=$(compose exec -T backup sh -c 'ls -1t /backups/db-*.dump | head -n 1' | tr -d '\r')
[ -n "$dump" ] || {
  echo "No dump in /backups." >&2
  exit 1
}
echo "Dump: $dump (${backup_seconds}s)"

step "Destroying PostgreSQL's volume (a new, empty cluster)"
compose stop postgres
compose rm -f postgres
docker volume rm "${LOADTEST_PROJECT}_postgres_data"
compose up -d --wait postgres

step "Restoring"
restore_start=$(now)
# The password and the database come from the service's own environment.
compose exec -T backup restore "$dump" --yes
restore_seconds=$(($(now) - restore_start))

step "Comparing row counts"
after=$(count_rows)
if ! diff <(echo "$before") <(echo "$after"); then
  echo "The restored database differs from the one that was backed up." >&2
  exit 1
fi
echo "$tables tables, every count identical."

step "Starting the stack on the restored database"
# migrate runs again: it grants the app role the tables the dump left
# ungranted (the restore's --no-privileges), then api and worker start.
run up
api_script check "$note_ids"

total_seconds=$(($(now) - drill_start))
{
  echo "## Restore drill"
  echo
  echo "| Step | Seconds |"
  echo "| --- | ---: |"
  echo "| Backup | $backup_seconds |"
  echo "| Restore into a new cluster | $restore_seconds |"
  echo "| Whole drill | $total_seconds |"
  echo
  echo "$tables tables restored with identical row counts; the administrator signed in and read back $(echo "$note_ids" | tr ',' '\n' | wc -l) notes."
} >> "$summary"

if [ $((backup_seconds + restore_seconds)) -gt "$max_seconds" ]; then
  echo "Backup and restore took $((backup_seconds + restore_seconds))s, over RESTORE_DRILL_MAX_SECONDS=$max_seconds." >&2
  exit 1
fi
echo "Restore drill passed in ${total_seconds}s."
