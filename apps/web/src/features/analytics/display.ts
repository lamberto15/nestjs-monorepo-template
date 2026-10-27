/** A result cell as text: nested values as JSON, 64-bit integers without losing digits. */
export function display(value: unknown) {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object'
    ? JSON.stringify(value, (_, child: unknown) => {
        if (typeof child === 'bigint') return child.toString();
        if (child instanceof Map) return Array.from(child);
        return child;
      })
    : String(value);
}
