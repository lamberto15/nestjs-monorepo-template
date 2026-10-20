import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * A `fetch` for URLs a tenant gives the app (an SSO connection's OpenID
 * Connect issuer, its token and key endpoints): server-side request forgery
 * guarded the way the outgoing webhooks are (@nestjs/webhooks'
 * `HttpWebhookTransport`), with a time and a size limit.
 *
 * - https only (`allowHttp` for development and the tests); no credentials
 *   in the URL.
 * - Every address a host name resolves to must be allowed (`addressAllowed`):
 *   link-local (cloud metadata), metadata addresses outside it, multicast and
 *   reserved ranges are always refused; loopback and private ranges unless
 *   `allowPrivateNetworks`. The check runs in the socket's own `lookup`, so
 *   the address checked is the address connected to (no DNS rebinding); an
 *   IP literal is checked before the request.
 * - Redirects are never followed: a 3xx is answered as is (openid-client
 *   then refuses it).
 * - At most `maxBytes` of the body are read, within `timeoutMs` for the
 *   whole exchange.
 *
 * Custom: @nestjs/webhooks keeps its transport's address policy internal
 * (only `HttpWebhookTransport`, a POST of a webhook, is exported), and
 * `fetch()` can't pin the address without an undici `Agent` with a custom
 * `connect.lookup`, the way openid-client's docs show (`customFetch` with
 * `undici.fetch(url, { ...options, dispatcher })`).
 */
export interface SafeFetchOptions {
  /** Accept `http:` URLs. Default false. */
  allowHttp?: boolean;
  /** Loopback and private ranges. Default false. Link-local and metadata stay refused. */
  allowPrivateNetworks?: boolean;
  /** The whole exchange, headers and body. */
  timeoutMs: number;
  /** The body read at most; past it the request fails. */
  maxBytes: number;
}

export class UnsafeDestinationError extends Error {
  constructor(reason: string) {
    super(`Refused destination: ${reason}`);
    this.name = 'UnsafeDestinationError';
  }
}

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`The response is larger than ${limit} bytes.`);
    this.name = 'ResponseTooLargeError';
  }
}

const block = (ranges: [string, number, 'ipv4' | 'ipv6'][]) => {
  const list = new BlockList();
  for (const [address, prefix, family] of ranges) {
    list.addSubnet(address, prefix, family);
  }
  return list;
};

/** Never: link-local (cloud metadata), metadata hosts, documentation, benchmarking, multicast, reserved. */
const ALWAYS_REFUSED = block([
  ['169.254.0.0', 16, 'ipv4'],
  ['168.63.129.16', 32, 'ipv4'],
  ['100.100.100.200', 32, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['fe80::', 10, 'ipv6'],
  ['fd00:ec2::254', 128, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
]);

/** Only with `allowPrivateNetworks`: unspecified, loopback, RFC 1918, shared address space, unique local. */
const PRIVATE = block([
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
]);

/** IPv6's global unicast: anything else (and IPv4 in IPv6 forms other than the mapped one) is refused. */
const GLOBAL_UNICAST_V6 = block([['2000::', 3, 'ipv6']]);

/**
 * Whether a connection to `address` is allowed. An IPv4-mapped IPv6
 * address (`::ffff:a.b.c.d`) is judged by its IPv4 address (BlockList
 * matches it against the IPv4 rules).
 */
export function addressAllowed(
  address: string,
  allowPrivateNetworks = false,
): boolean {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (ALWAYS_REFUSED.check(address, type)) {
    return false;
  }
  if (PRIVATE.check(address, type)) {
    return allowPrivateNetworks;
  }
  if (family === 6 && !/^::ffff:\d/i.test(address)) {
    return GLOBAL_UNICAST_V6.check(address, 'ipv6');
  }
  return true;
}

/**
 * The socket's lookup: every address of the host is resolved and checked,
 * and the socket connects to one of those (never asks DNS again).
 */
function guardedLookup(allowPrivateNetworks: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const list = addresses as LookupAddress[];
      const refused = list.find(
        (entry) => !addressAllowed(entry.address, allowPrivateNetworks),
      );
      if (list.length === 0 || refused) {
        callback(
          new UnsafeDestinationError(
            refused
              ? `${hostname} resolves to ${refused.address}`
              : `${hostname} has no address`,
          ),
          '',
          0,
        );
        return;
      }
      if ((options as { all?: boolean }).all) {
        (callback as (error: null, addresses: LookupAddress[]) => void)(
          null,
          list,
        );
        return;
      }
      callback(null, list[0].address, list[0].family);
    });
  };
}

/** The URL's host as a socket would use it: without IPv6 brackets. */
const socketHost = (url: URL) => url.hostname.replace(/^\[(.*)\]$/, '$1');

/** A `fetch` that refuses unsafe destinations, follows no redirect and bounds time and size. */
export function safeFetch(options: SafeFetchOptions): typeof fetch {
  const allowPrivate = options.allowPrivateNetworks === true;
  const dispatcher = new Agent({
    connect: { lookup: guardedLookup(allowPrivate) },
  });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.protocol !== 'https:' &&
      !(options.allowHttp && url.protocol === 'http:')
    ) {
      throw new UnsafeDestinationError(`${url.protocol} URL`);
    }
    if (url.username || url.password) {
      throw new UnsafeDestinationError('credentials in the URL');
    }
    const host = socketHost(url);
    if (isIP(host) && !addressAllowed(host, allowPrivate)) {
      throw new UnsafeDestinationError(host);
    }
    const signal = AbortSignal.any(
      [AbortSignal.timeout(options.timeoutMs), init?.signal].filter(
        (entry): entry is AbortSignal => !!entry,
      ),
    );
    const response = await undiciFetch(url, {
      ...(init as object),
      redirect: 'manual',
      signal,
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
    const body = await readAtMost(
      response.body as ReadableStream<Uint8Array> | null,
      options.maxBytes,
    );
    return new Response(body as Uint8Array<ArrayBuffer> | null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers as unknown as Headers,
    });
  }) as typeof fetch;
}

/** The body, or a ResponseTooLargeError past `limit` bytes (the rest is never read). */
async function readAtMost(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | null> {
  if (!body) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(limit);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
