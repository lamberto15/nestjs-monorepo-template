-- pg_trgm: GIN trigram indexes for the lists' ILIKE filters (contains,
-- startsWith, endsWith). drizzle-kit can't emit CREATE EXTENSION, hence a
-- custom migration (drizzle-kit generate --custom). A trusted extension
-- (PostgreSQL 13+): the database's owner creates it without superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
