/**
 * The links a body may carry: web addresses and mail, nothing else
 * (`javascript:`, `data:`, `vbscript:` and relative paths all fail). One rule
 * for what the viewer renders and what the editor lets a link be.
 */
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function isSafeUrl(url: string | undefined | null): url is string {
  if (typeof url !== 'string') return false;
  // Browsers ignore tabs, newlines and other control characters inside a
  // URL's scheme (`java\tscript:`), so the check looks at the URL without
  // them, and a URL that has any is refused whatever its scheme.
  const bare = Array.from(url)
    .filter((char) => char.charCodeAt(0) > 32 && char !== '\u007f')
    .join('');
  return bare === url && SAFE_URL.test(url);
}
