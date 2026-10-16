import { createHash } from 'node:crypto';

/**
 * A sign-in's "device", for the new-sign-in alert: the user agent without
 * its version numbers (a browser update is the same browser) and the
 * network (`networkOf`), hashed. Two sign-ins are from the same device when
 * both match. `ip` stays the full address, for people.
 * Also a short summary for people ("Chrome on macOS"), from the user agent.
 *
 * Hand-rolled on purpose: a summary and a stable family are all we need,
 * not a user-agent parsing dependency.
 */
export function deviceOf(userAgent: unknown, ip: string) {
  const agent = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
  const family = agent
    .replace(/\d+(?:[._]\d+)*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const address = normalizeIp(ip);
  const hash = createHash('sha256')
    .update(`${family}\n${networkOf(address)}`)
    .digest('hex')
    .slice(0, 32);
  return { hash, summary: summarize(agent), ip: address };
}

/** The address as people know it: an IPv4 address mapped into IPv6 (`::ffff:10.0.0.1`) as IPv4. */
export const normalizeIp = (ip: string) =>
  ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/**
 * What identifies a device's network: an IPv4 address whole; for IPv6, the
 * /64 prefix (the first four groups), since privacy extensions change the
 * rest of the address every day.
 */
export function networkOf(address: string) {
  if (!address.includes(':')) {
    return address;
  }
  const [head = '', tail] = address.split('%')[0]!.toLowerCase().split('::');
  const groups = (part: string) => (part ? part.split(':') : []);
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const full = [
    ...front,
    ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0'),
    ...back,
  ];
  return `${full
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS)\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];
const SYSTEMS: [RegExp, string][] = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\b(?:Macintosh|Mac OS X)\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

/** "Chrome on macOS", or the agent's first product ("curl"), or "unknown". */
function summarize(agent: string) {
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
  if (browser && system) {
    return `${browser} on ${system}`;
  }
  return (
    browser ?? system ?? (agent.split(/[\s/]/)[0]?.slice(0, 60) || 'unknown')
  );
}
