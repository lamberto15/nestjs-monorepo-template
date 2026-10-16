import type { Request } from 'express';
import { matchedRouteKey, routeKey } from './route-key.js';

describe('route keys', () => {
  it('names route patterns, never raw URLs', () => {
    expect(routeKey('get', '/v1/notes/:id')).toBe('GET /v1/notes/{id}');
    expect(routeKey('POST', '/v1/notes/:id/comments/:commentId')).toBe(
      'POST /v1/notes/{id}/comments/{commentId}',
    );
  });

  it('reads the matched route of a request, or nothing when none matched', () => {
    const matched = {
      method: 'PATCH',
      baseUrl: '',
      route: { path: '/v1/notes/:id' },
    } as unknown as Request;
    expect(matchedRouteKey(matched)).toBe('PATCH /v1/notes/{id}');
    const unmatched = { method: 'GET', baseUrl: '' } as unknown as Request;
    expect(matchedRouteKey(unmatched)).toBeUndefined();
  });
});
