#!/usr/bin/env bash
# What the app must still do through PgBouncer in transaction mode
# (docs/deployment.md, "PgBouncer"), checked on the load test's stack with
# compose.pgbouncer.yaml on top (LOADTEST_PGBOUNCER=on): run after the k6
# scenarios, whose sign-ins, tenant-scoped lists, creates and exports went
# through it. Fails when:
#   - the app role's server connections exceed PGBOUNCER_POOL_SIZE (or are
#     none: the apps did not go through PgBouncer);
#   - a client's statement_timeout and idle_in_transaction_session_timeout
#     startup parameters (node-postgres sends both) don't take effect;
#   - a tenant setting (set_config(…, true), transaction-local) is still
#     there after COMMIT on a reused server connection;
#   - an advisory lock taken with pg_advisory_xact_lock is not released at COMMIT.
set -euo pipefail

cd "$(dirname "$0")/.."
export LOADTEST_PGBOUNCER=on
compose() { loadtest/run.sh compose "$@"; }
pool=${PGBOUNCER_POOL_SIZE:-20}

servers=$(compose exec -T postgres psql --no-psqlrc -U app -d app -At \
  -c "SELECT count(*) FROM pg_stat_activity WHERE usename = 'app_runtime'")
echo "Server connections of app_runtime: $servers (pool $pool)"
if [ "$servers" -lt 1 ] || [ "$servers" -gt "$pool" ]; then
  echo "Expected 1 to $pool: the api and worker are not pooled by PgBouncer." >&2
  exit 1
fi

# From an api container, as the app connects (node-postgres, its startup
# parameters), through the pgbouncer host.
compose exec -T api node --input-type=module -e '
  import pg from "pg";
  const url = new URL(process.env.DATABASE_URL);
  if (url.hostname !== "pgbouncer") throw new Error(`DATABASE_URL points at ${url.hostname}`);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1, // one server connection reused by every transaction below
    statement_timeout: 12345,
    idle_in_transaction_session_timeout: 23456,
  });
  const one = async (sql) => (await pool.query(sql)).rows[0];
  const expect = (actual, wanted, what) => {
    if (String(actual) !== String(wanted)) throw new Error(`${what}: ${actual}, wanted ${wanted}`);
  };

  const t = await one("SHOW statement_timeout");
  expect(t.statement_timeout, "12345ms", "statement_timeout");
  const i = await one("SHOW idle_in_transaction_session_timeout");
  expect(i.idle_in_transaction_session_timeout, "23456ms", "idle_in_transaction_session_timeout");

  // Transaction-local settings (the tenant wall, core/tenancy) end with the transaction.
  const client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.tenant_id', 'drill', true)");
  const inside = (await client.query("SELECT current_setting('app.tenant_id', true) AS v")).rows[0].v;
  expect(inside, "drill", "tenant setting inside the transaction");
  await client.query("COMMIT");
  const after = (await client.query("SELECT coalesce(current_setting('app.tenant_id', true), '') AS v")).rows[0].v;
  expect(after, "", "tenant setting after COMMIT");
  client.release();

  // Transaction-level advisory locks (every lock the app takes) go at COMMIT.
  const locker = await pool.connect();
  await locker.query("BEGIN");
  await locker.query("SELECT pg_advisory_xact_lock(4120412)");
  await locker.query("COMMIT");
  const held = await locker.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 4120412 AND pid = pg_backend_pid()");
  expect(held.rows[0].n, 0, "advisory locks held after COMMIT");
  locker.release();
  await pool.end();
  console.log("PgBouncer: startup limits, tenant settings and advisory locks behave.");
'
