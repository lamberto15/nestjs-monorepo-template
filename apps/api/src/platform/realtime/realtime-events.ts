import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import {
  notificationSchema,
  unreadCountSchema,
} from '../notifications/notification.schemas.js';

/**
 * The realtime manifest: every event the API pushes on `/realtime`, with its
 * payload. One declaration, three readers: `Realtime.toPrincipal()` types its
 * payload from it, the OpenAPI document publishes it as `x-realtime-events`
 * (`addRealtimeEvents`, so `client:check` diffs it and oasdiff sees a
 * breaking change), and the typed client's `src/realtime-events.ts` is
 * generated from that (`pnpm client:generate`).
 *
 * A new event is added here, with its payload schema; `pnpm client:generate`
 * then updates the client. Names and payloads of existing events are the
 * contract of the web app and of API clients: change them like a route's
 * response.
 *
 * Custom code, not a library's: @nestjs/websockets and socket.io have no
 * event declaration, and @nestjs/swagger has no way to describe
 * server-pushed events (an `x-` extension is OpenAPI's way to carry it).
 */
export const defineRealtimeEvent = <S extends z.ZodType>(
  id: string,
  description: string,
  payload: S,
) => ({ description, payload: payload.meta({ id }) });
const event = defineRealtimeEvent;

/** An event as the manifest holds it: what the document shows and the payload's schema. */
export type RealtimeEventDeclaration = ReturnType<typeof defineRealtimeEvent>;

/**
 * The events a feature pushes (`Realtime.toPrincipal(principal, 'thumbnail.ready', …)`),
 * by name, handed to the platform in the feature's declaration
 * (`realtimeEvents` of `defineFeature`). Each is declared with
 * `defineRealtimeEvent(id, description, schema)`: `id` names the payload's
 * OpenAPI component (`Realtime…Event`, unique). Names must not repeat a
 * platform event's.
 */
const defineRealtimeEvents = <
  const T extends Record<string, RealtimeEventDeclaration>,
>(
  events: T,
) => events;

const exportOrImport = z.enum(['export', 'import']);
const approvalStatus = z.enum([
  'pending',
  'approved',
  'rejected',
  'changes_requested',
  'cancelled',
  'expired',
  'failed',
]);
const subjectRecord = { subject: z.string(), recordId: z.string() };

export const REALTIME_EVENTS = {
  notification: event(
    'RealtimeNotificationEvent',
    "A new notification, in the recipient's language.",
    notificationSchema,
  ),
  'notification.read': event(
    'RealtimeNotificationReadEvent',
    'A notification was marked read (or unread: `readAt` null).',
    z.object({ id: z.string(), readAt: z.string().nullable() }),
  ),
  'notifications.read-all': event(
    'RealtimeNotificationsReadAllEvent',
    '`before`: what the call passed (null: all of them); `updated`: how many changed.',
    z.object({ before: z.string().nullable(), updated: z.int() }),
  ),
  'notification.removed': event(
    'RealtimeNotificationRemovedEvent',
    'A notification was removed.',
    z.object({ id: z.string() }),
  ),
  'notifications.unread-count': event(
    'RealtimeNotificationsUnreadCountEvent',
    "After each of the above and each delivery: the badge's number.",
    unreadCountSchema,
  ),
  'data.export-ready': event(
    'RealtimeDataExportReadyEvent',
    'An export is ready: `url` is a signed link to the file.',
    z.object({
      id: z.string(),
      name: z.string(),
      rows: z.int(),
      url: z.string(),
    }),
  ),
  'data.import-finished': event(
    'RealtimeDataImportFinishedEvent',
    'An import ended: how many rows were imported and how many refused.',
    z.object({
      id: z.string(),
      name: z.string(),
      rows: z.int(),
      imported: z.int(),
      failed: z.int(),
    }),
  ),
  'data.progress': event(
    'RealtimeDataProgressEvent',
    'An export or import is running: `processed` rows so far (an import also `imported` and `failed`). Throttled (an export: at most once a second; an import: every 500 rows); `GET /v1/data/transfers/{id}` has the same numbers.',
    z.object({
      id: z.string(),
      name: z.string(),
      kind: exportOrImport,
      processed: z.int(),
      imported: z.int().optional(),
      failed: z.int().optional(),
    }),
  ),
  'data.failed': event(
    'RealtimeDataFailedEvent',
    'An export or import failed for good (not a few refused rows: that is `data.import-finished`); `error` says why, for people. The transfer reads `failed` at `GET /v1/data/transfers/{id}` by now.',
    z.object({
      id: z.string(),
      name: z.string(),
      kind: exportOrImport,
      error: z.string(),
    }),
  ),
  'approval.assigned': event(
    'RealtimeApprovalAssignedEvent',
    'An approval request waits for you (or for someone you stand in for): `GET /v1/approvals/{id}`.',
    z.object({
      id: z.string(),
      ...subjectRecord,
      action: z.string(),
      stage: z.int(),
    }),
  ),
  'approval.decided': event(
    'RealtimeApprovalDecidedEvent',
    "A decision on a request you made or decide, or its end: `status` is the request's after it (pending while stages remain); `decision` null when no person decided (cancelled, expired, failed).",
    z.object({
      id: z.string(),
      status: approvalStatus,
      round: z.int(),
      stage: z.int(),
      decision: z
        .enum(['approved', 'rejected', 'changes_requested'])
        .nullable(),
    }),
  ),
  'approval.applied': event(
    'RealtimeApprovalAppliedEvent',
    'An approved request\'s outcome was applied (the note is published, say): `outcomeAppliedAt` is now set on `GET /v1/approvals/{id}`. To the requester and the approvers of the round, once; a banner showing "approved, applying" can clear without polling.',
    z.object({
      id: z.string(),
      ...subjectRecord,
      outcomeAppliedAt: z.string(),
    }),
  ),
  'bulk.finished': event(
    'RealtimeBulkFinishedEvent',
    'A queued bulk operation ended; its item results: `GET /v1/bulk/{id}`.',
    z.object({
      id: z.string(),
      name: z.string(),
      action: z.string(),
      done: z.int(),
      failed: z.int(),
    }),
  ),
  'bulk.progress': event(
    'RealtimeBulkProgressEvent',
    'A queued bulk run is running: items processed so far, every few hundred items.',
    z.object({
      id: z.string(),
      name: z.string(),
      action: z.string(),
      processed: z.int(),
      done: z.int(),
      failed: z.int(),
    }),
  ),
  'bulk.failed': event(
    'RealtimeBulkFailedEvent',
    'A queued bulk run failed for good (its worker was lost, say); items done stay done (`GET /v1/bulk/{id}`, the audit log). `error` says why, for people.',
    z.object({
      id: z.string(),
      name: z.string(),
      action: z.string(),
      error: z.string(),
    }),
  ),
  'document.ready': event(
    'RealtimeDocumentReadyEvent',
    "A document you asked for (`POST /v1/notes/{id}/pdf`) was issued: the PDF is the record's attachment `attachmentId`.",
    z.object({
      id: z.string(),
      ...subjectRecord,
      attachmentId: z.string(),
    }),
  ),
  'document.failed': event(
    'RealtimeDocumentFailedEvent',
    'A document you asked for failed for good; `error` says why, for people.',
    z.object({
      id: z.string(),
      ...subjectRecord,
      error: z.string(),
    }),
  ),
  'ai.ready': event(
    'RealtimeAiReadyEvent',
    'An AI run you asked for (`POST /v1/ai/runs`) finished: read the answer at `GET /v1/ai/runs/{id}`.',
    z.object({
      id: z.string(),
      ...subjectRecord,
      task: z.string(),
    }),
  ),
  'ai.failed': event(
    'RealtimeAiFailedEvent',
    'An AI run you asked for failed for good; `error` says why, for people.',
    z.object({
      id: z.string(),
      ...subjectRecord,
      error: z.string(),
    }),
  ),
  'record.commented': event(
    'RealtimeRecordCommentedEvent',
    'A comment on a record you watch (or one you wrote, for your other tabs) was added, edited or removed: ids only, fetch the thread.',
    z.object({
      ...subjectRecord,
      commentId: z.string(),
      action: z.enum(['added', 'edited', 'removed']),
    }),
  ),
  'record.attachments.changed': event(
    'RealtimeRecordAttachmentsChangedEvent',
    'A file on a record you watch was uploaded, removed or issued (a PDF): ids only.',
    z.object({
      ...subjectRecord,
      attachmentId: z.string(),
      action: z.enum(['added', 'removed']),
    }),
  ),
} as const;

