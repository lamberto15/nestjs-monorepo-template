-- Marks the development services' database as a development database: the
-- demo seed (pnpm db:seed:demo) runs only on one (apps/api/src/demo/demo-guard.ts).
-- A database-wide setting, which only a superuser can write: the app's role
-- can't, and no production database ever gets it. Run by PostgreSQL's image
-- when it creates the database (a new volume), and by `pnpm db:mark-dev` for
-- a database made before. Not a migration: production must never run it.
select format('alter database %I set app.dev_database = %L', current_database(), 'on')
\gexec
