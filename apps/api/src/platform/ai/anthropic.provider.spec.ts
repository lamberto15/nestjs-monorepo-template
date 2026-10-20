import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AiProviderRejected, AiProviderUnavailable } from './ai-provider.js';
import { AnthropicProvider } from './anthropic.provider.js';

/** The Messages API on loopback: no real call is ever made. */
describe('AnthropicProvider', () => {
  let server: Server;
  let status = 200;
  let body: unknown;
  const seen: { headers: Record<string, unknown>; body: any }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        res
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
  });
  afterAll(() => {
    server.close();
  });

  const provider = () =>
    new AnthropicProvider({
      apiKey: 'sk-ant-test',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
  const request = {
    model: 'claude-haiku-5-5',
    system: 'sys',
    prompt: 'p',
    tool: { name: 'answer', description: 'd', schema: { properties: {} } },
    maxTokens: 100,
    timeoutMs: 2000,
  };

  it('forces the tool and returns its input with the usage', async () => {
    status = 200;
    body = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'answer', input: { ok: true } },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    };
    const completion = await provider().complete(request);
    expect(completion).toEqual({
      output: { ok: true },
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    const last = seen.at(-1)!;
    expect(last.body.tool_choice).toEqual({ type: 'tool', name: 'answer' });
    expect(last.body.tools[0].input_schema.type).toBe('object');
    expect(last.headers['x-api-key']).toBe('sk-ant-test');
  });

  it('is unavailable on 429 and 5xx, rejected on other errors or a missing tool call', async () => {
    status = 529;
    body = { type: 'error', error: { type: 'overloaded_error', message: 'x' } };
    await expect(provider().complete(request)).rejects.toBeInstanceOf(
      AiProviderUnavailable,
    );
    status = 400;
    body = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'x' },
    };
    await expect(provider().complete(request)).rejects.toBeInstanceOf(
      AiProviderRejected,
    );
    status = 200;
    body = {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'text', text: 'free text' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    await expect(provider().complete(request)).rejects.toBeInstanceOf(
      AiProviderRejected,
    );
  });
});
