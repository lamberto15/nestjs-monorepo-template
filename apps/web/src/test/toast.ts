import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * A sonner toast, once it is on screen. Sonner mounts a toast hidden (opacity
 * 0) and shows it a frame later, so `findByText` can return it while
 * `toBeVisible()` still fails: wait for the visibility, not for the node.
 */
export function findToast(text: string | RegExp) {
  return waitFor(() => {
    const toast = screen.getByText(text);
    expect(toast).toBeVisible();
    return toast;
  });
}
