import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarProvider,
} from '@nestjs-monorepo-template/ui/components/sidebar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedInWith } from '@/features/access/test/fixtures';
import { MarkdownEditor } from '@/components/markdown/markdown-editor';
import { renderApp } from '@/test/render-app';
import { renderComponent } from '@/test/render-component';

/** The desktop sidebar's state, `expanded` or `collapsed` (what the CSS keys on). */
const sidebarState = () =>
  document.querySelector('[data-slot="sidebar"]')?.getAttribute('data-state');

// The sidebar writes its choice to a cookie, and jsdom keeps cookies for the
// whole file: one test's must not decide the next one's first render.
afterEach(() => {
  document.cookie = 'sidebar_state=; path=/; max-age=0';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A sidebar, and next to it what a page puts under the shortcut. */
function Shell(props: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarContent />
      </Sidebar>
      <SidebarInset>{props.children}</SidebarInset>
    </SidebarProvider>
  );
}

describe('Ctrl/Cmd+B', () => {
  it.each(['Control', 'Meta'])(
    'collapses and expands the sidebar with %s from anywhere on the page',
    async (modifier) => {
      await renderComponent(
        <Shell>
          <button type="button">Somewhere</button>
        </Shell>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Somewhere' }));
      expect(sidebarState()).toBe('expanded');
      await user.keyboard(`{${modifier}>}b{/${modifier}}`);
      expect(sidebarState()).toBe('collapsed');
      await user.keyboard(`{${modifier}>}b{/${modifier}}`);
      expect(sidebarState()).toBe('expanded');
    },
  );

  it('is bold, not a sidebar toggle, inside the rich text editor', async () => {
    await renderComponent(
      <Shell>
        <span id="body-label">Text</span>
        <MarkdownEditor
          value="Plain"
          onChange={() => {}}
          labelledBy="body-label"
        />
      </Shell>,
    );
    const user = userEvent.setup();
    const editor = await screen.findByRole('textbox', { name: 'Text' });
    await user.click(editor);
    await user.keyboard('{Control>}b{/Control}');
    await user.keyboard('loud');
    // The editor took the key (what is typed next is bold) and the sidebar did not.
    expect(editor.querySelector('strong')).toHaveTextContent('loud');
    expect(sidebarState()).toBe('expanded');
  });

  it('is left to a text field', async () => {
    await renderComponent(
      <Shell>
        <input aria-label="Title" />
        <textarea aria-label="Notes" />
      </Shell>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Title'));
    await user.keyboard('{Control>}b{/Control}');
    expect(sidebarState()).toBe('expanded');
    await user.click(screen.getByLabelText('Notes'));
    await user.keyboard('{Meta>}b{/Meta}');
    expect(sidebarState()).toBe('expanded');
  });

  it('is left to whatever already handled the key', async () => {
    await renderComponent(
      <Shell>
        <button type="button" onKeyDown={(event) => event.preventDefault()}>
          Handles it
        </button>
      </Shell>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Handles it' }));
    await user.keyboard('{Control>}b{/Control}');
    expect(sidebarState()).toBe('expanded');
  });
});

describe('the sidebar on a phone', () => {
  /** The app on a screen this wide (useIsMobile reads `innerWidth`), signed in. */
  async function openOnPhone() {
    signedInWith({});
    vi.stubGlobal('innerWidth', 500);
    const rendered = await renderApp('/');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Toggle Sidebar' }),
    );
    return {
      ...rendered,
      user,
      sheet: within(await screen.findByRole('dialog')),
    };
  }

  it('closes the sheet when a menu entry takes the user to its page', async () => {
    const { router, user, sheet } = await openOnPhone();
    await user.click(sheet.getByRole('link', { name: 'Notifications' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/notifications'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes the sheet when the user menu opens an account page', async () => {
    const { router, user, sheet } = await openOnPhone();
    await user.click(sheet.getByRole('button', { name: /Ada Lovelace/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Profile' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/account/profile'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes the sheet for the page the user is already on, too', async () => {
    const { router, user, sheet } = await openOnPhone();
    await user.click(sheet.getByRole('link', { name: 'Dashboard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/');
  });
});

describe('the sidebar cookie', () => {
  it('opens expanded without one', async () => {
    signedInWith({});
    await renderApp('/');
    await waitFor(() => expect(sidebarState()).toBe('expanded'));
  });

  it('opens collapsed when the user collapsed it', async () => {
    document.cookie = 'sidebar_state=false; path=/';
    signedInWith({});
    await renderApp('/');
    await waitFor(() => expect(sidebarState()).toBe('collapsed'));
  });

  it('opens expanded when the user left it expanded', async () => {
    document.cookie = 'sidebar_state=true; path=/';
    signedInWith({});
    await renderApp('/');
    await waitFor(() => expect(sidebarState()).toBe('expanded'));
  });

  it('keeps a collapsed sidebar collapsed on the next visit', async () => {
    signedInWith({});
    await renderApp('/');
    const user = userEvent.setup();
    await waitFor(() => expect(sidebarState()).toBe('expanded'));
    await user.keyboard('{Control>}b{/Control}');
    expect(sidebarState()).toBe('collapsed');
    cleanup();
    await renderApp('/');
    await waitFor(() => expect(sidebarState()).toBe('collapsed'));
  });

  it('opens expanded when the browser will not give the cookies', async () => {
    document.cookie = 'sidebar_state=false; path=/';
    vi.spyOn(document, 'cookie', 'get').mockImplementation(() => {
      throw new DOMException('sandboxed', 'SecurityError');
    });
    signedInWith({});
    await renderApp('/');
    await waitFor(() => expect(sidebarState()).toBe('expanded'));
  });
});
