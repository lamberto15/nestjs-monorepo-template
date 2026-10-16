import { logRedaction, REDACTED } from '../../core/logging/redaction.js';
import {
  API_KEY_PREFIX,
  apiKeyId,
  generateApiKey,
  hashApiKey,
} from './api-keys.js';

describe('API keys', () => {
  it('generates keys of the documented shape, with a public id', () => {
    const key = generateApiKey();
    expect(key.startsWith(`${API_KEY_PREFIX}_`)).toBe(true);
    expect(apiKeyId(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(apiKeyId('not-a-key')).toBeUndefined();
    expect(hashApiKey(key)).toHaveLength(43);
  });

  it('declares its shape to the log redaction: a key in a text keeps its id and loses its secret', () => {
    const key = generateApiKey();
    const id = apiKeyId(key);
    const masked = logRedaction.redactText(`refused key ${key} for client`);
    expect(masked).toBe(
      `refused key ${API_KEY_PREFIX}_${id}_${REDACTED} for client`,
    );
    expect(masked).not.toContain(key);
  });
});
