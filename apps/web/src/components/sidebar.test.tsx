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
    await user.click(sheet.getByRole('link', { name: 'Inbox' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/notifications'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes the sheet when the user menu opens an account page', async () => {
    const { router, user, sheet } = await openOnPhone();
    await user.click(sheet.getByRole('button', { name: /Ada Lovelace/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Account' }));
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

describe('the bottom bar', () => {
  const bar = async () =>
    within(await screen.findByRole('navigation', { name: 'Quick navigation' }));

  it('shows on a phone, with the menu sheet and search one tap away', async () => {
    signedInWith({});
    vi.stubGlobal('innerWidth', 500);
    const { router } = await renderApp('/');
    const user = userEvent.setup();
    const tabs = await bar();
    expect(tabs.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      '/',
    );
    await user.click(tabs.getByRole('link', { name: 'Inbox' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/notifications'),
    );
    await user.click(tabs.getByRole('button', { name: 'Menu' }));
    const sheet = within(await screen.findByRole('dialog'));
    expect(sheet.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(tabs.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('dialog')).toBeVisible();
  });

  it('is not there on a desktop', async () => {
    signedInWith({});
    await renderApp('/');
    await screen.findByRole('navigation', { name: 'Main menu' });
    expect(
      screen.queryByRole('navigation', { name: 'Quick navigation' }),
    ).toBeNull();
  });
});

describe('the account pages', () => {
  it('are tabs of one page, the current one marked', async () => {
    signedInWith({});
    const { router } = await renderApp('/account/preferences');
    const tabs = within(
      await screen.findByRole('navigation', { name: 'Account pages' }),
    );
    expect(tabs.getByRole('link', { name: 'Preferences' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await userEvent.setup().click(tabs.getByRole('link', { name: 'Privacy' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/account/privacy'),
    );
  });
});

describe('the menu groups', () => {
  afterEach(() => localStorage.removeItem('nav-groups'));
  const can = { 'Access.manageRoles': true, 'Access.readAudit': true };
  const menu = async () =>
    within(await screen.findByRole('navigation', { name: 'Main menu' }));
  const heading = async (name: string) =>
    (await menu()).findByRole('button', { name });

  it('opens Workspace and the group of the page, and folds the others', async () => {
    signedInWith(can);
    await renderApp('/access/roles');
    expect(await heading('People & access')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(await heading('Security & compliance')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(
      (await menu()).queryByRole('link', { name: 'Audit log' }),
    ).toBeNull();
    expect(
      (await menu()).getByRole('link', { name: 'Roles & permissions' }),
    ).toBeVisible();
  });

  it('keeps a group the user opened open on the next visit', async () => {
    signedInWith(can);
    await renderApp('/');
    const user = userEvent.setup();
    await user.click(await heading('Security & compliance'));
    expect(
      await (await menu()).findByRole('link', { name: 'Audit log' }),
    ).toBeVisible();
    cleanup();
    await renderApp('/');
    expect(
      await (await menu()).findByRole('link', { name: 'Audit log' }),
    ).toBeVisible();
  });

  it('names the group and the page in the header', async () => {
    signedInWith(can);
    await renderApp('/access/roles');
    const crumbs = within(
      await screen.findByRole('navigation', { name: 'Breadcrumb' }),
    );
    expect(crumbs.getByText('People & access')).toBeInTheDocument();
    expect(crumbs.getByText('Roles & permissions')).toHaveAttribute(
      'aria-current',
      'page',
    );
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
