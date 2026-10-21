import { createSign } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import type { DevicePlatform } from '../messaging.tables.js';
import {
  PushSendError,
  type PushPayload,
  type PushProvider,
} from './push-provider.js';

export interface ApnsOptions {
  /** The .p8 key (PEM) from the Apple developer account. */
  privateKey: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id: the `apns-topic`. */
  bundleId: string;
  /** `https://api.push.apple.com`, or the sandbox host (a stub on loopback in tests). */
  apiUrl: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
/** Apple rejects a provider token older than an hour and a refresh more than every 20 minutes. */
const TOKEN_LIFETIME_MS = 40 * 60_000;
/** A device token is hex; anything else is no token (and never reaches the request path). */
const DEVICE_TOKEN = /^[0-9a-fA-F]{32,200}$/;
/** What APNs answers (`reason`) when the token is dead or not for this app. */
const DEAD_REASONS = new Set([
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'Unregistered',
]);

const base64url = (input: string | Buffer) =>
  Buffer.from(input).toString('base64url');

/**
 * APNs over HTTP/2 with token-based authentication (an ES256 JWT signed with
 * the .p8 key, reused for 40 minutes), as Apple documents it: "Sending
 * notification requests to APNs". `fetch` does not speak HTTP/2, so this uses
 * `node:http2` with one session kept open; a dropped session is reopened on
 * the next send. Signing is `node:crypto`, no library needed.
 */
export class ApnsPushProvider implements PushProvider {
  readonly name = 'apns';
  readonly platforms: readonly DevicePlatform[] = ['ios'];

  private session: ClientHttp2Session | null = null;
  private jwt: { value: string; issuedAt: number } | null = null;

  constructor(private readonly options: ApnsOptions) {}

  async send(token: string, payload: PushPayload) {
    if (!DEVICE_TOKEN.test(token)) {
      return 'gone' as const;
    }
    const body = JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: 'default',
      },
      id: payload.id,
      ...(payload.link ? { link: payload.link } : {}),
    });
    const { status, reason } = await this.request(token, body);
    if (status === 200) {
      return 'sent' as const;
    }
    if (status === 410 || (reason && DEAD_REASONS.has(reason))) {
      return 'gone' as const;
    }
    if (reason === 'ExpiredProviderToken') {
      this.jwt = null; // sign a new one on the retry
    }
    const transient =
      status === 429 || status >= 500 || reason === 'ExpiredProviderToken';
    throw new PushSendError(
      `APNs refused the push (${status}${reason ? ` ${reason}` : ''})`,
      !transient,
    );
  }

  /** Closes the session (shutdown, tests). */
  close() {
    this.session?.close();
    this.session = null;
  }

  private providerToken() {
    const now = Date.now();
    if (!this.jwt || now - this.jwt.issuedAt > TOKEN_LIFETIME_MS) {
      const signingInput = `${base64url(
        JSON.stringify({ alg: 'ES256', kid: this.options.keyId }),
      )}.${base64url(
        JSON.stringify({
          iss: this.options.teamId,
          iat: Math.floor(now / 1000),
        }),
      )}`;
      const signature = createSign('SHA256')
        .update(signingInput)
        // JWT wants the raw r||s form, not DER.
        .sign({ key: this.options.privateKey, dsaEncoding: 'ieee-p1363' });
      this.jwt = {
        value: `${signingInput}.${base64url(signature)}`,
        issuedAt: now,
      };
    }
    return this.jwt.value;
  }

  private connection() {
    if (!this.session || this.session.closed || this.session.destroyed) {
      const session = connect(new URL(this.options.apiUrl).origin);
      const drop = () => {
        if (this.session === session) this.session = null;
      };
      session.on('error', drop);
      session.on('close', drop);
      session.on('goaway', drop);
      session.unref(); // an idle session never holds a worker's shutdown
      this.session = session;
    }
    return this.session;
  }

  private request(token: string, body: string) {
    return new Promise<{ status: number; reason?: string }>(
      (resolve, reject) => {
        let request;
        try {
          request = this.connection().request({
            [constants.HTTP2_HEADER_METHOD]: 'POST',
            [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
            authorization: `bearer ${this.providerToken()}`,
            'apns-topic': this.options.bundleId,
            'apns-push-type': 'alert',
            'apns-priority': '10',
            'content-type': 'application/json',
          });
        } catch (error) {
          this.session = null;
          reject(
            new PushSendError(`APNs unreachable: ${String(error)}`, false),
          );
          return;
        }
        let status = 0;
        const chunks: Buffer[] = [];
        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
          request.close(constants.NGHTTP2_CANCEL);
          reject(new PushSendError('APNs timed out', false));
        });
        request.on('response', (headers) => {
          status = Number(headers[constants.HTTP2_HEADER_STATUS]);
        });
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('error', (error) =>
          reject(
            new PushSendError(`APNs unreachable: ${error.message}`, false),
          ),
        );
        request.on('end', () => {
          let reason: string | undefined;
          try {
            reason = (
              JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
                reason?: string;
              }
            ).reason;
          } catch {
            // no JSON body: the status alone decides
          }
          resolve({ status, reason });
        });
        request.end(body);
      },
    );
  }
}
