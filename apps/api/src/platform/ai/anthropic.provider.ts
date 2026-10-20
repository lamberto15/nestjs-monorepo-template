import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import {
  type AiCompletion,
  type AiCompletionRequest,
  AiProvider,
  AiProviderRejected,
  AiProviderUnavailable,
} from './ai-provider.js';

/**
 * The Anthropic Messages API through the official SDK
 * (`@anthropic-ai/sdk`). The answer is forced through one tool call whose
 * `input_schema` is the task's JSON Schema (`tool_choice: { type: 'tool' }`),
 * so the model returns structured data, never free text. The SDK's own
 * retries are off: the queue retries a whole run (AI_ATTEMPTS), once, so
 * the work is never paid for twice by two layers.
 */
@Injectable()
export class AnthropicProvider extends AiProvider {
  readonly enabled = true;
  private readonly client: Anthropic;

  constructor(options: { apiKey: string; baseURL?: string }) {
    super();
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      maxRetries: 0,
    });
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletion> {
    let message;
    try {
      message = await this.client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          tools: [
            {
              name: request.tool.name,
              description: request.tool.description,
              input_schema: {
                ...request.tool.schema,
                type: 'object',
              } as Anthropic.Tool.InputSchema,
            },
          ],
          tool_choice: { type: 'tool', name: request.tool.name },
        },
        { timeout: request.timeoutMs },
      );
    } catch (error) {
      // 429, 5xx, 529 (overloaded), connection errors and timeouts: retry.
      if (
        error instanceof Anthropic.APIConnectionError ||
        (error instanceof Anthropic.APIError &&
          (error.status === undefined ||
            error.status === 429 ||
            error.status >= 500))
      ) {
        throw new AiProviderUnavailable('The AI provider is unavailable.');
      }
      throw new AiProviderRejected('The AI provider refused the request.');
    }
    const call = message.content.find((block) => block.type === 'tool_use');
    if (!call) {
      throw new AiProviderRejected('The model did not answer with the tool.');
    }
    return {
      output: call.input,
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  }
}
