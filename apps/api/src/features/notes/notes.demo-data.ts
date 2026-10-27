/**
 * Notes' demo data (NotesDemo): tags and notes owned by the demo users
 * (src/demo/demo-data.ts, by their key). Change it, or give your feature
 * its own (`FeatureDefinition.demo`).
 */

export interface DemoTag {
  key: string;
  name: string;
  color: string;
}

export interface DemoNote {
  /** The owner's key. */
  owner: string;
  title: string;
  body: string;
  /** Tags' keys. */
  tags: string[];
  /** Comments, by the seed (`system:demo-seed`); `@<user key>` becomes a mention of that user. */
  comments?: string[];
  /** A small text file attached to the note. */
  file?: { name: string; text: string };
}

export const DEMO_TAGS: DemoTag[] = [
  { key: 'customer', name: 'Customer', color: '#3b82f6' },
  { key: 'urgent', name: 'Urgent', color: '#ef4444' },
  { key: 'idea', name: 'Idea', color: '#22c55e' },
  { key: 'internal', name: 'Internal', color: '#6b7280' },
];

export const DEMO_NOTES: DemoNote[] = [
  {
    owner: 'jonas',
    title: 'Call notes: Northwind renewal',
    body: 'Northwind wants a two-year renewal with a 5% discount, and the SSO add-on in the same contract. Next step: send them the draft by Friday.',
    tags: ['customer', 'urgent'],
    comments: [
      'Seeded comment: @maya is mentioned here, so she has a notification (GET /v1/notifications), and Jonas, who watches his note, has one too.',
    ],
    file: {
      name: 'northwind-call.txt',
      text: 'Attendees: Jonas Berg (us), Kim Larsen (Northwind)\n- Two-year renewal, 5% discount asked\n- SSO add-on in the same contract\n- Draft by Friday\n',
    },
  },
  {
    owner: 'jonas',
    title: 'Pricing questions from Contoso',
    body: 'Contoso asks whether the per-seat price drops above 200 seats, and whether unused seats carry over to the next year.',
    tags: ['customer'],
  },
  {
    owner: 'amara',
    title: 'Trade fair leads',
    body: 'Twelve leads from the Hamburg fair, three of them warm. Sorting them by region before handing them over.',
    tags: ['customer', 'idea'],
  },
  {
    owner: 'maya',
    title: 'Q3 targets for Sales',
    body: 'Renewals first: Northwind, Contoso and Fabrikam make up 40% of the quarter. The new-business target stays at 15 accounts.',
    tags: ['internal'],
  },
  {
    owner: 'lucas',
    title: 'Release checklist',
    body: 'Freeze on Wednesday, staging on Thursday, production on Monday morning. Migrations must be expand-only this time.',
    tags: ['internal'],
  },
  {
    owner: 'sofia',
    title: 'Flaky sign-in test',
    body: 'The magic-link test fails about once in twenty runs on CI. Suspect: the mail arrives after the assertion.',
    tags: ['urgent', 'internal'],
    comments: [
      'Seeded comment: @lucas, a unit lead, can read this note (it belongs to his unit), so the mention reached him.',
    ],
  },
  {
    owner: 'sofia',
    title: 'Idea: notes as PDF',
    body: 'Customers paste notes into emails. A PDF of a note with its tags would save them the step.',
    tags: ['idea'],
  },
];
