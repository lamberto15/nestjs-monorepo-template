import { UnrecoverableError } from 'bullmq';
import { withCause } from './tenant-job.js';

describe('withCause', () => {
  it("adds the database's error to Drizzle's, keeping the object (#859)", () => {
    const error = new Error('Failed query: select 1\nparams: ', {
      cause: new Error('canceling statement due to statement timeout'),
    });
    expect(withCause(error)).toBe(error);
    expect(error.message).toBe(
      'Failed query: select 1\nparams: \ncause: canceling statement due to statement timeout',
    );
    // Once: a retry's error keeps one cause line.
    withCause(error);
    expect(error.message.match(/cause:/g)).toHaveLength(1);
  });

  it('leaves an error without a cause, and its class, as it is', () => {
    const error = new UnrecoverableError('Bad file');
    expect(withCause(error)).toBeInstanceOf(UnrecoverableError);
    expect(error.message).toBe('Bad file');
    expect(withCause('text')).toBe('text');
  });
});
