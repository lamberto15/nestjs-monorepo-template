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

  // Not a secret (a table filter's key in the page): Math.random is enough.
  return Array.from(
    { length },
    () => alphabet[Math.trunc(Math.random() * alphabet.length)],
  ).join('');
}
