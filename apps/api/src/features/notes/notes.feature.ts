import { defineFeature } from '../feature.js';
import { EXAMPLE_SENDER } from './example-sender-webhook.controller.js';
import { NOTE_PUBLISH_APPROVAL } from './note-approvals.js';
import { NOTE_EVENTS } from './note-events.js';
import { NOTE_SETTINGS } from './note-settings.js';
import { NOTE_PERMISSIONS } from './note.policy.js';
import { NOTE, NOTE_CUSTOM_FIELDS } from './note.resource.js';
import { NotesModule } from './notes.module.js';
import { NotesDemo } from './notes.demo.js';

/** The example feature, as the groups take it (features/index.ts). */
export const NOTES_FEATURE = defineFeature({
  module: NotesModule,
  apiTag: {
    name: 'notes',
    description: 'The example feature: replace it with yours',
  },
  permissions: NOTE_PERMISSIONS,
  resources: [NOTE],
  // Webhook types and notifications, declared once: note-events.ts.
  events: NOTE_EVENTS,
  incomingWebhooks: [EXAMPLE_SENDER],
  customFields: [NOTE_CUSTOM_FIELDS],
  settings: NOTE_SETTINGS,
  // Actions that need approval: docs/approvals.md.
  approvals: [NOTE_PUBLISH_APPROVAL],
  // Its demo data (pnpm db:seed:demo): tags, notes, comments, a file.
  demo: {
    seeder: NotesDemo,
    permissions: [
      { subject: 'Access', action: 'manageTags', conditions: [] },
      { subject: 'Note', action: 'create', conditions: [] },
      { subject: 'Note', action: 'read', conditions: [] },
      { subject: 'Note', action: 'update', conditions: [] },
    ],
  },
});
