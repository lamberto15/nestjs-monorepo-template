/**
 * The allowlist textarea: one address or CIDR per line. This only gives a
 * friendly early message; the API (`normalizeCidr`) is the authority and
 * canonicalizes, so a line it accepts is never refused here.
 */

export type CidrProblem =
  | { line: number; value: string; kind: 'invalid' }
  | { line: number; value: string; kind: 'prefix'; max: number };

const octet = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const ipv4 = new RegExp(`^${octet}(?:\\.${octet}){3}$`);

/** 4, 6 or 0. IPv6 is checked by the platform's URL parser (no hand-rolled grammar). */
function family(address: string): 4 | 6 | 0 {
  if (ipv4.test(address)) {
    return 4;
  }
  if (!address.includes(':') || /[^0-9a-f:.]/i.test(address)) {
    return 0;
  }
  try {
    new URL(`http://[${address}]/`);
    return 6;
  } catch {
    return 0;
  }
}

/** The non-empty lines, trimmed (commas and spaces also separate, for a paste). */
export function cidrLines(text: string): string[] {
  return text
    .split(/[\n,;\s]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The first problem of each bad entry; none: the text is sendable. */
export function cidrProblems(text: string): CidrProblem[] {
  const problems: CidrProblem[] = [];
  text.split('\n').forEach((raw, index) => {
    for (const value of cidrLines(raw)) {
      const [address = '', prefix, ...rest] = value.split('/');
      const fam = family(address);
      if (fam === 0 || rest.length > 0) {
        problems.push({ line: index + 1, value, kind: 'invalid' });
        continue;
      }
      const max = fam === 4 ? 32 : 128;
      if (
        prefix !== undefined &&
        (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max)
      ) {
        problems.push({ line: index + 1, value, kind: 'prefix', max });
      }
    }
  });
  return problems;
}

/** What the API sends: the entries, duplicates dropped. */
export function cidrList(text: string): string[] {
  return [...new Set(cidrLines(text))];
}
