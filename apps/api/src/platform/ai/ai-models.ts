import { createAnthropic } from '@ai-sdk/anthropic';
import type { AiModuleOptions } from '@nestjs/ai';
import type { ConfigService } from '@nestjs/config';
import { logRedaction } from '../../core/logging/redaction.js';
import type { PlatformEnv } from '../platform.env.js';

// A prompt holds a record's personal data: never in a log line or an error report.
logRedaction.declareFields('prompt', 'systemPrompt', 'completion');

type AiConfig = ConfigService<PlatformEnv, true>;

/** The helper is on while an API key is set; unset, nothing is ever sent anywhere (503 `ai_unavailable`). */
export const aiEnabled = (config: AiConfig) =>
  Boolean(config.get('ANTHROPIC_API_KEY', { infer: true }));

/**
 * The models of `AiModule` (@nestjs/ai): `default` and `cheap` on the
 * Anthropic API through @ai-sdk/anthropic, pinned by AI_MODEL and
 * AI_MODEL_CHEAP. The package's own retries are off and every attempt is
 * limited by AI_TIMEOUT_MS: the queue retries a whole run (AI_ATTEMPTS), so
 * the work is never paid for twice by two layers. The provider reads the key
 * when a call is made, so an unset key only fails a call, which the service
 * never makes while `aiEnabled()` is false.
 */
export function aiModuleOptions(config: AiConfig): AiModuleOptions {
  const get = <K extends keyof PlatformEnv>(key: K) =>
    config.get(key, { infer: true });
  const base = get('AI_BASE_URL');
  const anthropic = createAnthropic({
    apiKey: get('ANTHROPIC_API_KEY'),
    // The provider's base URL ends in /v1; AI_BASE_URL has always been the host.
    baseURL: base ? `${base.replace(/\/+$/, '')}/v1` : undefined,
  });
  return {
    models: {
      default: anthropic(get('AI_MODEL')),
      cheap: anthropic(get('AI_MODEL_CHEAP')),
    },
    defaults: { retry: false, timeout: get('AI_TIMEOUT_MS') },
  };
}
