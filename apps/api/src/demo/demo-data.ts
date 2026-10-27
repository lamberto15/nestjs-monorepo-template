import type { UnitType } from '../iam/iam.tables.js';

/**
 * What the demo seed creates (DemoSeeder): a tenant of its own, a small
 * company with three organizational units, its administrator and people in the template's
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

export interface DemoUnit {
  key: string;
  type: UnitType;
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
  /** Units' keys: those they are a member of. */
  units: string[];
  /** Those of `units` they lead. */
  leads?: string[];
}

export const DEMO_UNITS: DemoUnit[] = [
  { key: 'sales', type: 'division', name: 'Sales' },
  { key: 'sales-north', type: 'team', name: 'Sales North', parent: 'sales' },
  { key: 'engineering', type: 'department', name: 'Engineering' },
];

export const DEMO_USERS: DemoUser[] = [
  // Runs the demo tenant: its members, roles, units, tags, audit log. An
  // editor too, so an approver of the notes' publication (Note.publish
  // routes to editors): the account the demo is tried with approves what
  // the editors ask for (docs/approvals.md, "The notes example").
  {
    key: 'noah',
    name: 'Noah Fischer',
    roles: ['administrator', 'editor'],
    units: [],
  },
  // Unit leads see the notes of the units they lead and every unit below.
  {
    key: 'maya',
    name: 'Maya Patel',
    roles: ['editor', 'unit-lead'],
    units: ['sales'],
    leads: ['sales'],
  },
  {
    key: 'lucas',
    name: 'Lucas Moreau',
    roles: ['editor', 'unit-lead'],
    units: ['engineering'],
    leads: ['engineering'],
  },
  // Editors see their own notes.
  {
    key: 'jonas',
    name: 'Jonas Berg',
    roles: ['editor'],
    units: ['sales-north'],
  },
  {
    key: 'amara',
    name: 'Amara Okafor',
    roles: ['editor'],
    units: ['sales-north'],
  },
  {
    key: 'sofia',
    name: 'Sofia Rossi',
    roles: ['editor'],
    units: ['engineering'],
  },
  // A viewer sees every note and the operations API, and changes nothing.
  { key: 'elena', name: 'Elena Novak', roles: ['viewer'], units: [] },
];
