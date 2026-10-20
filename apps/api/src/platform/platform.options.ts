import type { ResiliencePreset } from '@nestjs/resilience';
import type { ConsentKindDeclaration } from './account/consent-kinds.js';
import type { ApprovalDeclaration } from './approvals/approval.types.js';
import type { CustomFieldsDeclaration } from './custom-fields/custom-field.types.js';
import type { NotificationTypeDeclaration } from './notifications/notification.types.js';
import type { RealtimeEventDeclaration } from './realtime/realtime-events.js';
import type { SettingDeclaration } from './settings/setting.types.js';

export const PLATFORM_OPTIONS = Symbol('PLATFORM_OPTIONS');

/** A third party whose signed webhooks this API accepts (`@VerifyWebhook(name)`). */
export interface IncomingWebhookSender {
  /** The name `@VerifyWebhook()` uses. */
  name: string;
  /** `standard` (Standard Webhooks) or `stripe` (`t=…,v1=…`), as the sender signs. */
  scheme: 'standard' | 'stripe';
  /** The signature header, when the sender renames it (e.g. `Carrier-Signature`). */
  header?: string;
  /**
   * The environment variable holding the shared secret. Unset, a secret is
   * created on the first start and kept in the database (give it to the sender).
   */
  secretEnv: string;
}

/**
 * A webhook event type with what GET /v1/webhook-event-types says of it.
 * A plain string declares the type alone.
 */
export interface WebhookEventTypeDeclaration {
  /** `note.published`: full-stop delimited segments. */
  type: string;
  /** One sentence for a subscription screen: what happened. */
  description?: string;
  /** The heading it is listed under; default its first segment (`note`). */
  group?: string;
}

export interface PlatformOptions {
  /**
   * Every event type API clients may subscribe to; `dispatch()` refuses any
   * other. A string, or a declaration with a description
   * (GET /v1/webhook-event-types).
   */
  eventTypes: readonly (string | WebhookEventTypeDeclaration)[];
  incomingWebhooks?: IncomingWebhookSender[];
  /**
   * BullMQ queues the features use, by name: registered here (inject with
   * `@InjectQueue(name)`) and shown by `GET /ops/queues`. A feature's
   * `@Processor(name)` class consumes them.
   */
  queues?: readonly string[];
  /**
   * Named resilience policies, usually one per external dependency:
   * `@Resilience(name)` on a route, `resilience.preset(name)` in a service.
   */
  resiliencePresets?: Record<string, ResiliencePreset>;
  /**
   * The subjects whose records take custom fields, and where their values
   * live (`defineCustomFields()`): managed at /custom-fields.
   */
  customFields?: readonly CustomFieldsDeclaration[];
  /**
   * The notification types the features send (`defineNotifications()`):
   * their channels' defaults, texts in `i18n/<locale>/notifications.json`.
   */
  notifications?: readonly NotificationTypeDeclaration<any>[];
  /**
   * The settings and feature flags the features read (`defineSettings()`):
   * typed defaults in code, values set at runtime at /settings.
   */
  settings?: readonly SettingDeclaration<any>[];
  /**
   * The actions that need approval (`defineApproval()`): their payload, the
   * default policy, the setting that switches them on. Each feature also
   * registers its handler (ApprovalsRegistry.handle): docs/approvals.md.
   */
  approvals?: readonly ApprovalDeclaration<any>[];
  /**
   * The kinds of consent the app asks its users for (`defineConsentKinds()`,
   * the template's `CONSENT_KINDS`): their current version and whether
   * they are required. `POST /v1/account/consents` accepts these alone, at
   * that version; `GET /v1/account/consent-kinds` lists them. None: no
   * consent can be recorded.
   */
  consents?: readonly ConsentKindDeclaration[];
  /**
   * The realtime events the features push beyond the platform's
   * (`defineRealtimeEvents()`): published in the OpenAPI document and the
   * typed client, and checked against their payload schema in development
   * and tests.
   */
  realtimeEvents?: Record<string, RealtimeEventDeclaration>;
}
