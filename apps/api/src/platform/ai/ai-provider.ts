import { Injectable } from '@nestjs/common';
import { logRedaction } from '../../core/logging/redaction.js';

// A prompt holds a record's personal data: never in a log line or an error report.
logRedaction.declareFields('prompt', 'systemPrompt', 'completion');

/** One structured completion: the prompt, and the JSON Schema the answer must satisfy. */
export interface AiCompletionRequest {
  model: string;
  system: string;
  /** The record's content, already framed as data. */
  prompt: string;
  /** The tool the model must call; its input is the answer. */
  tool: { name: string; description: string; schema: Record<string, unknown> };
  maxTokens: number;
  timeoutMs: number;
}

export interface AiCompletion {
  /** The tool call's input, not yet validated. */
  output: unknown;
  /** The model id the provider answered with. */
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** The provider failed in a way a retry may fix (rate limit, overload, timeout). */
export class AiProviderUnavailable extends Error {}
/** The provider refused or answered with something unusable: a retry will not help. */
export class AiProviderRejected extends Error {}

/**
 * Where completions come from. The Anthropic adapter is the default
 * (anthropic.provider.ts); a project swaps it by providing another class
 * under the AI_PROVIDER token. Tests use a fake. `enabled` is false when
 * nothing is configured: the helper is then off (503 `ai_unavailable`).
 */
@Injectable()
export abstract class AiProvider {
  abstract readonly enabled: boolean;
  abstract complete(request: AiCompletionRequest): Promise<AiCompletion>;
}

/** The provider while ANTHROPIC_API_KEY is unset: nothing is ever sent anywhere. */
@Injectable()
export class DisabledAiProvider extends AiProvider {
  readonly enabled = false;
  complete(): Promise<AiCompletion> {
    return Promise.reject(new AiProviderRejected('The AI helper is off.'));
  }
}
