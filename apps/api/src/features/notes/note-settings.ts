import { z } from 'zod';
import {
  defineSettings,
  flag,
  setting,
} from '../../platform/settings/setting.types.js';

/** A duration as the workflows take it: `10s`, `5m`, `2h`, `1d`. */
const duration = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/, 'a duration: 10s, 5m, 2h, 1d')
  .meta({ example: '10s' });

/** How long a new note waits before it is published; NOTE_PUBLISH_DELAY is the default. */
export const NOTE_PUBLISH_DELAY = setting({
  key: 'notes.publishDelay',
  label: 'Publication delay',
  description:
    'How long a new note waits before it is published, unless published early: a duration (10s, 5m, 2h, 1d).',
  schema: duration,
  // NOTE_PUBLISH_DELAY (notes.env.ts) is the default; the setting changes it at runtime.
  default: process.env.NOTE_PUBLISH_DELAY ?? '10s',
});

/** Whether the web app offers the rich text editor for note bodies. */
export const NOTE_RICH_TEXT = flag({
  key: 'notes.richText',
  label: 'Rich text editor',
  description: 'Lets the web app offer the rich text editor for note bodies.',
  default: false,
});

/**
 * Whether publishing a note needs an editor's approval (note-approvals.ts):
 * off by default; on for the whole tenant, an org unit, or a rollout.
 */
export const NOTE_PUBLISH_APPROVAL_FLAG = flag({
  // Never per user: a requester could switch their own approval off
  // (ApprovalsRegistry refuses such a setting at startup).
  scopes: ['tenant', 'orgUnit'],
  key: 'notes.publishApproval',
  label: 'Publishing needs approval',
  description:
    'When on, a note is published only once an editor approved it (GET /v1/approvals); the policy: GET /v1/approvals/policies/Note.publish.',
  default: false,
});

/** The notes feature's settings and flags, handed to the platform in app.module.ts. */
export const NOTE_SETTINGS = defineSettings([
  NOTE_PUBLISH_DELAY,
  NOTE_RICH_TEXT,
  NOTE_PUBLISH_APPROVAL_FLAG,
]);
