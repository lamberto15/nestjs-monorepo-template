import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import * as client from 'openid-client';
import { safeFetch } from '../../core/http/safe-fetch.js';
import {
  database,
  type DrizzleTransactions,
} from '../../core/database/transactions.js';
import { authTimeOf } from '../auth/sign-in-context.js';
import type { IamEnv } from '../iam.env.js';
import {
  type SsoConnection,
  SsoConnectionsService,
} from './sso-connections.service.js';
import { type SsoIdentity, SsoRefused } from './sso-accounts.service.js';
import { bindingHash, newBinding, SSO_REQUEST_TTL_MS } from './sso-browser.js';
import { ssoRequests } from './sso.tables.js';

/** Time and size limits of every request to a tenant's IdP. */
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 512 * 1024;

/**
 * OpenID Connect sign-in through a tenant's own IdP, with openid-client
 * (certified relying party: discovery, the authorization code flow with
 * PKCE, `state` and `nonce`, the ID token's signature, `iss`, `aud`, `exp`
 * and `nonce`). Every request to the IdP goes through the SSRF-guarded
 * fetch (core/http/safe-fetch.ts); the discovery document is fetched on
 * the queue (`discover()`) and read from the connection at sign-in.
 *
 * Custom around it: @nestjs/authentication's `OidcService` takes its
 * providers once, at boot, from its options; a tenant's connection is a row
 * added at runtime, so the transaction (PKCE verifier, nonce) is kept here,
 * in `sso_requests`, bound to the browser as the package binds its own (a
 * cookie whose secret's SHA-256 is the `state`).
 */
@Injectable()
export class OidcSso {
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

  /**
   * The issuer's discovery document (the queue's work): fetched through
   * the guarded fetch, its `issuer` checked against the configured one by
   * openid-client. What is stored is what a sign-in builds its client from.
   */
  async discover(issuer: string, clientId: string) {
    const configuration = await client.discovery(
      new URL(issuer),
      clientId,
      undefined,
      undefined,
      {
        [client.customFetch]: this.fetch as client.CustomFetch,
        timeout: FETCH_TIMEOUT_MS / 1000,
        ...(this.allowLoopback && { execute: [client.allowInsecureRequests] }),
      },
    );
    const metadata = configuration.serverMetadata();
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new Error(
        'The discovery document names no authorization or token endpoint.',
      );
    }
    if (!metadata.jwks_uri) {
      throw new Error('The discovery document names no jwks_uri.');
    }
    return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
  }

  /**
   * The IdP's authorization URL for a new sign-in, and the binding for the
   * browser's cookie. Refused (SsoRefused) while the discovery document
   * hasn't been fetched.
   */
  async start(connection: SsoConnection, redirectTo: string | undefined) {
    const configuration = this.configuration(connection);
    const binding = newBinding();
    const state = bindingHash(binding);
    const codeVerifier = client.randomPKCECodeVerifier();
    const nonce = client.randomNonce();
    await this.db
      .delete(ssoRequests)
      .where(lt(ssoRequests.expiresAt, new Date()));
    await this.db.insert(ssoRequests).values({
      connectionId: connection.id,
      bindingHash: state,
      codeVerifier,
      nonce,
      redirectTo: redirectTo ?? null,
      expiresAt: new Date(Date.now() + SSO_REQUEST_TTL_MS),
    });
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.connections.urls(connection).oidcCallback,
      scope: 'openid email profile',
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.toString(), binding };
  }

  /**
   * The IdP's answer: the transaction this browser started (its cookie's
   * binding, matching `state`, unused, unexpired), taken once, then the
   * code exchanged and the ID token verified by openid-client.
   */
  async finish(
    connection: SsoConnection,
    query: Record<string, string>,
    binding: string | undefined,
  ): Promise<{ identity: SsoIdentity; redirectTo: string | null }> {
    if (!binding || query.state !== bindingHash(binding)) {
      throw new SsoRefused('state_mismatch');
    }
    // One use: the first callback takes it, a replay finds nothing.
    const [request] = await this.db
      .update(ssoRequests)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(ssoRequests.connectionId, connection.id),
          eq(ssoRequests.bindingHash, query.state),
          isNull(ssoRequests.consumedAt),
          isNull(ssoRequests.samlRequestId),
          gt(ssoRequests.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!request?.codeVerifier) {
      throw new SsoRefused('request_unknown');
    }
    if (query.error) {
      throw new SsoRefused(`idp_error:${query.error.slice(0, 100)}`);
    }
    const configuration = this.configuration(connection);
    const callback = new URL(this.connections.urls(connection).oidcCallback);
    for (const [key, value] of Object.entries(query)) {
      callback.searchParams.set(key, value);
    }
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(configuration, callback, {
        pkceCodeVerifier: request.codeVerifier,
        expectedState: request.bindingHash,
        expectedNonce: request.nonce ?? undefined,
        idTokenExpected: true,
      });
    } catch (error) {
      throw new SsoRefused(
        `token_rejected:${(error as { code?: string }).code ?? (error as Error).name}`,
      );
    }
    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new SsoRefused('no_id_token');
    }
    return {
      identity: {
        subject: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        // Only a boolean true: a string "true" is no verified claim.
        emailVerified: claims.email_verified === true,
        name: typeof claims.name === 'string' ? claims.name : undefined,
        authenticatedAt: authTimeOf(claims),
      },
      redirectTo: request.redirectTo,
    };
  }

  /** openid-client's configuration of the connection, from its stored discovery document. */
  private configuration(connection: SsoConnection) {
    if (!connection.oidcMetadata || !connection.clientId) {
      throw new SsoRefused('metadata_missing');
    }
    const configuration = new client.Configuration(
      connection.oidcMetadata as unknown as client.ServerMetadata,
      connection.clientId,
      this.connections.clientSecret(connection) ?? undefined,
    );
    configuration[client.customFetch] = this.fetch as client.CustomFetch;
    configuration.timeout = FETCH_TIMEOUT_MS / 1000;
    if (this.allowLoopback) {
      client.allowInsecureRequests(configuration);
    }
    return configuration;
  }
}
