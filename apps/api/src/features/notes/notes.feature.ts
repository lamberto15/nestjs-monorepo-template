import { defineFeature } from '../feature.js';
import { EXAMPLE_SENDER } from './example-sender-webhook.controller.js';
import { NOTE_PUBLISH_APPROVAL } from './note-approvals.js';
import { NOTE_EVENT_TYPES } from './note-events.js';
import { NOTE_NOTIFICATIONS } from './note-notifications.js';
import { NOTE_SETTINGS } from './note-settings.js';
import { NOTE_PERMISSIONS } from './note.policy.js';
import { NOTE, NOTE_CUSTOM_FIELDS } from './note.resource.js';
import { NotesModule } from './notes.module.js';

/** The example feature, as the groups take it (features/index.ts). */
export const NOTES_FEATURE = defineFeature({
  module: NotesModule,
  apiTag: {
    name: 'notes',
    description: 'The example feature: replace it with yours',
  },
  permissions: NOTE_PERMISSIONS,
  resources: [NOTE],
  eventTypes: NOTE_EVENT_TYPES,
  incomingWebhooks: [EXAMPLE_SENDER],
  customFields: [NOTE_CUSTOM_FIELDS],
  notifications: NOTE_NOTIFICATIONS,
  settings: NOTE_SETTINGS,
  // Actions that need approval: docs/approvals.md.
  approvals: [NOTE_PUBLISH_APPROVAL],
});
