import type { DevicePlatform } from '../messaging.tables.js';

/** What a device is shown. Small: providers cap a payload (PUSH_MAX_PAYLOAD_BYTES). */
export interface PushPayload {
  title: string;
  body: string;
  /** A path of the web app to open. */
  link?: string;
  /** The notification's id: a client dedupes by it. */
  id: string;
}

/**
 * A push provider behind one interface, like SMS: `send` answers `sent`, or
 * `gone` when the provider says the token is dead (the device is revoked); a
 * transient failure throws and the queue retries.
 */
export interface PushProvider {
  readonly name: string;
  readonly platforms: readonly DevicePlatform[];
  send(token: string, payload: PushPayload): Promise<'sent' | 'gone'>;
}

export class PushSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

export const PUSH_PROVIDER = Symbol('messaging.push-provider');
