import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render-app';
import { allMethods, server } from '@/test/server';

// The server's answer is not read by the page: any 201 will do.
function captureSignUps(bodies: unknown[]) {
  server.use(
    http.post('/v1/auth/sign-up', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ id: 'u1' }, { status: 201 });
    }),
  );
}

async function fillAccount(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Name'), 'Ada Lovelace');
  await user.type(screen.getByLabelText('Email'), 'ada@example.com');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery');
}

function withTenantSignUp(tenantSignUp: boolean | undefined) {
  server.use(
    http.get('/v1/auth/methods', () =>
      HttpResponse.json({ ...allMethods, tenantSignUp }),
    ),
  );
}

describe('the sign-up page', () => {
  it('asks for the tenant name when tenantSignUp is true, and sends it as tenantName', async () => {
    withTenantSignUp(true);
    const bodies: unknown[] = [];
    captureSignUps(bodies);
    const user = userEvent.setup();
    await renderApp('/sign-up');

    await fillAccount(user);
    await user.type(screen.getByLabelText('Organization name'), '  Acme Corp ');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/Check your mailbox/)).toBeVisible();
    expect(bodies).toEqual([
      expect.objectContaining({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        tenantName: 'Acme Corp',
      }),
    ]);
  });

  it('omits tenantName when the field is left empty', async () => {
    withTenantSignUp(true);
    const bodies: unknown[] = [];
    captureSignUps(bodies);
    const user = userEvent.setup();
    await renderApp('/sign-up');

    await fillAccount(user);
    await user.type(screen.getByLabelText('Organization name'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/Check your mailbox/)).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('tenantName');
  });

  it('refuses a tenant name over 120 characters before sending', async () => {
    withTenantSignUp(true);
    const bodies: unknown[] = [];
    captureSignUps(bodies);
    const user = userEvent.setup();
    await renderApp('/sign-up');

    await fillAccount(user);
    await user.click(screen.getByLabelText('Organization name'));
    await user.paste('x'.repeat(121));
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('At most 120 characters.')).toBeVisible();
    expect(bodies).toEqual([]);
  });

  it.each([false, undefined])(
    'changes nothing when tenantSignUp is %s',
    async (tenantSignUp) => {
      withTenantSignUp(tenantSignUp);
      const bodies: unknown[] = [];
      captureSignUps(bodies);
      const user = userEvent.setup();
      await renderApp('/sign-up');

      await fillAccount(user);
      expect(screen.queryByLabelText('Organization name')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Create account' }));

      expect(await screen.findByText(/Check your mailbox/)).toBeVisible();
      expect(bodies[0]).not.toHaveProperty('tenantName');
    },
  );
});
