import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

/**
 * Top-level names that never resolve publicly (RFC 2606, RFC 6761, RFC 6762,
 * RFC 7686, RFC 8375, ICANN's `.internal`): a hostname under one can't be
 * proved in public DNS, nor get a public certificate.
 */
const RESERVED_TLDS = new Set([
  'localhost',
  'local',
  'internal',
  'test',
  'example',
  'invalid',
  'onion',
  'arpa',
  'home',
  'lan',
  'corp',
  'localdomain',
]);

/** A DNS label in ASCII: letters, digits and inner hyphens, 1 to 63 characters. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A top-level label: letters, or an IDN's `xn--` form; never all digits. */
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Why a hostname is refused, for the 400's message. */
export type HostnameRefusal =
  'not_a_hostname' | 'ip_address' | 'port' | 'reserved' | 'app_domain';

/**
 * A custom domain as stored and compared (docs/branding.md, "Custom
 * domains"): trimmed, lower case, an IDN in punycode (`domainToASCII`,
 * UTS #46), without a trailing dot, at most 253 characters in labels of 63,
 * two labels at least, under a public top-level name. Never an IP address,
 * never with a port, a path, a user or a wildcard, and never the app's own
 * domain or one under it (`appHosts`: APP_URL's and WEB_URL's hosts), which
 * the deployment serves itself. Returns the hostname, or why it is refused.
 */
export function normalizeHostname(
  input: string,
  appHosts: readonly string[],
): { hostname: string } | { refused: HostnameRefusal } {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 300) {
    return { refused: 'not_a_hostname' };
  }
  // An IP in brackets (IPv6) or bare, before anything reads it as a name.
  if (isIP(raw.replace(/^\[|\]$/g, '')) !== 0) {
    return { refused: 'ip_address' };
  }
  if (/:\d*$/.test(raw) && isIP(raw) === 0) {
    return { refused: 'port' };
  }
  // Only a name: no scheme, path, query, user, wildcard or space.
  if (/[/?#@*\s\\:[\]%]/.test(raw)) {
    return { refused: 'not_a_hostname' };
  }
  const ascii = domainToASCII(raw.replace(/\.$/, ''));
  if (!ascii || ascii.length > 253) {
    return { refused: 'not_a_hostname' };
  }
  // domainToASCII maps some forms (full-width digits, `0x7f.1`) to an IP.
  if (isIP(ascii) !== 0) {
    return { refused: 'ip_address' };
  }
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return { refused: 'not_a_hostname' };
  }
  const tld = labels.at(-1)!;
  if (!TLD.test(tld)) {
    return { refused: 'not_a_hostname' };
  }
  if (RESERVED_TLDS.has(tld)) {
    return { refused: 'reserved' };
  }
  for (const app of appHosts) {
    const own = app.toLowerCase();
    if (ascii === own || ascii.endsWith(`.${own}`)) {
      return { refused: 'app_domain' };
    }
  }
  return { hostname: ascii };
}
