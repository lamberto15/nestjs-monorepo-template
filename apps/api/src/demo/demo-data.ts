/**
 * What the demo seed creates (DemoSeeder): a tenant of its own, a small
 * company with two teams, its administrator and people in the template's
 * seed roles (iam/access/seed-roles.ts). The features add their own data
 * (`FeatureDefinition.demo`), owned by these people by their key; the
 * database gives the ids.
 */

/**
 * The demo's tenant: never the operators' (the first start's), except with
 * TENANCY=single, where the seed fills the one tenant there is.
 */
export const DEMO_TENANT = { name: 'Demo Company', slug: 'demo' };

/** The demo users' addresses: example.com is reserved, nothing is ever delivered. */
export const DEMO_EMAIL_DOMAIN = 'demo.example.com';

export interface DemoTeam {
  key: string;
  name: string;
  /** The parent's key. */
  parent?: string;
}

export interface DemoUser {
  key: string;
  name: string;
  /**
   * Seeded roles' keys (`roles.key`). `administrator` makes the demo
   * tenant's administrator (of that tenant only, no operator).
   */
  roles: string[];
  /** Teams' keys. */
  teams: string[];
}

export const DEMO_TEAMS: DemoTeam[] = [
  { key: 'sales', name: 'Sales' },
  { key: 'sales-north', name: 'Sales North', parent: 'sales' },
  { key: 'engineering', name: 'Engineering' },
];

export const DEMO_USERS: DemoUser[] = [
  // Runs the demo tenant: its members, roles, teams, tags, audit log.
  {
    key: 'noah',
    name: 'Noah Fischer',
    roles: ['administrator'],
    teams: [],
  },
  // Team leads see the notes of their team and every team below it.
  {
    key: 'maya',
    name: 'Maya Patel',
    roles: ['editor', 'team-lead'],
    teams: ['sales'],
  },
  {
    key: 'lucas',
    name: 'Lucas Moreau',
    roles: ['editor', 'team-lead'],
    teams: ['engineering'],
  },
  // Editors see their own notes.
  {
    key: 'jonas',
    name: 'Jonas Berg',
    roles: ['editor'],
    teams: ['sales-north'],
  },
  {
    key: 'amara',
    name: 'Amara Okafor',
    roles: ['editor'],
    teams: ['sales-north'],
  },
  {
    key: 'sofia',
    name: 'Sofia Rossi',
    roles: ['editor'],
    teams: ['engineering'],
  },
  // A viewer sees every note and the operations API, and changes nothing.
  { key: 'elena', name: 'Elena Novak', roles: ['viewer'], teams: [] },
];
