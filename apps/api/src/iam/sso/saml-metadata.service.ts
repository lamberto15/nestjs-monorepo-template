import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  safeFetch,
  ResponseTooLargeError,
  UnsafeDestinationError,
} from '../../core/http/safe-fetch.js';
import type { IamEnv } from '../iam.env.js';
import { parseIdpMetadata, type IdpMetadata } from './saml-metadata.js';

const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 512 * 1024;

/**
 * Fetches a SAML IdP's metadata from the URL an administrator gives
 * (docs/auth.md, "Importing an IdP's metadata"). Server-side request
 * forgery guarded by the same `safeFetch` as the OpenID Connect issuer
 * (https only, every resolved address checked in the socket's lookup,
 * private and metadata ranges refused, no redirects, 10 s, 512 KiB).
 * Nothing is stored: the answer pre-fills a connection. The error says
 * why, never what the destination answered.
 *
 * Done in the request, not on the queue: the administrator waits for the
 * answer to fill the form, the fetch is bounded (10 s) and rate limited.
 */
@Injectable()
export class SamlMetadataImport {
  private readonly fetch: typeof fetch;

  constructor(config: ConfigService<IamEnv, true>) {
    const allowLoopback = config.get('SSO_ALLOW_LOOPBACK', { infer: true });
    this.fetch = safeFetch({
      allowHttp: allowLoopback,
      allowPrivateNetworks: allowLoopback,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
    });
  }

  async import(url: string): Promise<IdpMetadata> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: {
          accept: 'application/samlmetadata+xml, application/xml, text/xml',
        },
      });
    } catch (error) {
      throw refused(
        causedBy(error, UnsafeDestinationError)
          ? 'saml_metadata_url_refused'
          : causedBy(error, ResponseTooLargeError)
            ? 'saml_metadata_too_large'
            : 'saml_metadata_unreachable',
      );
    }
    if (response.status !== 200) {
      throw refused('saml_metadata_unreachable');
    }
    const parsed = parseIdpMetadata(await response.text());
    if (!parsed.ok) {
      throw refused('saml_metadata_invalid', parsed.reason);
    }
    return parsed.metadata;
  }
}

/** undici wraps the socket's errors ("fetch failed"): look through `cause`. */
function causedBy(error: unknown, type: new (...args: never[]) => Error) {
  for (let depth = 0; depth < 5 && error; depth++) {
    if (error instanceof type) {
      return true;
    }
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

const refused = (code: string, reason?: string) =>
  new UnprocessableEntityException({
    code,
    message: reason
      ? `The metadata can't be used: ${reason}.`
      : 'The metadata could not be fetched.',
  });
