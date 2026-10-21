import { createSign } from 'node:crypto';
import type { DevicePlatform } from '../messaging.tables.js';
import {
  PushSendError,
  type PushPayload,
  type PushProvider,
} from './push-provider.js';

export interface FcmOptions {
  /** The Firebase project id (the path of the HTTP v1 endpoint). */
  projectId: string;
  /** The service account's `client_email` and `private_key`. */
  clientEmail: string;
  privateKey: string;
  /** `https://fcm.googleapis.com` (a stub on loopback in tests). */
  apiUrl: string;
  /** Google's OAuth2 token endpoint (a stub on loopback in tests). */
  tokenUrl: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TIMEOUT_MS = 10_000;
const base64url = (input: string | Buffer) =>
  Buffer.from(input).toString('base64url');

/**
 * FCM through the HTTP v1 API (`POST /v1/projects/{id}/messages:send`),
 * authorised with a service account: a self-signed RS256 JWT is exchanged
 * at Google's token endpoint for a one-hour access token (cached until a
 * minute before it ends), as Google's "Using OAuth 2.0 to authorize Google
 * APIs" describes. Written over `fetch` and `node:crypto`, like the Twilio
 * adapter (two calls; no Google SDK in the worker).
 */
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  readonly platforms: readonly DevicePlatform[] = ['android'];

  private access: { token: string; expiresAt: number } | null = null;

  constructor(private readonly options: FcmOptions) {}

  async send(token: string, payload: PushPayload) {
    const response = await this.post(
      `${this.options.apiUrl}/v1/projects/${encodeURIComponent(this.options.projectId)}/messages:send`,
      {
        message: {
          token,
          notification: { title: payload.title, body: payload.body },
          // `data` values are strings only.
          data: {
            id: payload.id,
            ...(payload.link ? { link: payload.link } : {}),
          },
          android: { priority: 'HIGH' },
        },
      },
      await this.accessToken(),
    );
    if (response.ok) {
      return 'sent' as const;
    }
    const error = (await response.json().catch(() => ({}))) as {
      error?: { status?: string; message?: string };
    };
    const code = error.error?.status;
    // UNREGISTERED: the app was uninstalled or the token expired. A malformed
    // token is INVALID_ARGUMENT on `message.token`: dead as well.
    if (
      response.status === 404 ||
      code === 'UNREGISTERED' ||
      (code === 'INVALID_ARGUMENT' &&
        /registration token/i.test(error.error?.message ?? ''))
    ) {
      return 'gone' as const;
    }
    if (response.status === 401) {
      this.access = null; // the cached token was refused: get a new one on the retry
    }
    const transient =
      response.status === 401 ||
      response.status === 429 ||
      response.status >= 500;
    throw new PushSendError(
      `FCM refused the push (${response.status}${code ? ` ${code}` : ''})`,
      !transient,
    );
  }

  private async post(url: string, body: unknown, bearer?: string) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'content-type':
            typeof body === 'string'
              ? 'application/x-www-form-urlencoded'
              : 'application/json',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new PushSendError(`FCM unreachable: ${String(error)}`, false);
    }
  }

  private async accessToken() {
    const now = Date.now();
    if (this.access && this.access.expiresAt - 60_000 > now) {
      return this.access.token;
    }
    const iat = Math.floor(now / 1000);
    const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
      JSON.stringify({
        iss: this.options.clientEmail,
        scope: SCOPE,
        aud: this.options.tokenUrl,
        iat,
        exp: iat + 3600,
      }),
    )}`;
    const assertion = `${signingInput}.${base64url(
      createSign('RSA-SHA256')
        .update(signingInput)
        .sign(this.options.privateKey),
    )}`;
    const response = await this.post(
      this.options.tokenUrl,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    );
    if (!response.ok) {
      // A refused assertion is a wrong key or account: retrying will not help.
      throw new PushSendError(
        `Google refused the FCM service account (${response.status})`,
        response.status < 500 && response.status !== 429,
      );
    }
    const body = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.access = {
      token: body.access_token,
      expiresAt: now + body.expires_in * 1000,
    };
    return body.access_token;
  }
}
