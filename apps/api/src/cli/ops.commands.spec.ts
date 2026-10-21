import { Logger } from '@nestjs/common';
import type { Confirmer } from './confirm.js';
import {
  AdminCreateCommand,
  SettingDeleteCommand,
  TenantListCommand,
  UserListCommand,
  UserRemoveMfaCommand,
  UserResetPasswordCommand,
  UserUnlockCommand,
} from './ops.commands.js';
import type { OpsService, Plan } from './ops.service.js';

const plan = <T>(result: T): Plan<T> => ({
  summary: ['It will do something.'],
  apply: vi.fn(async () => result),
});

describe('the operator commands', () => {
  const confirm = vi.fn(async () => undefined);
  const confirmer = { confirm } as unknown as Confirmer;
  let printed: string[];

  beforeEach(() => {
    confirm.mockClear();
    printed = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.join(' '));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const everything = () => printed.join('\n');

  it('user:reset-password confirms first, applies as this shell’s operator, and prints the password once, never to the logger', async () => {
    const reset = plan({ email: 'a@example.com', password: 'S3cret-One-Time' });
    const ops = { resetPassword: vi.fn(async () => reset) };
    const logged = vi.spyOn(Logger.prototype, 'log');
    const command = new UserResetPasswordCommand(
      ops as unknown as OpsService,
      confirmer,
    );

    await command.run(['a@example.com'], { yes: true });

    expect(ops.resetPassword).toHaveBeenCalledWith('a@example.com');
    expect(confirm).toHaveBeenCalledWith(reset, true);
    expect(reset.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.any(String),
        host: expect.any(String),
      }),
    );
    expect(everything().match(/S3cret-One-Time/g)).toHaveLength(1);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('S3cret');
  });

  it('does not apply when the confirmation is refused', async () => {
    const reset = plan({ email: 'a@example.com', password: 'x' });
    confirm.mockRejectedValueOnce(new Error('Nothing was changed.'));
    const command = new UserResetPasswordCommand(
      { resetPassword: async () => reset } as unknown as OpsService,
      confirmer,
    );
    await expect(command.run(['a@example.com'], {})).rejects.toThrow(
      'Nothing was changed.',
    );
    expect(reset.apply).not.toHaveBeenCalled();
    expect(everything()).not.toContain('One-time password');
  });

  it('admin:create passes --tenant and --name, and prints the new account’s password', async () => {
    const created = plan({
      tenant: 'acme',
      created: true,
      changed: true,
      password: { email: 'r@example.com', password: 'Fresh-Pass' },
    });
    const ops = { adminCreate: vi.fn(async () => created) };
    await new AdminCreateCommand(ops as unknown as OpsService, confirmer).run(
      ['r@example.com'],
      { yes: true, tenant: 'acme', name: 'Rescue' },
    );
    expect(ops.adminCreate).toHaveBeenCalledWith('r@example.com', {
      yes: true,
      tenant: 'acme',
      name: 'Rescue',
    });
    expect(everything()).toContain('Fresh-Pass');
  });

  it('admin:create prints no password for an existing account, nor anything for a no-op', async () => {
    const existing = plan({ tenant: 'acme', created: false, changed: true });
    await new AdminCreateCommand(
      { adminCreate: async () => existing } as unknown as OpsService,
      confirmer,
    ).run(['r@example.com'], { yes: true });
    expect(everything()).toContain('is now an administrator');
    expect(everything()).not.toContain('One-time password');

    printed.length = 0;
    await new AdminCreateCommand(
      {
        adminCreate: async () =>
          plan({ tenant: 'acme', created: false, changed: false }),
      } as unknown as OpsService,
      confirmer,
    ).run(['r@example.com'], { yes: true });
    expect(printed).toEqual([]);
  });

  it('user:remove-mfa, user:unlock and setting:delete confirm before applying and report', async () => {
    const mfa = plan({ email: 'a@example.com', had: true });
    await new UserRemoveMfaCommand(
      { removeMfa: async () => mfa } as unknown as OpsService,
      confirmer,
    ).run(['a@example.com'], { yes: true });
    expect(mfa.apply).toHaveBeenCalled();
    expect(everything()).toContain('Removed the authenticator');

    const unlock = plan({
      email: 'a@example.com',
      failures: 3,
      suppressed: true,
    });
    await new UserUnlockCommand(
      { unlock: async () => unlock } as unknown as OpsService,
      confirmer,
    ).run(['a@example.com'], { yes: true });
    expect(everything()).toContain('3 failed attempt(s) cleared');

    const setting = plan({ removed: true });
    const ops = { deleteSetting: vi.fn(async () => setting) };
    await new SettingDeleteCommand(ops as unknown as OpsService, confirmer).run(
      ['auth.requireMfa'],
      { yes: true, platform: true },
    );
    expect(ops.deleteSetting).toHaveBeenCalledWith(
      'auth.requireMfa',
      expect.objectContaining({ platform: true }),
    );
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it('the listings change nothing and ask nothing', async () => {
    await new TenantListCommand({
      tenantList: async () => [
        {
          id: 't1',
          slug: 'acme',
          name: 'Acme',
          active: true,
          operator: false,
          members: 2,
        },
      ],
    } as unknown as OpsService).run();
    await new UserListCommand({
      userList: async () => ({
        members: [
          {
            email: 'a@example.com',
            roles: ['administrator'],
            mfa: true,
            accountActive: true,
            membershipActive: true,
          },
        ],
      }),
    } as unknown as OpsService).run(['acme']);
    expect(everything()).toContain('acme');
    expect(everything()).toContain('a@example.com');
    expect(confirm).not.toHaveBeenCalled();
  });
});
