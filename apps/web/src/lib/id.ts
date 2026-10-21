const DEFAULT_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

interface GenerateIdOptions {
  alphabet?: string;
  length?: number;
}

export function generateId(
  prefixOrOptions?: string | GenerateIdOptions,
  inputOptions: GenerateIdOptions = {},
): string {
  const options =
    typeof prefixOrOptions === 'object' ? prefixOrOptions : inputOptions;

  const { alphabet = DEFAULT_ALPHABET, length = 12 } = options;

  // Not a secret (a table filter's key in the page); the Web Crypto source
  // keeps it out of the "is this PRNG safe here" question for good.
  return Array.from(
    crypto.getRandomValues(new Uint32Array(length)),
    (value) => alphabet[value % alphabet.length],
  ).join('');
}
