import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import * as client from 'openid-client';
import {
  ResponseTooLargeError,
  safeFetch,
  UnsafeDestinationError,
} from '../../core/http/safe-fetch.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import type { IamEnv } from '../iam.env.js';
import { mapUserinfo } from './oauth2-mapping.js';
import { FETCH_MAX_BYTES, FETCH_TIMEOUT_MS } from './oidc-sso.service.js';
import {
  type SsoConnection,
  SsoConnectionsService,
} from './sso-connections.service.js';
import { type SsoIdentity, SsoRefused } from './sso-accounts.service.js';
import { openCodeRequest, takeCodeRequest } from './sso-requests.js';

/**
 * Sign-in through a tenant's plain OAuth 2.0 provider (docs/auth.md, "OAuth
 * 2.0 connections"): no discovery, no ID token, the person read from the
 * provider's user-info endpoint and mapped by the connection's declarative
 * `mapping` (oauth2-mapping.ts). Lark/Feishu is the worked example.
 *
 * openid-client does the protocol, as for OpenID Connect: a configuration
 * built from the connection's endpoints (a hand-made `ServerMetadata`, no
 * discovery), the authorization URL with PKCE (S256) and `state`, the code
 * grant with the configured client authentication, and the user-info GET
 * (`fetchProtectedResource`, the access token as bearer). Every request
 * goes through the SSRF-guarded fetch (core/http/safe-fetch.ts: https,
 * checked addresses, no redirects, 10 s, 512 KiB).
 *
 * Custom around it, for the reasons OidcSso gives: the providers are rows
 * added at runtime, which @nestjs/authentication's boot-time `OidcService`
 * can't take; its OAuth 2.0 `profile()` is code, ours is data.
 */
@Injectable()
export class Oauth2Sso {
  private readonly fetch: typeof fetch;
  private readonly allowLoopback: boolean;

  constructor(
    private readonly txHost: TransactionHost<DrizzleTransactions>,
    private readonly connections: SsoConnectionsService,
    config: ConfigService<IamEnv, true>,
  ) {
    this.allowLoopback = config.get('SSO_ALLOW_LOOPBACK', { infer: true });
    this.fetch = safeFetch({
      allowHttp: this.allowLoopback,
      allowPrivateNetworks: this.allowLoopback,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
    });
  }

  private get db() {
    return database(this.txHost);
  }

  /** The provider's authorization URL for a new sign-in, and the browser's binding. No `nonce`: no ID token. */
  async start(connection: SsoConnection, redirectTo: string | undefined) {
    const configuration = this.configuration(connection);
    const codeVerifier = client.randomPKCECodeVerifier();
    const { binding, state } = await openCodeRequest(this.db, connection.id, {
      codeVerifier,
      redirectTo,
    });
    const scopes = connection.scopes ?? [];
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.connections.urls(connection).oauth2Callback,
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      ...(scopes.length > 0 && { scope: scopes.join(' ') }),
    });
    return { url: url.toString(), binding };
  }

  /**
   * The provider's answer: the browser's transaction taken once, the code
   * exchanged, one GET of the user-info endpoint, the mapping applied. Any
   * failure is an SsoRefused whose reason the controller audits.
   */
  async finish(
    connection: SsoConnection,
    query: Record<string, string>,
    binding: string | undefined,
  ): Promise<{ identity: SsoIdentity; redirectTo: string | null }> {
    const request = await takeCodeRequest(
      this.db,
      connection.id,
      query,
      binding,
    );
    const configuration = this.configuration(connection);
    // Only `code` and `state`: an `iss` (RFC 9207) is OpenID Connect's
    // mix-up defence, which a plain OAuth 2.0 provider doesn't send; each
    // connection has its own redirect URI anyway.
    const callback = new URL(this.connections.urls(connection).oauth2Callback);
    for (const key of ['code', 'state']) {
      if (query[key] !== undefined) {
        callback.searchParams.set(key, query[key]);
      }
    }
    let accessToken: string;
    try {
      const tokens = await client.authorizationCodeGrant(
        configuration,
        callback,
        {
          pkceCodeVerifier: request.codeVerifier,
          expectedState: request.bindingHash,
          idTokenExpected: false,
        },
      );
      accessToken = tokens.access_token;
    } catch (error) {
      throw new SsoRefused(`token_rejected:${failure(error)}`);
    }
    let response: Response;
    try {
      response = await client.fetchProtectedResource(
        configuration,
        accessToken,
        new URL(connection.userinfoEndpoint!),
        'GET',
        undefined,
        new Headers({ accept: 'application/json' }),
      );
    } catch (error) {
      throw new SsoRefused(`userinfo_failed:${failure(error)}`);
    }
    // A redirect (never followed) or an error status.
    if (response.status < 200 || response.status > 299) {
      throw new SsoRefused(`userinfo_failed:${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SsoRefused('userinfo_malformed');
    }
    const user = mapUserinfo(body, connection.mapping!);
    return {
      identity: {
        subject: user.subject,
        email: user.email,
        emailVerified: user.emailVerified,
        name: user.name,
        // No `auth_time`: the sign-in counts from now (docs/auth.md, step-up).
        authenticatedAt: undefined,
        groups: user.groups,
      },
      redirectTo: request.redirectTo,
    };
  }

  /** openid-client's configuration of the connection, from its own endpoints (no discovery). */
  private configuration(connection: SsoConnection) {
    if (
      !connection.clientId ||
      !connection.authorizationEndpoint ||
      !connection.tokenEndpoint ||
      !connection.userinfoEndpoint ||
      !connection.mapping
    ) {
      throw new SsoRefused('configuration_incomplete');
    }
    const server: client.ServerMetadata = {
      // openid-client needs an issuer; a plain OAuth 2.0 provider has none
      // (no ID token to check it against), so its authorization origin
      // names it.
      issuer: new URL(connection.authorizationEndpoint).origin,
      authorization_endpoint: connection.authorizationEndpoint,
      token_endpoint: connection.tokenEndpoint,
      userinfo_endpoint: connection.userinfoEndpoint,
    };
    const method = connection.tokenEndpointAuthMethod ?? 'client_secret_basic';
    const secret =
      method === 'none'
        ? undefined
        : (this.connections.clientSecret(connection) ?? undefined);
    const authentication =
      method === 'none'
        ? client.None()
        : method === 'client_secret_basic'
          ? client.ClientSecretBasic(secret)
          : client.ClientSecretPost(secret);
    const configuration = new client.Configuration(
      server,
      connection.clientId,
      undefined,
      authentication,
    );
    configuration[client.customFetch] = this.fetch as client.CustomFetch;
    configuration.timeout = FETCH_TIMEOUT_MS / 1000;
    if (this.allowLoopback) {
      client.allowInsecureRequests(configuration);
    }
    return configuration;
  }
}

/** A short, secret-free name of why a request to the provider failed, for the audit log. */
function failure(error: unknown): string {
  for (
    let current: unknown = error, depth = 0;
    current instanceof Error && depth < 5;
    current = current.cause, depth++
  ) {
    if (current instanceof UnsafeDestinationError) {
      return 'unsafe_destination';
    }
    if (current instanceof ResponseTooLargeError) {
      return 'too_large';
    }
    if (current.name === 'TimeoutError' || current.name === 'AbortError') {
      return 'timeout';
    }
  }
  const { code, name } = error as { code?: string; name?: string };
  return code ?? name ?? 'error';
}
