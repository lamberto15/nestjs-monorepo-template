import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTheme } from '@nestjs-monorepo-template/ui/components/theme-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderComponent } from '@/test/render-component';

/** The theme as the provider holds it, and the ways to change it. */
function Probe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <p>Theme: {theme}</p>
      <button type="button" onClick={() => setTheme('dark')}>
        Dark
      </button>
      <button type="button" onClick={() => setTheme('light')}>
        Light
      </button>
    </div>
  );
}

const root = document.documentElement;

// The provider puts its class on <html> and the browser's storage outlives a
// test: each one starts from a page that has never seen either.
beforeEach(() => {
  root.classList.remove('light', 'dark');
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the theme provider', () => {
  it('follows the system until the user chooses', async () => {
    await renderComponent(<Probe />);
    // The test setup's system is light.
    await waitFor(() => expect(root).toHaveClass('light'));
    expect(screen.getByText('Theme: system')).toBeInTheDocument();
  });

  it('applies the theme the user chose before, and remembers a new choice', async () => {
    localStorage.setItem('theme', 'dark');
    await renderComponent(<Probe />);
    await waitFor(() => expect(root).toHaveClass('dark'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Light' }));
    await waitFor(() => expect(root).toHaveClass('light'));
    expect(root).not.toHaveClass('dark');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  // WCAG 2.1.4 (Character Key Shortcuts): a shortcut of one letter that can't
  // be turned off flips the theme under anyone whose keyboard lands on the page.
  it.each(['d', 'D'])(
    'does not change the theme on the %s key',
    async (key) => {
      await renderComponent(<Probe />);
      await waitFor(() => expect(root).toHaveClass('light'));
      const user = userEvent.setup();
      await user.keyboard(key);
      expect(screen.getByText('Theme: system')).toBeInTheDocument();
      expect(root).toHaveClass('light');
      expect(root).not.toHaveClass('dark');
      expect(localStorage.getItem('theme')).toBeNull();
    },
  );
});

describe('the theme provider with the browser’s storage blocked', () => {
  beforeEach(() => {
    const blocked = () => {
      throw new DOMException('Site data is blocked.', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
  });

  it('renders with the default theme', async () => {
    await renderComponent(<Probe />);
    expect(screen.getByText('Theme: system')).toBeInTheDocument();
    await waitFor(() => expect(root).toHaveClass('light'));
  });

  it('still changes the theme, for this visit', async () => {
    await renderComponent(<Probe />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    await waitFor(() => expect(root).toHaveClass('dark'));
    expect(screen.getByText('Theme: dark')).toBeInTheDocument();
  });
});
