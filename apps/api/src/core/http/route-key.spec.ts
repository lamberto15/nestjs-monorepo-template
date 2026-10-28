import type { NodeRequest, NodeRouter } from '@nestjs/platform-node';
import { matchedRouteKey, recordMatchedRoutes, routeKey } from './route-key.js';

describe('route keys', () => {
  it('names route patterns, never raw URLs', () => {
    expect(routeKey('get', '/v1/invoices/:id')).toBe('GET /v1/invoices/{id}');
    expect(routeKey('POST', '/v1/invoices/:id/comments/:commentId')).toBe(
      'POST /v1/invoices/{id}/comments/{commentId}',
    );
  });

  it('records the matched route of a request, or nothing when none matched', () => {
    const route = vi.fn();
    const router = { route } as unknown as NodeRouter;
    recordMatchedRoutes(router);
    // The metadata Nest copies onto a handler stays on it.
    const handler = Object.assign(() => 'handled', { version: '1' });
    router.route('PATCH', '/v1/invoices/:id', handler);
    const registered = route.mock.calls[0]![2] as typeof handler;
    expect(registered.version).toBe('1');

    const req = { method: 'PATCH' } as NodeRequest;
    expect(matchedRouteKey(req)).toBeUndefined();
    expect((registered as (r: NodeRequest) => unknown)(req)).toBe('handled');
    expect(matchedRouteKey(req)).toBe('PATCH /v1/invoices/{id}');
  });
});
