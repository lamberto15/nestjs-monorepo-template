import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { is, type SQL } from 'drizzle-orm';
import {
  getTableConfig,
  PgDialect,
  type PgPolicy,
  PgRole,
  PgTable,
  pgTable,
  uuid,
} from 'drizzle-orm/pg-core';
import { GLOBAL_TABLES_WITH_TENANT } from '../tenancy/global-tables.js';
import { tenantPolicies } from '../tenancy/tenant-scope.js';
import { Client, type ClientBase, escapeIdentifier, escapeLiteral } from 'pg';
import * as schema from '../../schema.js';

/**
 * The two connections a deployment has (docs/deployment.md, "Database roles"):
 * the owner's, which owns every table and runs the migrations
 * (DATABASE_OWNER_URL: `migrate`, and the app itself when MIGRATE_ON_START is
 * on), and the app's, which api and worker use (DATABASE_URL). Same server,
 * same database, two roles.
 */
export type DatabaseUrls = {
  ownerUrl: string;
  appUrl: string;
  /**
   * The maintenance role's (DATABASE_MAINTENANCE_URL): BYPASSRLS, used only
   * by the worker's sweeps across tenants (docs/tenancy.md, "The bypass").
   * Unset: no such role is made or checked.
   */
  maintenanceUrl?: string;
};

/**
 * Makes DATABASE_URL's role fit for api and worker, as the owner: the role
 * exists with that password and can log in; it is no superuser, doesn't
 * bypass row-level security, creates neither databases nor roles, and owns
 * nothing; it may use every schema the migrations made (`public`, the
 * stores' `nest_*`; not `drizzle`, the migrations' own bookkeeping), read
 * and write every table there and use every sequence, and tables the owner
 * creates later (the next deploy's migrations) get the same through
 * `ALTER DEFAULT PRIVILEGES`. It never gets CREATE on a schema. Run after
 * every migration, so a new schema or table is covered the same deploy.
 *
 * Idempotent: a second run finds nothing to change. The attributes of an
 * existing role are checked, not changed: a role someone made a superuser is
 * refused with the statement that fixes it, rather than silently demoted.
 *
 * This is code, not a drizzle-kit migration, because drizzle-kit can declare
 * a role (`pgRole`, `entities.roles`) but emits no GRANT and no ALTER DEFAULT
 * PRIVILEGES, and the role's name and password belong to the deployment
 * (.env), not to the schema. It is cluster setup, run by the migrate entrypoint.
 *
 * Works without a superuser: on managed PostgreSQL the owner is the account
 * the provider gives, which has CREATEROLE (PostgreSQL 16+ then lets it alter
 * the roles it created) and owns the database and its objects.
 */
