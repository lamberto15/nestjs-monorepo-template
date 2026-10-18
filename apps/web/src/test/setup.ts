import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { toast } from 'sonner';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from '@/test/server';

// msw (its Vitest quick start): every request of a test is answered by a
// handler, and one nobody expected fails the test.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  // Sonner's toasts live in a module-level store: one test's must not show in the next.
  toast.dismiss();
  server.resetHandlers();
});
afterAll(() => server.close());

// jsdom has no matchMedia; the theme provider asks it for the system theme.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Nor elementFromPoint, which input-otp (the code fields) calls.
document.elementFromPoint = () => null;

// Nor pointer capture, which sonner's toasts (swipe to dismiss) call on press.
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};
// Dice UI's mention asks whether the pointer is captured before it picks an item.
Element.prototype.hasPointerCapture = () => false;

// Nor ResizeObserver, which Dice UI's mention (and its popover) observes with.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Nor scrollIntoView, which cmdk (the command palette) calls on the selected item.
Element.prototype.scrollIntoView = () => {};
