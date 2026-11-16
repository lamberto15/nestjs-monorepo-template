import { createSign } from 'node:crypto';
import {
  type HttpClient,
  HttpNetworkError,
  HttpResponseError,
  HttpTimeoutError,
} from '@nestjs/http-client';
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
  /** Google's OAuth2 token URL: the JWT's audience. */
  tokenUrl: string;
  /** Its path, on the token client's base URL. */
  tokenPath: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const base64url = (input: string | Buffer) =>
  Buffer.from(input).toString('base64url');

/**
 * FCM through the HTTP v1 API (`POST /v1/projects/{id}/messages:send`),
 * authorised with a service account: a self-signed RS256 JWT is exchanged
 * at Google's token endpoint for a one-hour access token (cached until a
 * minute before it ends), as Google's "Using OAuth 2.0 to authorize Google
 * APIs" describes. Written over @nestjs/http-client (the clients on FCM_API_URL and
 * FCM_TOKEN_URL, registered by messagingClients()) and `node:crypto`, like the
 * Twilio adapter (two calls; no Google SDK in the worker).
 */
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  readonly platforms: readonly DevicePlatform[] = ['android'];

  private access: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly options: FcmOptions,
    private readonly http: HttpClient,
    private readonly tokenHttp: HttpClient,
  ) {}

  async send(token: string, payload: PushPayload) {
    const bearer = await this.accessToken();
    try {
      await this.http.post(
        `/v1/projects/${encodeURIComponent(this.options.projectId)}/messages:send`,
        {
          json: {
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
          headers: { authorization: `Bearer ${bearer}` },
          responseType: 'text',
        },
      );
      return 'sent' as const;
    } catch (error) {
      if (!(error instanceof HttpResponseError)) throw this.unreachable(error);
      const body = (
        typeof error.body === 'object' && error.body ? error.body : {}
      ) as { error?: { status?: string; message?: string } };
      const code = body.error?.status;
      // UNREGISTERED: the app was uninstalled or the token expired. A malformed
      // token is INVALID_ARGUMENT on `message.token`: dead as well.
      if (
        error.status === 404 ||
        code === 'UNREGISTERED' ||
        (code === 'INVALID_ARGUMENT' &&
          /registration token/i.test(body.error?.message ?? ''))
      ) {
        return 'gone' as const;
      }
      if (error.status === 401) {
        this.access = null; // the cached token was refused: get a new one on the retry
      }
      const transient =
        error.status === 401 || error.status === 429 || error.status >= 500;
      throw new PushSendError(
        `FCM refused the push (${error.status}${code ? ` ${code}` : ''})`,
        !transient,
      );
    }
  }

  /** A failure before an answer (network, timeout): transient; anything else is a bug and propagates. */
  private unreachable(error: unknown) {
    return error instanceof HttpNetworkError ||
      error instanceof HttpTimeoutError
      ? new PushSendError(`FCM unreachable: ${String(error)}`, false)
      : error;
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
    let body: { access_token: string; expires_in: number };
    try {
      body = (
        await this.tokenHttp.post<typeof body>(this.options.tokenPath, {
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }),
          responseType: 'json',
        })
      ).data;
    } catch (error) {
      if (error instanceof HttpResponseError) {
        // A refused assertion is a wrong key or account: retrying will not help.
        throw new PushSendError(
          `Google refused the FCM service account (${error.status})`,
          error.status < 500 && error.status !== 429,
        );
      }
      throw this.unreachable(error);
    }
    this.access = {
      token: body.access_token,
      expiresAt: now + body.expires_in * 1000,
    };
    return body.access_token;
  }
}
