import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadForBuildUpdate, setPendingPwaUpdate } from './sw-update';

afterEach(() => setPendingPwaUpdate(undefined));

describe('PWA build updates', () => {
  it('activates the waiting worker instead of doing a plain reload', () => {
    const update = vi.fn(async () => undefined);
    setPendingPwaUpdate(update);
    reloadForBuildUpdate();
    expect(update).toHaveBeenCalledOnce();
  });
});
