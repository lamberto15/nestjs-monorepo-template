// Formats the TypeScript the feature tools write as `pnpm format` would (the
// repository's Prettier config).

/** `text` as Prettier formats it for `file` (its config is found from there). */
export async function format(file, text) {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(text, { ...config, filepath: file });
}