export type RealtimeEventName = keyof typeof REALTIME_EVENTS;
/** The payload of a declared event. */
export type RealtimeEventPayload<E extends RealtimeEventName> = z.infer<
  (typeof REALTIME_EVENTS)[E]['payload']
>;

/** The platform's events and a deployment's (the features'), refusing a repeated name. */
export function allRealtimeEvents(
  extra: Record<string, RealtimeEventDeclaration> = {},
): Record<string, RealtimeEventDeclaration> {
  for (const name of Object.keys(extra)) {
    if (name in REALTIME_EVENTS) {
      throw new Error(`Realtime event "${name}" is already a platform event.`);
    }
  }
  return { ...REALTIME_EVENTS, ...extra };
}

/**
 * Whether a payload fits the event's declaration: `true` for an event the
 * manifest has and a payload that parses, and the reason otherwise.
 */
export function checkRealtimePayload(
  events: Record<string, RealtimeEventDeclaration>,
  event: string,
  data: unknown,
): string | undefined {
  const declared = events[event];
  if (!declared) {
    return `Realtime event "${event}" is not declared: add it to the manifest (platform/realtime/realtime-events.ts, or \`realtimeEvents\` in the feature).`;
  }
  const result = declared.payload.safeParse(data);
  return result.success
    ? undefined
    : `Realtime event "${event}" payload: ${z.prettifyError(result.error)}`;
}

/**
 * Publishes the manifest in the OpenAPI document: each payload as a named
 * component (`Realtime…Event`) and `x-realtime-events`, a map of event name
 * to `{ description, payload: $ref }`. Same conversion as
 * `addPanelComponents` (Standard JSON Schema, `openapi-3.0`).
 */
export function addRealtimeEvents(
  document: OpenAPIObject,
  extra: Record<string, RealtimeEventDeclaration> = {},
): void {
  const schemas = (document.components ??= {}).schemas ?? {};
  document.components.schemas = schemas;
  const manifest: Record<string, { description: string; payload: object }> = {};
  for (const [name, declared] of Object.entries(allRealtimeEvents(extra))) {
    const converted = declared.payload['~standard'].jsonSchema.output({
      target: 'openapi-3.0',
    }) as { definitions?: Record<string, object> };
    for (const [id, definition] of Object.entries(
      converted.definitions ?? {},
    )) {
      schemas[id] ??= JSON.parse(
        JSON.stringify(definition).replaceAll(
          '"#/definitions/',
          '"#/components/schemas/',
        ),
      ) as (typeof schemas)[string];
    }
    manifest[name] = {
      description: declared.description,
      payload: { $ref: `#/components/schemas/${declared.payload.meta()?.id}` },
    };
  }
  (document as unknown as Record<string, unknown>)['x-realtime-events'] =
    manifest;
}
