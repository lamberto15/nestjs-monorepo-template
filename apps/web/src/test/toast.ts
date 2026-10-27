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

/**
 * No sonner toast on screen: sonner adds one a frame after the call, so this
 * waits a little first. For an error the page states itself (a not-found
 * view), which must not be said twice.
 */
export async function expectNoToast() {
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(document.querySelector('[data-sonner-toast]')).toBeNull();
}
