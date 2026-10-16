import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BulkTally, itemError, skipped } from './bulk.results.js';

describe('itemError', () => {
  it("keeps a 4xx's code, message and fields", () => {
    expect(
      itemError(
        new ForbiddenException({
          code: 'field_forbidden',
          message: 'You may not change: body.',
          fields: ['body'],
        }),
      ),
    ).toEqual({
      code: 'field_forbidden',
      message: 'You may not change: body.',
      errors: [{ path: 'body', message: 'You may not change: body.' }],
    });
  });

  it("keeps a validation_failed's errors", () => {
    expect(
      itemError(
        new BadRequestException({
          code: 'validation_failed',
          message: 'The request is invalid.',
          errors: [{ path: 'title', message: 'Too long' }],
        }),
      ),
    ).toEqual({
      code: 'validation_failed',
      message: 'The request is invalid.',
      errors: [{ path: 'title', message: 'Too long' }],
    });
  });

  it('names the code by the status when the exception gives none', () => {
    expect(itemError(new NotFoundException('Note 1 not found.'))).toEqual({
      code: 'not_found',
      message: 'Note 1 not found.',
    });
    expect(itemError(new ForbiddenException())).toMatchObject({
      code: 'forbidden',
    });
  });

  it('is undefined for a 5xx or anything else: the run stops', () => {
    expect(itemError(new ServiceUnavailableException())).toBeUndefined();
    expect(itemError(new Error('connection lost'))).toBeUndefined();
  });
});

describe('BulkTally', () => {
  it('counts every item and keeps results up to its cap', () => {
    const tally = new BulkTally(2);
    tally.add({ id: 'a', status: 'done' });
    tally.add({
      id: 'b',
      status: 'failed',
      error: { code: 'forbidden', message: 'Forbidden' },
    });
    tally.add({ id: 'c', status: 'done' });
    expect(tally.processed).toBe(3);
    expect(tally.result()).toEqual({
      done: 2,
      failed: 1,
      skipped: 0,
      results: [
        { id: 'a', status: 'done' },
        {
          id: 'b',
          status: 'failed',
          error: { code: 'forbidden', message: 'Forbidden' },
        },
      ],
      truncated: true,
    });
  });

  it('orders the results as the ids were asked for, skipped ones included', () => {
    const tally = new BulkTally();
    tally.add({ id: 'b', status: 'done' });
    tally.add(skipped('a', 'delete'));
    const result = tally.result(['a', 'b']);
    expect(result.results.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result).toMatchObject({ done: 1, skipped: 1 });
    expect(result).not.toHaveProperty('truncated');
    expect(result.results[0]).toEqual({
      id: 'a',
      status: 'skipped',
      error: {
        code: 'not_found',
        message: 'Not found, or not yours to delete.',
      },
    });
  });
});
