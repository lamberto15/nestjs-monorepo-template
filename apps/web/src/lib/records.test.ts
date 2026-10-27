import { describe, expect, it } from 'vitest';
import { refsKey } from '@/lib/list-refs';
import { peopleKey, unitsKey } from '@/lib/people';
import { recordKeys } from '@/lib/records';

// The keys are shared by features that do not import each other, and some
// tests and predicates spell them out: the values are the contract.
describe('recordKeys', () => {
  it('has the roots every feature shares', () => {
    expect(recordKeys.allLists).toEqual(['list']);
    expect(recordKeys.allDetails).toEqual(['record']);
  });

  it('builds a list page key under its feature’s lists, nested routes included', () => {
    const params = { page: 1 };
    expect(recordKeys.list('/v1/test-items', params)).toEqual([
      'list',
      '/v1/test-items',
      params,
    ]);
    const nested = recordKeys.list('/v1/a/{id}/b', params, { id: 'x' });
    expect(nested).toEqual(['list', '/v1/a/{id}/b', params, { id: 'x' }]);
    for (const key of [recordKeys.list('/v1/test-items', params), nested]) {
      expect(key.slice(0, 2)).toEqual(recordKeys.lists(key[1]));
    }
  });

  it('builds a record key under its feature’s records', () => {
    expect(recordKeys.detail('/v1/test-items', 'n1')).toEqual([
      'record',
      '/v1/test-items',
      'n1',
    ]);
    expect(recordKeys.details('/v1/test-items')).toEqual([
      'record',
      '/v1/test-items',
    ]);
  });
});

describe('the other shared roots', () => {
  it('are the prefixes the caches use', () => {
    expect([peopleKey, unitsKey, refsKey]).toEqual([
      ['people'],
      ['units'],
      ['refs'],
    ]);
  });
});
