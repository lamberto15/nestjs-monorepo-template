import { Reflector } from '@nestjs/core';
import type { NodeRequest, NodeRouter } from '@nestjs/platform-node';
import { MetricsService } from '../metrics/metrics.service.js';
import {
  Deprecated,
  DeprecationInterceptor,
  deprecationHeader,
  deprecationLinks,
  sunsetHeader,
} from './deprecated.js';
import { recordMatchedRoutes } from './route-key.js';

describe('Deprecated()', () => {
  it('writes the deprecation date as an RFC 9745 structured-field date', () => {
    expect(deprecationHeader('2026-01-01')).toBe('@1767225600');
  });

  it('writes the sunset as an RFC 8594 HTTP-date', () => {
    expect(sunsetHeader('2027-01-01')).toBe('Fri, 01 Jan 2027 00:00:00 GMT');
  });

  it('builds the Link header from the links given', () => {
    expect(deprecationLinks({ since: '2026-01-01' })).toBeUndefined();
    expect(
      deprecationLinks({
        since: '2026-01-01',
        link: 'https://x.test/why',
        successor: 'https://x.test/v2',
      }),
    ).toBe(
      '<https://x.test/why>; rel="deprecation", <https://x.test/v2>; rel="successor-version"',
    );
  });

  it('refuses a date it cannot read, at decoration time', () => {
    expect(() => Deprecated({ since: 'soon' })).toThrow(/not a date/);
    expect(() => Deprecated({ since: '2026-01-01', sunset: 'x' })).toThrow();
  });

  it('sets the headers and counts the call by route', async () => {
    const metrics = new MetricsService();
    const options = {
      since: '2026-01-01',
      sunset: '2027-01-01',
      link: 'https://x.test/why',
    };
    const reflector = {
      getAllAndOverride: () => options,
    } as unknown as Reflector;
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => (headers[k] = v),
      append: (k: string, v: string) => (headers[k] = v),
    };
    // A request the router handled for the route `/v1/things/:id`.
    const route = vi.fn();
    const router = { route } as unknown as NodeRouter;
    recordMatchedRoutes(router);
    router.route('GET', '/v1/things/:id', () => undefined);
    const req = { method: 'GET' } as NodeRequest;
    (route.mock.calls[0]![2] as (r: NodeRequest) => void)(req);
    const context = {
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    };
    const next = { handle: vi.fn() };
    new DeprecationInterceptor(reflector, metrics).intercept(
      context as never,
      next,
    );
    expect(next.handle).toHaveBeenCalled();
    expect(headers).toEqual({
      Deprecation: '@1767225600',
      Sunset: 'Fri, 01 Jan 2027 00:00:00 GMT',
      Link: '<https://x.test/why>; rel="deprecation"',
    });
    expect((await metrics.scrape()).body).toMatch(
      /^deprecated_route_calls_total\{route="GET \/v1\/things\/\{id\}"\} 1$/m,
    );
  });
});
