import { AppModule } from '../../../src/app.module.js';
import { bootApp, type TestApp } from '../../support.js';

describe('notes in the OpenAPI document (e2e)', () => {
  let node: TestApp;
  let document: {
    paths: Record<string, Record<string, any>>;
  };

  beforeAll(async () => {
    node = await bootApp(undefined, undefined, { module: AppModule });
    document = (await node.http().get('/api-json').expect(200)).body;
  });

  afterAll(async () => {
    await node.close();
  });

  it('documents the optional total of paginated lists', () => {
    const list = document.paths['/v1/notes'].get;
    expect(
      list.parameters.map((parameter: { name: string }) => parameter.name),
    ).toContain('count');
    const response = JSON.stringify(list.responses['200']);
    expect(response).toContain('"total"');
    expect(response).toContain('"totalCapped"');
  });

  it('documents the notes routes and the example sender', () => {
    expect(
      Object.keys(document.paths)
        .filter(
          (path) =>
            path.startsWith('/v1/notes') ||
            path === '/v1/webhooks/example-sender',
        )
        .sort(),
    ).toEqual([
      '/v1/notes',
      '/v1/notes/bulk',
      '/v1/notes/{id}',
      '/v1/notes/{id}/attachments',
      '/v1/notes/{id}/comments',
      '/v1/notes/{id}/comments/{commentId}',
      '/v1/notes/{id}/pdf',
      '/v1/notes/{id}/restore',
      '/v1/notes/{id}/revisions',
      '/v1/notes/{id}/revisions/{a}/diff/{b}',
      '/v1/notes/{id}/revisions/{number}',
      '/v1/notes/{id}/revisions/{number}/restore',
      '/v1/notes/{id}/tags',
      '/v1/notes/{id}/watch',
      '/v1/webhooks/example-sender',
    ]);
  });

  it('turns the Zod schemas into request bodies and responses', () => {
    const create = document.paths['/v1/notes'].post;
    expect(create.requestBody.content['application/json'].schema).toMatchObject(
      {
        type: 'object',
        required: ['title', 'body'],
      },
    );
    expect(
      create.responses['201'].content['application/json'].schema.properties,
    ).toHaveProperty('status');
  });

  it('pre-fills Idempotency-Key with "generate"', () => {
    const header = document.paths['/v1/notes'].post.parameters.find(
      (parameter: { name: string }) => parameter.name === 'Idempotency-Key',
    );
    expect(header).toMatchObject({
      in: 'header',
      required: true,
      schema: { example: 'generate' },
    });
  });
});