export async function ensureAppRole(
  urls: DatabaseUrls,
  log: (line: string) => void = () => {},
  /** Tables beyond the app's schema: the tests' fixtures (test/global-setup.ts). */
  extraTables: Record<string, unknown> = {},
) {
  const owner = credentials(urls.ownerUrl, 'DATABASE_OWNER_URL');
  const app = credentials(urls.appUrl, 'DATABASE_URL');
  if (owner.role === app.role) {
    throw new Error(
      `DATABASE_URL and DATABASE_OWNER_URL both connect as "${app.role}": the app would own its tables and bypass row-level security. Give the app a role of its own (docs/deployment.md, "Database roles").`,
    );
  }
  if (owner.database !== app.database) {
    throw new Error(
      `DATABASE_URL (database "${app.database}") and DATABASE_OWNER_URL (database "${owner.database}") must name the same database.`,
    );
  }
  const maintenance = urls.maintenanceUrl
    ? credentials(urls.maintenanceUrl, 'DATABASE_MAINTENANCE_URL')
    : undefined;
  if (maintenance) {
    if (maintenance.role === app.role || maintenance.role === owner.role) {
      throw new Error(
        `DATABASE_MAINTENANCE_URL connects as "${maintenance.role}", the role of DATABASE_URL or DATABASE_OWNER_URL: the maintenance role (BYPASSRLS) must be one of its own, which api never holds (docs/deployment.md, "Database roles").`,
      );
    }
    if (maintenance.database !== app.database) {
      throw new Error(
        `DATABASE_MAINTENANCE_URL (database "${maintenance.database}") and DATABASE_URL (database "${app.database}") must name the same database.`,
      );
    }
  }
  const client = new Client({
    connectionString: urls.ownerUrl,
    application_name: 'migrate:roles',
  });
  await client.connect();
  let created = false;
  let maintenanceCreated = false;
  try {
    await client.query('begin');
    // One bootstrap at a time (two deploys, or a deploy and a developer).
    await client.query(
      `select pg_advisory_xact_lock(hashtext('nestjs-monorepo-template:app-role'))`,
    );
    created = await ensureRole(client, app, log);
    if (maintenance) {
      maintenanceCreated = await ensureRole(client, maintenance, log, {
        bypassRls: true,
      });
    }
    const schemas = await applicationSchemas(client);
    await warnAboutForeignOwners(client, owner.role, schemas, log);
    for (const role of [app, ...(maintenance ? [maintenance] : [])]) {
      await grantConnect(client, role, log);
      for (const schema of schemas) {
        await grantSchema(client, owner.role, role.role, schema);
      }
    }
    await forceRowLevelSecurity(client, log, extraTables);
    await assertFit(client, app.role, schemas);
    if (maintenance) {
      await assertFit(client, maintenance.role, schemas);
    }
    await assertTenantWall(client, extraTables);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
    throw error;
  }
  try {
    // Set only when it doesn't work: no churn, and a trust server is left
    // alone. After the commit and outside the advisory lock, on purpose: the
    // check connects as the app, which needs the committed role and grants.
    // Two bootstraps at once (two deploys) may both set it, and the last one
    // wins: the same password from the same .env, and a password grants no
    // privilege, so nothing above is at stake.
    const passwordSet = await ensurePassword(client, app, urls.appUrl, created);
    if (maintenance) {
      const maintenanceSet = await ensurePassword(
        client,
        maintenance,
        urls.maintenanceUrl!,
        maintenanceCreated,
      );
      log(
        `Maintenance role "${maintenance.role}" ${maintenanceCreated ? 'created' : 'checked'}${maintenanceSet ? ', password set' : ''}: BYPASSRLS for the worker's sweeps across tenants, no superuser, owns nothing.`,
      );
    }
    log(
      `App role "${app.role}" ${created ? 'created' : 'checked'}${passwordSet ? ', password set' : ''}: no superuser, no RLS bypass, owns nothing.`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The built-in functions behind the lists' indexed text filters: ILIKE
 * (`texticlike`: contains, startsWith, endsWith, on the trigram indexes)
 * and full-text `@@` (`ts_match_vq`: `?q=`, on the search indexes).
 */
const FILTER_FUNCTIONS = [
  'texticlike(text,text)',
  'ts_match_vq(tsvector,tsquery)',
] as const;

/**
 * Marks FILTER_FUNCTIONS `LEAKPROOF`, so PostgreSQL may use the trigram and
 * search indexes under the tenants' row-level security: it evaluates a
 * condition below a policy's only when its function is leakproof, and
 * otherwise walks the primary key and filters every row, which on a large
 * table turns a filter that matches nothing into a scan of the whole table
 * (#851). Neither function reveals a row through an error. Only a superuser
 * may alter a built-in function: from any other owner (managed
 * PostgreSQL) this names the statements for one to run and goes on; the
 * filters stay correct, only slower. Idempotent.
 */
export async function ensureLeakproofFilters(
  url: string,
  log: (line: string) => void = () => {},
) {
  const client = new Client({
    connectionString: url,
    application_name: 'migrate:leakproof',
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ fn: string; leakproof: boolean }>(
      `select oid::regprocedure::text as fn, proleakproof as leakproof
       from pg_proc where oid = any($1::regprocedure[])`,
      [FILTER_FUNCTIONS],
    );
    const missing = rows.filter((row) => !row.leakproof).map((row) => row.fn);
    if (missing.length === 0) {
      return;
    }
    const { rows: role } = await client.query<{ superuser: boolean }>(
      `select rolsuper as superuser from pg_roles where rolname = current_user`,
    );
    const statements = missing.map((fn) => `alter function ${fn} leakproof`);
    if (!role[0]?.superuser) {
      log(
        `Text filters under row-level security can't use their indexes until a superuser runs: ${statements.join('; ')} (docs/deployment.md, "Database roles").`,
      );
      return;
    }
    for (const statement of statements) {
      await client.query(statement);
    }
    log(
      `Marked leakproof for the indexed text filters: ${missing.join(', ')}.`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

type Credentials = { role: string; password: string; database: string };

/** The monitoring role: its name and password (POSTGRES_MONITOR_USER, POSTGRES_MONITOR_PASSWORD). */
export type MonitorRole = { role: string; password: string };

/**
 * The role the PostgreSQL exporter connects as (compose.monitoring.yaml;
 * docs/deployment.md, "Database roles"), as the owner: it exists with that
 * password and can log in, with the same flags as the app role (no
 * superuser, no RLS bypass, creates nothing), is a member of `pg_monitor`
 * and of nothing else, owns nothing and can't read a single application
 * table: `pg_stat_*`, the settings and the database sizes are all it sees.
 * Idempotent, like `ensureAppRole()`; the role's attributes are checked,
 * never changed, and a password that fails is set from `monitor.password`
 * (that is how it rotates). Returns the log line.
 *
 * `GRANT pg_monitor` needs the owner to hold `pg_monitor` with ADMIN OPTION
 * (a superuser has everything; a managed PostgreSQL's admin role may need
 * `GRANT pg_monitor TO <owner> WITH ADMIN OPTION` from the provider, or the
 * membership granted by hand once): the error says which.
 */
export async function ensureMonitorRole(
  urls: Pick<DatabaseUrls, 'ownerUrl'> & Partial<DatabaseUrls>,
  monitor: MonitorRole,
  log: (line: string) => void = () => {},
) {
  const ownerUrl = urls.ownerUrl;
  const owner = credentials(ownerUrl, 'DATABASE_OWNER_URL');
  if (!monitor.role || !monitor.password) {
    throw new Error(
      'POSTGRES_MONITOR_USER and POSTGRES_MONITOR_PASSWORD (or its _FILE) are both required for the monitoring role.',
    );
  }
  // Never a role that holds more: the owner, the app (every table), the
  // maintenance role (BYPASSRLS, every tenant).
  for (const [name, url] of [
    ['DATABASE_OWNER_URL', ownerUrl],
    ['DATABASE_URL', urls.appUrl],
    ['DATABASE_MAINTENANCE_URL', urls.maintenanceUrl],
  ] as const) {
    if (url && credentials(url, name).role === monitor.role) {
      throw new Error(
        `POSTGRES_MONITOR_USER names the role of ${name} ("${monitor.role}"): the exporter must connect as a role of its own, with pg_monitor only.`,
      );
    }
  }
  const creds: Credentials = { ...monitor, database: owner.database };
  const client = new Client({
    connectionString: ownerUrl,
    application_name: 'migrate:roles',
  });
  await client.connect();
  let created = false;
  try {
    await client.query('begin');
    await client.query(
      `select pg_advisory_xact_lock(hashtext('nestjs-monorepo-template:monitor-role'))`,
    );
    created = await ensureRole(client, creds, log);
    await grantMonitor(client, monitor.role);
    await grantConnect(client, creds, log);
    await assertMonitorFit(
      client,
      monitor.role,
      await applicationSchemas(client),
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
    throw error;
  }
  try {
    const url = new URL(ownerUrl);
    url.username = encodeURIComponent(monitor.role);
    url.password = encodeURIComponent(monitor.password);
    const passwordSet = await ensurePassword(
      client,
      creds,
      url.toString(),
      created,
    );
    log(
      `Monitor role "${monitor.role}" ${created ? 'created' : 'checked'}${passwordSet ? ', password set' : ''}: pg_monitor only, owns nothing, reads no table.`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** `GRANT pg_monitor`, once; the owner needs ADMIN OPTION on it (a superuser has it). */
async function grantMonitor(client: ClientBase, role: string) {
  const { rows } = await client.query(
    `select 1 from pg_auth_members m
     where m.member = $1::regrole and m.roleid = 'pg_monitor'::regrole`,
    [role],
  );
  if (rows.length > 0) {
    return;
  }
  try {
    await client.query(`grant pg_monitor to ${escapeIdentifier(role)}`);
  } catch (error) {
    if ((error as { code?: string }).code !== INSUFFICIENT_PRIVILEGE) {
      throw error;
    }
    throw new Error(
      `The owner may not grant pg_monitor: run \`GRANT pg_monitor TO ${escapeIdentifier(role)}\` as a superuser (or give the owner \`GRANT pg_monitor TO <owner> WITH ADMIN OPTION\` once), then run the migration again.`,
    );
  }
}

/**
 * The monitoring role fits before anything commits: a member of
 * `pg_monitor` and of nothing else (`pg_read_all_data`, the owner, the app
 * role would hand it the tables), owns nothing, creates nothing, and holds
 * no privilege on any application table: the exporter reads statistics,
 * never rows.
 */
async function assertMonitorFit(
  client: ClientBase,
  role: string,
  schemas: string[],
) {
  const problems: string[] = [];
  // ensureRole() refuses these on an existing role already; checked again
  // here so the role's fitness reads in one place.
  const flags = await client.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(`select rolsuper, rolbypassrls from pg_roles where rolname = $1`, [role]);
  if (flags.rows[0]?.rolsuper || flags.rows[0]?.rolbypassrls) {
    problems.push(
      `is a superuser or bypasses row-level security: run ALTER ROLE ${escapeIdentifier(role)} NOSUPERUSER NOBYPASSRLS`,
    );
  }
  const memberships = await client.query<{ rolname: string }>(
    `select r.rolname from pg_auth_members m
     join pg_roles r on r.oid = m.roleid
     where m.member = $1::regrole
     order by 1`,
    [role],
  );
  const others = memberships.rows
    .map((row) => row.rolname)
    .filter((name) => name !== 'pg_monitor');
  if (others.length > 0) {
    problems.push(
      `is a member of ${others.map((name) => `"${name}"`).join(', ')} besides pg_monitor: run ${others
        .map(
          (name) =>
            `REVOKE ${escapeIdentifier(name)} FROM ${escapeIdentifier(role)}`,
        )
        .join('; ')}`,
    );
  }
  const owned = await client.query<{ what: string; count: string }>(
    `select 'relation' as what, count(*)::text from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = $1
     union all
     select 'schema', count(*)::text from pg_namespace n join pg_roles r on r.oid = n.nspowner where r.rolname = $1
     union all
     select 'database', count(*)::text from pg_database d join pg_roles r on r.oid = d.datdba where r.rolname = $1`,
    [role],
  );
  for (const row of owned.rows) {
    if (row.count !== '0') {
      problems.push(`owns ${row.count} ${row.what}(s)`);
    }
  }
  const creates = await client.query<{ nspname: string }>(
    `select nspname from pg_namespace
     where nspname = any($2::text[]) and has_schema_privilege($1, oid, 'CREATE')`,
    [role, schemas],
  );
  for (const row of creates.rows) {
    problems.push(`may CREATE in schema "${row.nspname}"`);
  }
  const readable = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($2::text[])
       and c.relkind in ('r', 'p', 'v', 'm')
       and (has_table_privilege($1, c.oid, 'SELECT')
            or has_table_privilege($1, c.oid, 'INSERT')
            or has_table_privilege($1, c.oid, 'UPDATE')
            or has_table_privilege($1, c.oid, 'DELETE'))
     order by 1`,
    [role, schemas],
  );
  if (readable.rows.length > 0) {
    problems.push(
      `can read or write ${readable.rows
        .slice(0, 5)
        .map((row) => row.name)
        .join(
          ', ',
        )}${readable.rows.length > 5 ? ', …' : ''} (the exporter needs statistics, not rows)`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Role "${role}" is not fit for monitoring: ${problems.join('; ')}. Nothing was changed.`,
    );
  }
}

/** The reporting role: its name and password (POSTGRES_REPORTING_USER, POSTGRES_REPORTING_PASSWORD). */
export type ReportingRole = { role: string; password: string };

/**
 * The schema of the platform analytics' aggregates (platform/analytics,
 * `analytics.platform_metrics`): the only one the reporting role reads.
 */
export const ANALYTICS_SCHEMA = 'analytics';

/**
 * The role platform analytics connect as (docs/tenancy.md, "Platform
 * analytics"; roadmap 1b), as the owner: it exists with that password and
 * can log in, with the app role's flags (no superuser, no RLS bypass,
 * creates nothing), is a member of no role, owns nothing, and holds SELECT
 * on the tables of the `analytics` schema (anonymized aggregates the worker
 * stores) and no privilege on any other table: not one tenant row, not the
 * global tables (`users`, `tenants`), not the stores'. Tables the owner adds
 * to `analytics` later are readable through `ALTER DEFAULT PRIVILEGES`.
 * Idempotent, like `ensureAppRole()`: attributes are checked, never changed,
 * and a password that fails is set (how it rotates). Run after the
 * migrations, which make the schema. Returns nothing; logs one line.
 *
 * The documented PostgreSQL way (GRANT, ALTER DEFAULT PRIVILEGES): a login
 * role of its own with grants on the aggregates only, rather than views over
 * the tenant tables (a view reads as its owner, whom FORCE ROW LEVEL
 * SECURITY binds) or a member of the app role (every table).
 */
export async function ensureReportingRole(
  urls: Pick<DatabaseUrls, 'ownerUrl'> & Partial<DatabaseUrls>,
  reporting: ReportingRole,
  log: (line: string) => void = () => {},
) {
  const ownerUrl = urls.ownerUrl;
  const owner = credentials(ownerUrl, 'DATABASE_OWNER_URL');
  if (!reporting.role || !reporting.password) {
    throw new Error(
      'POSTGRES_REPORTING_USER and POSTGRES_REPORTING_PASSWORD (or its _FILE) are both required for the reporting role.',
    );
  }
  // Never a role that holds more: the owner, the app (every table), the
  // maintenance role (BYPASSRLS, every tenant).
  for (const [name, url] of [
    ['DATABASE_OWNER_URL', ownerUrl],
    ['DATABASE_URL', urls.appUrl],
    ['DATABASE_MAINTENANCE_URL', urls.maintenanceUrl],
  ] as const) {
    if (url && credentials(url, name).role === reporting.role) {
      throw new Error(
        `POSTGRES_REPORTING_USER names the role of ${name} ("${reporting.role}"): platform analytics must connect as a role of its own, which reads the anonymized aggregates only.`,
      );
    }
  }
  const creds: Credentials = { ...reporting, database: owner.database };
  const client = new Client({
    connectionString: ownerUrl,
    application_name: 'migrate:roles',
  });
  await client.connect();
  let created = false;
  try {
    await client.query('begin');
    await client.query(
      `select pg_advisory_xact_lock(hashtext('nestjs-monorepo-template:reporting-role'))`,
    );
    const exists = await client.query(
      `select 1 from pg_namespace where nspname = $1`,
      [ANALYTICS_SCHEMA],
    );
    if (exists.rows.length === 0) {
      throw new Error(
        `The schema "${ANALYTICS_SCHEMA}" doesn't exist: run the migrations first (the reporting role reads it only).`,
      );
    }
    created = await ensureRole(client, creds, log);
    await grantConnect(client, creds, log);
    const s = escapeIdentifier(ANALYTICS_SCHEMA);
    const role = escapeIdentifier(reporting.role);
    for (const statement of [
      `grant usage on schema ${s} to ${role}`,
      `revoke create on schema ${s} from ${role}`,
      `grant select on all tables in schema ${s} to ${role}`,
      `alter default privileges for role ${escapeIdentifier(owner.role)} in schema ${s} grant select on tables to ${role}`,
    ]) {
      await client.query(statement);
    }
    await assertReportingFit(
      client,
      reporting.role,
      await applicationSchemas(client),
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    await client.end().catch(() => undefined);
    throw error;
  }
  try {
    const url = new URL(ownerUrl);
    url.username = encodeURIComponent(reporting.role);
    url.password = encodeURIComponent(reporting.password);
    const passwordSet = await ensurePassword(
      client,
      creds,
      url.toString(),
      created,
    );
    log(
      `Reporting role "${reporting.role}" ${created ? 'created' : 'checked'}${passwordSet ? ', password set' : ''}: reads the ${ANALYTICS_SCHEMA} schema's aggregates only, no tenant row, owns nothing.`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The reporting role fits before anything commits: no superuser, no RLS
 * bypass, a member of nothing (`pg_read_all_data` or the app role would hand
 * it every row), owns nothing, creates nothing; SELECT on every table of
 * `analytics` and nothing more there; no privilege at all on a table of any
 * other schema the app uses. And the aggregates name nobody: a table of
 * `analytics` with a `tenant_id` or `user_id` column is refused.
 */
async function assertReportingFit(
  client: ClientBase,
  role: string,
  schemas: string[],
) {
  const problems: string[] = [];
  const flags = await client.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(`select rolsuper, rolbypassrls from pg_roles where rolname = $1`, [role]);
  if (flags.rows[0]?.rolsuper || flags.rows[0]?.rolbypassrls) {
    problems.push(
      `is a superuser or bypasses row-level security: run ALTER ROLE ${escapeIdentifier(role)} NOSUPERUSER NOBYPASSRLS`,
    );
  }
  const memberships = await client.query<{ rolname: string }>(
    `select r.rolname from pg_auth_members m
     join pg_roles r on r.oid = m.roleid
     where m.member = $1::regrole
     order by 1`,
    [role],
  );
  if (memberships.rows.length > 0) {
    problems.push(
      `is a member of ${memberships.rows.map((row) => `"${row.rolname}"`).join(', ')} (their rights are its rights): run ${memberships.rows
        .map(
          (row) =>
            `REVOKE ${escapeIdentifier(row.rolname)} FROM ${escapeIdentifier(role)}`,
        )
        .join('; ')}`,
    );
  }
  const owned = await client.query<{ what: string; count: string }>(
    `select 'relation' as what, count(*)::text from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = $1
     union all
     select 'schema', count(*)::text from pg_namespace n join pg_roles r on r.oid = n.nspowner where r.rolname = $1
     union all
     select 'database', count(*)::text from pg_database d join pg_roles r on r.oid = d.datdba where r.rolname = $1`,
    [role],
  );
  for (const row of owned.rows) {
    if (row.count !== '0') {
      problems.push(`owns ${row.count} ${row.what}(s)`);
    }
  }
  const creates = await client.query<{ nspname: string }>(
    `select nspname from pg_namespace
     where nspname = any($2::text[]) and has_schema_privilege($1, oid, 'CREATE')`,
    [role, schemas],
  );
  for (const row of creates.rows) {
    problems.push(`may CREATE in schema "${row.nspname}"`);
  }
  const database = await client.query<{ create: boolean }>(
    `select has_database_privilege($1, current_database(), 'CREATE') as create`,
    [role],
  );
  if (database.rows[0]?.create) {
    problems.push('may CREATE (schemas) in the database');
  }
  // Outside `analytics`: no privilege on any relation. Inside: SELECT, and
  // nothing that writes. One privilege per call (a list is ANY of them).
  const outside = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($2::text[]) and n.nspname <> $3
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and (has_table_privilege($1, c.oid, 'SELECT')
            or has_table_privilege($1, c.oid, 'INSERT')
            or has_table_privilege($1, c.oid, 'UPDATE')
            or has_table_privilege($1, c.oid, 'DELETE')
            or has_table_privilege($1, c.oid, 'TRUNCATE'))
     order by 1`,
    [role, schemas, ANALYTICS_SCHEMA],
  );
  if (outside.rows.length > 0) {
    problems.push(
      `can read or write ${outside.rows
        .slice(0, 5)
        .map((row) => row.name)
        .join(
          ', ',
        )}${outside.rows.length > 5 ? ', …' : ''} (it reads the ${ANALYTICS_SCHEMA} aggregates only): revoke it`,
    );
  }
  const inside = await client.query<{ name: string; reads: boolean }>(
    `select n.nspname || '.' || c.relname as name,
            has_table_privilege($1, c.oid, 'SELECT') as reads
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $2 and c.relkind in ('r', 'p', 'v', 'm')
       and (not has_table_privilege($1, c.oid, 'SELECT')
            or has_table_privilege($1, c.oid, 'INSERT')
            or has_table_privilege($1, c.oid, 'UPDATE')
            or has_table_privilege($1, c.oid, 'DELETE')
            or has_table_privilege($1, c.oid, 'TRUNCATE'))
     order by 1`,
    [role, ANALYTICS_SCHEMA],
  );
  for (const row of inside.rows) {
    problems.push(
      row.reads ? `may write ${row.name}` : `can't read ${row.name}`,
    );
  }
  const identifying = await client.query<{ name: string }>(
    `select c.relname || '.' || a.attname as name
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
     where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm')
       and a.attname in ('tenant_id', 'user_id')
     order by 1`,
    [ANALYTICS_SCHEMA],
  );
  if (identifying.rows.length > 0) {
    problems.push(
      `would read ${identifying.rows.map((row) => row.name).join(', ')}: the ${ANALYTICS_SCHEMA} schema holds anonymized aggregates, never a tenant's or a user's id`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Role "${role}" is not fit for platform analytics: ${problems.join('; ')}. Nothing was changed.`,
    );
  }
}

/** The role, password and database of a postgres:// URL. */
function credentials(url: string, name: string): Credentials {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} is not a URL.`);
  }
  if (!parsed.username) {
    throw new Error(`${name} names no role (postgres://role:secret@host/db).`);
  }
  return {
    role: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

type RoleFlags = {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolcanlogin: boolean;
};

/** Creates the role when it is missing; checks its attributes when it exists. Returns whether it was created. */
async function ensureRole(
  client: ClientBase,
  app: Credentials,
  log: (line: string) => void,
  { bypassRls = false }: { bypassRls?: boolean } = {},
) {
  const { rows } = await client.query<RoleFlags>(
    `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
     from pg_roles where rolname = $1`,
    [app.role],
  );
  const role = escapeIdentifier(app.role);
  if (rows.length === 0) {
    // Only the hash crosses the wire (PASSWORD takes a SCRAM verifier), so
    // the secret never reaches the server's statement log.
    try {
      await client.query('savepoint create_role');
      await client.query(
        `create role ${role} login nosuperuser ${bypassRls ? 'bypassrls' : 'nobypassrls'} nocreatedb nocreaterole noreplication inherit password ${escapeLiteral(scramSha256Verifier(app.password))}`,
      );
      await client.query('release savepoint create_role');
    } catch (error) {
      if (
        bypassRls &&
        (error as { code?: string }).code === INSUFFICIENT_PRIVILEGE
      ) {
        throw new Error(
          `The owner may not create "${app.role}" with BYPASSRLS (only a superuser, or a role with BYPASSRLS, may). Create it once as one: CREATE ROLE ${role} LOGIN BYPASSRLS PASSWORD '…'; then migrate again (docs/deployment.md, "Database roles").`,
          { cause: error },
        );
      }
      throw error;
    }
    return true;
  }
  const [flags] = rows;
  const forbidden = (
    [
      ['rolsuper', 'NOSUPERUSER'],
      ['rolbypassrls', 'NOBYPASSRLS'],
      ['rolcreatedb', 'NOCREATEDB'],
      ['rolcreaterole', 'NOCREATEROLE'],
      ['rolreplication', 'NOREPLICATION'],
    ] as const
  )
    // The maintenance role must bypass row-level security; the app must not.
    .filter(([flag]) =>
      flag === 'rolbypassrls' ? flags[flag] !== bypassRls : flags[flag],
    )
    .map(([flag, fix]) =>
      flag === 'rolbypassrls' && bypassRls ? 'BYPASSRLS' : fix,
    );
  if (forbidden.length > 0) {
    throw new Error(
      `Role "${app.role}" (DATABASE_URL) must not serve the app as it is: run \`ALTER ROLE ${role} ${forbidden.join(' ')}\` as a superuser, or give the app another role.`,
    );
  }
  if (!flags.rolcanlogin) {
    await client.query(`alter role ${role} login`);
    log(`Role "${app.role}" may log in now.`);
  }
  return false;
}

/** The schemas of the stores' migrations (migrate-all.ts runs their CLIs). */
const STORE_SCHEMAS = ['nest_outbox', 'nest_workflows', 'nest_webhooks'];

/**
 * The schemas the app uses, an explicit list: the ones its tables declare
 * (schema.ts; `public` unless a table names another through `pgSchema`) and
 * the stores', of those that exist. Not "every schema on the database": a
 * managed PostgreSQL has others (a provider's `auth` or `storage`, PostGIS's
 * `tiger`, an extension's), which the app never touches, whose owner isn't
 * ours (the GRANT would fail, or a superuser owner would hand the app
 * unrelated tables) and whose objects the ownership warning must not ask to
 * reassign. `drizzle` (the migration journal) stays the owner's alone. The
 * list comes from the code of this deploy, so a schema the migrations add
 * is covered the same deploy.
 */
async function applicationSchemas(client: ClientBase) {
  const declared = Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => getTableConfig(table).schema ?? 'public');
  const wanted = [...new Set(['public', ...declared, ...STORE_SCHEMAS])];
  const { rows } = await client.query<{ nspname: string }>(
    `select nspname from pg_namespace where nspname = any($1::text[]) order by nspname`,
    [wanted],
  );
  return rows.map((row) => row.nspname);
}

/**
 * Tables and sequences another role owns: the grants below still cover them
 * when the owner is a superuser, but ALTER DEFAULT PRIVILEGES won't, and
 * FORCE ROW LEVEL SECURITY applies to a table's owner. Say so.
 */
async function warnAboutForeignOwners(
  client: ClientBase,
  owner: string,
  schemas: string[],
  log: (line: string) => void,
) {
  const { rows } = await client.query<{ name: string; owner: string }>(
    `select n.nspname || '.' || c.relname as name, r.rolname as owner
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_roles r on r.oid = c.relowner
     where c.relkind in ('r', 'p', 'S', 'v', 'm')
       and n.nspname = any($1::text[])
       and r.rolname <> $2
     order by 1`,
    [schemas, owner],
  );
  if (rows.length > 0) {
    const owners = [...new Set(rows.map((row) => row.owner))];
    log(
      `Warning: ${rows.length} object(s) are not owned by "${owner}" (${rows
        .slice(0, 5)
        .map((row) => row.name)
        .join(', ')}${rows.length > 5 ? ', …' : ''}). Transfer them: ${owners
        .map(
          (previous) =>
            `REASSIGN OWNED BY ${escapeIdentifier(previous)} TO ${escapeIdentifier(owner)}`,
        )
        .join('; ')}.`,
    );
  }
}

/** CONNECT on the database, when the owner may grant it (PUBLIC has it by default anyway). */
async function grantConnect(
  client: ClientBase,
  app: Credentials,
  log: (line: string) => void,
) {
  try {
    await client.query('savepoint connect_grant');
    await client.query(
      `grant connect on database ${escapeIdentifier(app.database)} to ${escapeIdentifier(app.role)}`,
    );
    await client.query('release savepoint connect_grant');
  } catch (error) {
    if ((error as { code?: string }).code !== INSUFFICIENT_PRIVILEGE) {
      throw error;
    }
    await client.query('rollback to savepoint connect_grant');
    log(
      `Note: the owner may not grant CONNECT on "${app.database}" (not its owner); the app connects through PUBLIC's default CONNECT.`,
    );
  }
}

const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * What the app needs in one schema: usage, DML on every table, every
 * sequence (identity columns, the locks' fencing tokens), the same on what
 * the owner creates there later; and never CREATE.
 */
async function grantSchema(
  client: ClientBase,
  owner: string,
  app: string,
  schema: string,
) {
  const s = escapeIdentifier(schema);
  const role = escapeIdentifier(app);
  const forOwner = `alter default privileges for role ${escapeIdentifier(owner)} in schema ${s}`;
  for (const statement of [
    `grant usage on schema ${s} to ${role}`,
    `revoke create on schema ${s} from ${role}`,
    `grant select, insert, update, delete on all tables in schema ${s} to ${role}`,
    `grant usage, select on all sequences in schema ${s} to ${role}`,
    `${forOwner} grant select, insert, update, delete on tables to ${role}`,
    `${forOwner} grant usage, select on sequences to ${role}`,
  ]) {
    await client.query(statement);
  }
}

/**
 * The role fits before anything commits: it is a member of no other role, owns
 * nothing and can create nothing; every table and sequence is usable.
 *
 * Membership is the escalation the flags don't show: `GRANT owner TO app`
 * (or a predefined role, pg_read_server_files, pg_execute_server_program)
 * gives the app that role's rights, with INHERIT the table owner's: every row
 * past row-level security, and CREATE. So the role may be a member of
 * nothing. Its settings (`rolconfig`) aren't checked: a setting grants no
 * privilege (`row_security = off` makes a query RLS would filter fail, 42501,
 * rather than bypass it), and a deployment may well give the app role a
 * `statement_timeout` or `search_path` of its own.
 */
async function assertFit(client: ClientBase, app: string, schemas: string[]) {
  const problems: string[] = [];
  const memberships = await client.query<{ rolname: string }>(
    `select r.rolname from pg_auth_members m
     join pg_roles r on r.oid = m.roleid
     where m.member = $1::regrole
     order by 1`,
    [app],
  );
  if (memberships.rows.length > 0) {
    problems.push(
      `is a member of ${memberships.rows.map((row) => `"${row.rolname}"`).join(', ')} (their rights are its rights): run ${memberships.rows
        .map(
          (row) =>
            `REVOKE ${escapeIdentifier(row.rolname)} FROM ${escapeIdentifier(app)}`,
        )
        .join('; ')}`,
    );
  }
  const owned = await client.query<{ what: string; count: string }>(
    `select 'relation' as what, count(*)::text from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = $1
     union all
     select 'schema', count(*)::text from pg_namespace n join pg_roles r on r.oid = n.nspowner where r.rolname = $1
     union all
     select 'database', count(*)::text from pg_database d join pg_roles r on r.oid = d.datdba where r.rolname = $1`,
    [app],
  );
  for (const row of owned.rows) {
    if (row.count !== '0') {
      problems.push(`owns ${row.count} ${row.what}(s)`);
    }
  }
  // CREATE on a schema reaches the app through PUBLIC too: a database made
  // on PostgreSQL 14 or older (or upgraded from one) grants PUBLIC CREATE on
  // `public`, which no REVOKE from the app role undoes.
  const creates = await client.query<{ nspname: string; via_public: boolean }>(
    `select nspname,
            exists (select 1 from aclexplode(nspacl) acl
                    where acl.grantee = 0 and acl.privilege_type = 'CREATE') as via_public
     from pg_namespace
     where nspname = any($2::text[]) and has_schema_privilege($1, oid, 'CREATE')`,
    [app, schemas],
  );
  for (const row of creates.rows) {
    problems.push(
      row.via_public
        ? `may CREATE in schema "${row.nspname}" (PUBLIC has CREATE there): run REVOKE CREATE ON SCHEMA ${escapeIdentifier(row.nspname)} FROM PUBLIC`
        : `may CREATE in schema "${row.nspname}"`,
    );
  }
  const database = await client.query<{ create: boolean }>(
    `select has_database_privilege($1, current_database(), 'CREATE') as create`,
    [app],
  );
  if (database.rows[0]?.create) {
    problems.push('may CREATE (schemas) in the database');
  }
  // One privilege per call: has_table_privilege with a list is true when ANY
  // of them is held (SELECT alone passes 'SELECT, INSERT, UPDATE, DELETE').
  const unusable = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($2::text[])
       and ((c.relkind in ('r', 'p', 'v', 'm')
             and not (has_table_privilege($1, c.oid, 'SELECT')
                      and has_table_privilege($1, c.oid, 'INSERT')
                      and has_table_privilege($1, c.oid, 'UPDATE')
                      and has_table_privilege($1, c.oid, 'DELETE')))
         or (c.relkind = 'S' and not has_sequence_privilege($1, c.oid, 'USAGE')))
     order by 1`,
    [app, schemas],
  );
  if (unusable.rows.length > 0) {
    problems.push(
      `can't use ${unusable.rows.map((row) => row.name).join(', ')}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Role "${app}" is not fit for the app: ${problems.join('; ')}. Nothing was changed.`,
    );
  }
}

/**
 * Connects as the app once, as api and worker will. A password that fails is
 * set from the URL (a new role, a rotated POSTGRES_APP_PASSWORD) and tried
 * again. Returns whether it was set.
 */
async function ensurePassword(
  owner: ClientBase,
  app: Credentials,
  appUrl: string,
  created: boolean,
) {
  if (created || !(await canConnect(appUrl))) {
    if (!created) {
      await owner.query(
        `alter role ${escapeIdentifier(app.role)} password ${escapeLiteral(scramSha256Verifier(app.password))}`,
      );
    }
    if (!(await canConnect(appUrl))) {
      throw new Error(
        `Role "${app.role}" can't connect with DATABASE_URL's password even after setting it: check pg_hba.conf (scram-sha-256) and the URL.`,
      );
    }
    return !created;
  }
  return false;
}

async function canConnect(url: string) {
  const client = new Client({
    connectionString: url,
    application_name: 'migrate:roles',
  });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === INVALID_PASSWORD) {
      return false;
    }
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const INVALID_PASSWORD = '28P01';

/**
 * A SCRAM-SHA-256 verifier for `password`, the form `CREATE ROLE … PASSWORD`
 * stores (RFC 7677: 4096 iterations, a random salt, the stored and server
 * keys), computed here so the password itself never goes to the server.
 * PostgreSQL normalizes passwords with SASLprep first, which changes only
 * non-ASCII characters: keep passwords ASCII (`openssl rand -hex 24`).
 * `salt` is random; the unit test passes RFC 7677's.
 */
export function scramSha256Verifier(password: string, salt = randomBytes(16)) {
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The tables of the schema that declare row-level security (`.enableRLS()`): the tenant tables. */
function rowSecuredTables(extraTables: Record<string, unknown> = {}) {
  return [...Object.values(schema), ...Object.values(extraTables)]
    .filter((value) => is(value, PgTable))
    .map((table) => getTableConfig(table))
    .filter((config) => config.enableRLS)
    .map((config) => ({
      schema: config.schema ?? 'public',
      name: config.name,
    }));
}

/**
 * `FORCE ROW LEVEL SECURITY` on every tenant table, so the policies bind
 * the tables' owner too (a migration, a fixture run as the owner): what
 * drizzle-kit can't emit (it writes `ENABLE`, from `.enableRLS()` and the
 * policies), done here as code, idempotently: only a table not forced yet
 * is altered (an ALTER TABLE takes its strongest lock).
 */
async function forceRowLevelSecurity(
  client: ClientBase,
  log: (line: string) => void,
  extraTables: Record<string, unknown>,
) {
  for (const table of rowSecuredTables(extraTables)) {
    const { rows } = await client.query<{ forced: boolean }>(
      `select c.relforcerowsecurity as forced
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2`,
      [table.schema, table.name],
    );
    if (rows[0] && !rows[0].forced) {
      await client.query(
        `alter table ${escapeIdentifier(table.schema)}.${escapeIdentifier(table.name)} force row level security`,
      );
      log(`Row-level security forced on ${table.name}.`);
    }
  }
}

/**
 * The tenant wall holds before anything commits: every table with a
 * `tenant_id` column has row-level security enabled and forced, and exactly
 * the policies its declaration makes (`tenantTable()`, or the default four
 * for a table that declares none), each one as declared: its command,
 * permissive, its roles, and its `USING` and `WITH CHECK` expressions; with
 * no other permissive policy (docs/tenancy.md). Except the few global
 * tables that only record which tenant a row belongs to
 * (GLOBAL_TABLES_WITH_TENANT: memberships, API keys). A table someone added
 * without `tenantTable()` and `.enableRLS()`, or a policy edited by hand
 * (`ALTER POLICY … USING (true)`), stops the deploy here.
 *
 * The expressions are compared in PostgreSQL's own normalized form, not as
 * source text: the declared policies are created again, as drizzle-kit
 * renders them, on empty temporary copies of the tables (same names, so
 * the column references deparse the same), inside a savepoint that is
 * rolled back; then `pg_get_expr()` of each declared policy is compared
 * with the live one's. Spacing, parentheses and casts the server adds
 * can't fail the check; a different expression can. Custom: drizzle-kit
 * diffs policies against its snapshot, not against the database.
 */
async function assertTenantWall(
  client: ClientBase,
  extraTables: Record<string, unknown>,
) {
  const { rows } = await client.query<{
    name: string;
    enabled: boolean;
    forced: boolean;
  }>(
    `select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     order by 1`,
  );
  const walled = rows.filter(
    (row) => !GLOBAL_TABLES_WITH_TENANT.includes(row.name),
  );
  const declared = declaredPolicies(extraTables);
  // A table that declares no policy (no `tenantTable()`) is held to the
  // default four: what it should have carried.
  const expected = new Map(
    walled.map((row) => {
      const own = declared.get(row.name);
      return [
        row.name,
        own?.length ? own : defaultTenantPolicies(row.name),
      ] as const;
    }),
  );
  const live = await policiesIn(client, `'public'::regnamespace`);
  const wanted = await probePolicies(client, expected);
  const problems = walled.flatMap((row) => {
    const found = live.get(row.name) ?? new Map<string, LivePolicy>();
    const want = wanted.get(row.name) ?? new Map<string, LivePolicy>();
    const wrong = [
      !row.enabled && 'row-level security off',
      !row.forced && 'not forced',
      ...[...want.values()].flatMap((policy) => {
        const actual = found.get(policy.name);
        if (!actual) {
          return [`missing policy ${policy.name}`];
        }
        const differs = POLICY_PARTS.filter(
          (part) =>
            JSON.stringify(actual[part]) !== JSON.stringify(policy[part]),
        );
        return differs.length
          ? [
              `policy ${policy.name} differs from its declaration (${differs.join(', ')})`,
            ]
          : [];
      }),
      ...[...found.values()]
        .filter((policy) => policy.permissive && !want.has(policy.name))
        .map((policy) => `unexpected permissive policy ${policy.name}`),
    ].filter(Boolean);
    return wrong.length ? [`${row.name} (${wrong.join(', ')})`] : [];
  });
  if (problems.length > 0) {
    throw new Error(
      `Tenant tables without their wall: ${problems.join('; ')}. Declare them with tenantTable() and .enableRLS(), and change a policy only there (pnpm db:generate), never by hand (docs/tenancy.md).`,
    );
  }
}

/** A policy as PostgreSQL holds it (pg_policy), expressions deparsed. */
type LivePolicy = {
  name: string;
  /** pg_policy.polcmd: r select, a insert, w update, d delete, * all. */
  command: string;
  permissive: boolean;
  /** Role names, sorted; `public` for PUBLIC. */
  roles: string[];
  using: string | null;
  withCheck: string | null;
};

/** What must match between a live policy and its declaration, as the error names it. */
const POLICY_PARTS = [
  'command',
  'permissive',
  'roles',
  'using',
  'withCheck',
] as const;

/** Every policy of the tables in `namespace` (an SQL expression), by table, then by name. */
async function policiesIn(client: ClientBase, namespace: string) {
  const { rows } = await client.query<LivePolicy & { table: string }>(
    `select c.relname as table, p.polname as name, p.polcmd as command, p.polpermissive as permissive,
            array(select case when r = 0 then 'public' else pg_get_userbyid(r)::text end
                  from unnest(p.polroles) r order by 1) as roles,
            pg_get_expr(p.polqual, p.polrelid) as using,
            pg_get_expr(p.polwithcheck, p.polrelid) as "withCheck"
     from pg_policy p join pg_class c on c.oid = p.polrelid
     where c.relnamespace = ${namespace}`,
  );
  const byTable = new Map<string, Map<string, LivePolicy>>();
  for (const { table, ...policy } of rows) {
    const policies = byTable.get(table) ?? new Map<string, LivePolicy>();
    policies.set(policy.name, policy);
    byTable.set(table, policies);
  }
  return byTable;
}

/**
 * The declared policies as PostgreSQL normalizes them: created on empty
 * temporary copies of the tables (`pg_temp.<name>`, so `"<name>"."tenant_id"`
 * resolves and deparses as on the real table), read back, and rolled back.
 * Temporary tables take no lock on the real ones.
 */
async function probePolicies(
  client: ClientBase,
  expected: Map<string, readonly PgPolicy[]>,
) {
  const dialect = new PgDialect();
  const render = (policy: PgPolicy, expression: SQL | undefined) => {
    if (!expression) {
      return undefined;
    }
    const query = dialect.sqlToQuery(expression);
    if (query.params.length > 0) {
      throw new Error(
        `Policy ${policy.name} has bound parameters: a policy's expression is literal SQL.`,
      );
    }
    return query.sql;
  };
  await client.query('savepoint tenant_wall_probe');
  try {
    for (const [table, policies] of expected) {
      const name = escapeIdentifier(table);
      await client.query(
        `create temporary table pg_temp.${name} (like public.${name})`,
      );
      for (const policy of policies) {
        const using = render(policy, policy.using);
        const withCheck = render(policy, policy.withCheck);
        await client.query(
          `create policy ${escapeIdentifier(policy.name)} on pg_temp.${name}
             as ${policy.as ?? 'permissive'} for ${policy.for ?? 'all'} to ${policyRoles(policy.to)}
             ${using === undefined ? '' : `using (${using})`}
             ${withCheck === undefined ? '' : `with check (${withCheck})`}`,
        );
      }
    }
    return await policiesIn(client, 'pg_my_temp_schema()');
  } finally {
    await client.query('rollback to savepoint tenant_wall_probe');
  }
}

/** A policy's `TO`, as drizzle-kit writes it (PUBLIC when none). */
function policyRoles(to: PgPolicy['to']): string {
  const keywords = ['public', 'current_role', 'current_user', 'session_user'];
  const names = (Array.isArray(to) ? to : to === undefined ? [] : [to]).map(
    (role) => (is(role, PgRole) ? role.name : (role as string)),
  );
  return names.length === 0
    ? 'public'
    : names
        .map((role) =>
          keywords.includes(role) ? role : escapeIdentifier(role),
        )
        .join(', ');
}

/** The policies each table of the schema (and `extraTables`) declares, by table name. */
function declaredPolicies(extraTables: Record<string, unknown>) {
  return new Map(
    [...Object.values(schema), ...Object.values(extraTables)]
      .filter((value) => is(value, PgTable))
      .map((table) => getTableConfig(table))
      .filter((config) => (config.schema ?? 'public') === 'public')
      .map((config) => [config.name, config.policies] as const),
  );
}

/**
 * The four policies `tenantTable()` declares by default, for a table with a
 * `tenant_id` the schema doesn't declare: what it should have carried.
 */
function defaultTenantPolicies(table: string) {
  return getTableConfig(
    pgTable(table, { tenantId: uuid('tenant_id') }, (t) =>
      tenantPolicies(table, t.tenantId),
    ),
  ).policies;
}
