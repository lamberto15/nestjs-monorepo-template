import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
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
  const client = new Client({
    connectionString: urls.ownerUrl,
    application_name: 'migrate:roles',
  });
  await client.connect();
  let created = false;
  try {
    await client.query('begin');
    // One bootstrap at a time (two deploys, or a deploy and a developer).
    await client.query(
      `select pg_advisory_xact_lock(hashtext('nestjs-monorepo-template:app-role'))`,
    );
    created = await ensureRole(client, app, log);
    const schemas = await applicationSchemas(client);
    await warnAboutForeignOwners(client, owner.role, schemas, log);
    await grantConnect(client, app, log);
    for (const schema of schemas) {
      await grantSchema(client, owner.role, app.role, schema);
    }
    await assertFit(client, app.role, schemas);
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
    log(
      `App role "${app.role}" ${created ? 'created' : 'checked'}${passwordSet ? ', password set' : ''}: no superuser, no RLS bypass, owns nothing.`,
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
  ownerUrl: string,
  monitor: MonitorRole,
  log: (line: string) => void = () => {},
) {
  const owner = credentials(ownerUrl, 'DATABASE_OWNER_URL');
  if (!monitor.role || !monitor.password) {
    throw new Error(
      'POSTGRES_MONITOR_USER and POSTGRES_MONITOR_PASSWORD (or its _FILE) are both required for the monitoring role.',
    );
  }
  if (monitor.role === owner.role) {
    throw new Error(
      `POSTGRES_MONITOR_USER names the owner ("${owner.role}"): the exporter must connect as a role of its own, with pg_monitor only.`,
    );
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
    await client.query(
      `create role ${role} login nosuperuser nobypassrls nocreatedb nocreaterole noreplication inherit password ${escapeLiteral(scramSha256Verifier(app.password))}`,
    );
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
    .filter(([flag]) => flags[flag])
    .map(([, fix]) => fix);
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
