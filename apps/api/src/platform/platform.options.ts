import type { ResiliencePreset } from '@nestjs/resilience';
import type { ApprovalDeclaration } from './approvals/approval.types.js';
import type { CustomFieldsDeclaration } from './custom-fields/custom-field.types.js';
import type { NotificationTypeDeclaration } from './notifications/notification.types.js';
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

export interface PlatformOptions {
  /** Every event type API clients may subscribe to; `dispatch()` refuses any other. */
  eventTypes: readonly string[];
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
}
