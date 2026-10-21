import { BlockList, isIP } from 'node:net';

/**
 * An API client's IP allowlist (`api_clients.allowed_cidrs`). Matching is
 * node:net's BlockList (documented, IPv4 and IPv6 subnets): no CIDR
 * arithmetic of our own. It also matches an IPv4-mapped IPv6 address
 * (`::ffff:203.0.113.9`, how a dual-stack socket reports a v4 peer) against
 * IPv4 rules.
 */

/** A CIDR as written to the database: canonical text, or an error message. */
export function normalizeCidr(input: string): string | { error: string } {
  const [address, prefix, ...rest] = input.trim().split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) {
    return { error: `“${input}” is not an IPv4 or IPv6 address or CIDR.` };
  }
  const max = family === 4 ? 32 : 128;
  if (prefix === undefined) {
    return `${address.toLowerCase()}/${max}`;
  }
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) {
    return { error: `“${input}” has a prefix length outside 0-${max}.` };
  }
  return `${address.toLowerCase()}/${Number(prefix)}`;
}

/** True when `ip` (as Express reports it) is inside one of `cidrs` (normalized, see normalizeCidr). */
export function ipAllowed(ip: string | undefined, cidrs: string[]) {
  if (cidrs.length === 0) {
    return true;
  }
  const family = ip ? isIP(ip) : 0;
  if (!ip || family === 0) {
    return false; // no readable address: refused, never waved through
  }
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/');
    list.addSubnet(
      address,
      Number(prefix),
      isIP(address) === 4 ? 'ipv4' : 'ipv6',
    );
  }
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}
