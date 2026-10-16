import { createPublicKey, type KeyObject, X509Certificate } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { HttpClient, InjectHttpClient } from '@nestjs/http-client';

/** The @nestjs/http-client client the gateway calls SNS with (PlatformModule registers it). */
export const SNS_HTTP = 'sns';

/** A fetched certificate is kept this long; SNS rotates them rarely, and the URL names the certificate. */
const CERTIFICATE_TTL_MS = 24 * 3_600_000;
/** More distinct certificate URLs than this in a day is not SNS: the cache starts over. */
const CERTIFICATE_CACHE_MAX = 32;

/**
 * What the SES intake asks of the network, behind one class so tests
 * replace it (no AWS in a test): the signing certificate of a message,
 * and the visit that confirms a subscription. Callers check the URL is
 * SNS's (`isSnsUrl`) before calling; the gateway checks nothing.
 */
@Injectable()
export abstract class SnsGateway {
  /** The public key of the certificate at `url` (a PEM the message names). */
  abstract certificate(url: string): Promise<KeyObject>;
  /** GETs a `SubscribeURL`: SNS confirms the subscription on the visit. */
  abstract confirm(url: string): Promise<void>;
}

/** A certificate larger than this is not SNS's (theirs are about 2 KB). */
export const CERTIFICATE_MAX_BYTES = 16 * 1024;

/**
 * The public key of a PEM: an X.509 certificate (what SNS serves), valid
 * at `now`, or a bare public key (tests). Throws for an expired or
 * not-yet-valid certificate, and for a body that is too large.
 */
export function publicKeyOf(pem: string, now = new Date()): KeyObject {
  if (Buffer.byteLength(pem) > CERTIFICATE_MAX_BYTES) {
    throw new Error(`certificate larger than ${CERTIFICATE_MAX_BYTES} bytes`);
  }
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    return createPublicKey(pem);
  }
  const certificate = new X509Certificate(pem);
  const from = new Date(certificate.validFrom).getTime();
  const to = new Date(certificate.validTo).getTime();
  if (now.getTime() < from || now.getTime() > to) {
    throw new Error(
      `certificate not valid now (${certificate.validFrom} to ${certificate.validTo})`,
    );
  }
  return certificate.publicKey;
}

/** Over HTTP, with a small cache of certificates by URL. */
@Injectable()
export class HttpSnsGateway extends SnsGateway {
  private readonly logger = new Logger('SNS');
  private readonly certificates = new Map<
    string,
    { key: KeyObject; expiresAt: number }
  >();

  constructor(@InjectHttpClient(SNS_HTTP) private readonly http: HttpClient) {
    super();
  }

  async certificate(url: string) {
    const cached = this.certificates.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.key;
    }
    const response = await this.http.get(url, { responseType: 'text' });
    const key = publicKeyOf(response.data);
    if (this.certificates.size >= CERTIFICATE_CACHE_MAX) {
      this.certificates.clear();
    }
    this.certificates.set(url, {
      key,
      expiresAt: Date.now() + CERTIFICATE_TTL_MS,
    });
    return key;
  }

  async confirm(url: string) {
    await this.http.get(url, { responseType: 'text' });
    this.logger.log('SNS subscription confirmed');
  }
}
