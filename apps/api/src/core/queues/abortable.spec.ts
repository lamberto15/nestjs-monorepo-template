import { abortable } from './abortable.js';

describe('abortable', () => {
  it('passes the work through without a signal', async () => {
    await expect(abortable(undefined, Promise.resolve(1))).resolves.toBe(1);
  });

  it('rejects at once with the reason when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('timed out'));
    await expect(
      abortable(controller.signal, new Promise(() => {})),
    ).rejects.toThrow('timed out');
  });

  it('rejects when the signal aborts while waiting', async () => {
    const controller = new AbortController();
    const waiting = abortable(controller.signal, new Promise(() => {}));
    controller.abort(new Error('timed out'));
    await expect(waiting).rejects.toThrow('timed out');
  });
});
