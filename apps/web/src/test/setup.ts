import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { toast } from 'sonner';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { teardownApps } from '@/test/app-clients';
import { server } from '@/test/server';

// findBy*/waitFor wait 1 s by default (Testing Library's asyncUtilTimeout).
// One step here (a click that re-renders the whole app, then a request) takes
// a few hundred ms alone and several times that on a loaded machine, where
// the default failed tests that were only slow (#127). The test's own
// timeout (vitest.config.ts) stays well above it.
configure({ asyncUtilTimeout: 3000 });

// msw (its Vitest quick start): every request of a test is answered by a
// handler, and one nobody expected fails the test.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => {
  cleanup();
  // A rendered app's queries still in flight must not outlive the test (app-clients.ts).
  await teardownApps();
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

// Nor layout boxes on ranges and text, which ProseMirror (the rich text
// editor) asks for to scroll the caret into view after an edit.
const noRects = () => ({
  length: 0,
  item: () => null,
  [Symbol.iterator]: [][Symbol.iterator],
});
const emptyRect = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
});
Range.prototype.getClientRects = noRects as unknown as Range['getClientRects'];
Range.prototype.getBoundingClientRect =
  emptyRect as unknown as Range['getBoundingClientRect'];
