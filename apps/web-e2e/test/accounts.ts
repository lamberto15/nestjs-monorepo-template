import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The demo seed's accounts (scripts/api.mjs keeps what it printed): one per
 * role the tests need, by the seed role that makes it unique.
 */
export type Role = 'administrator' | 'editor' | 'viewer' | 'unit-lead';

const file = resolve(
  import.meta.dirname,
  '..',
  process.env.E2E_CREDENTIALS ?? 'playwright/.auth/credentials.json',
);

interface Account {
  email: string;
  password: string;
  roles: string[];
}

/** The first account holding a seed role (the editor and the viewer: only that). */
export function account(role: Role): Account {
  const accounts = JSON.parse(readFileSync(file, 'utf8')) as Account[];
  const name = role[0].toUpperCase() + role.slice(1).replace('-', ' ');
  // The administrator and the unit leads are editors too.
  const found = accounts.find((candidate) =>
    role === 'editor' || role === 'viewer'
      ? candidate.roles.length === 1 && candidate.roles[0] === name
      : candidate.roles.includes(name),
  );
  if (!found) {
    throw new Error(`No ${role} among the accounts in ${file}`);
  }
  return found;
}

/** Where a role's signed-in browser state is kept (test/auth.setup.ts). */
export const stateFile = (role: Role) =>
  resolve(import.meta.dirname, '..', `playwright/.auth/${role}.json`);
