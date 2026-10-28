import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { Confirmer } from './confirm.js';
import { currentOperator } from './operator.js';
import { OpsService, type OneTimePassword, type Plan } from './ops.service.js';

/** Every changing command's options. */
interface ChangeOptions {
  yes?: boolean;
  tenant?: string;
  platform?: boolean;
  name?: string;
  before?: string;
}

/**
 * Shows the plan, asks (unless `--yes`), applies it as the operator of this
 * shell. Output goes straight to stdout, never through the app's logger:
 * a one-time password is on the terminal and nowhere else.
 */
async function carryOut<T>(
  confirmer: Confirmer,
  plan: Plan<T>,
  options: ChangeOptions,
) {
  await confirmer.confirm(plan, options.yes);
  return plan.apply(currentOperator());
}

function showPassword({ email, password }: OneTimePassword) {
  console.log(
    `\nOne-time password for ${email}, shown once (the user changes it after signing in):\n\n  ${password}\n`,
  );
}

const YES = {
  flags: '-y, --yes',
  description: 'do not ask for confirmation (scripts)',
} as const;

@Injectable()
abstract class Changing extends CommandRunner {
  constructor(
    protected readonly ops: OpsService,
    protected readonly confirmer: Confirmer,
  ) {
    super();
  }
}

@Command({ name: 'tenant:list', description: 'List the tenants' })
@Injectable()
export class TenantListCommand extends CommandRunner {
  constructor(private readonly ops: OpsService) {
    super();
  }
  async run() {
    for (const tenant of await this.ops.tenantList()) {
      console.log(
        [
          tenant.id,
          tenant.slug.padEnd(24),
          `${tenant.members} members`.padEnd(12),
          tenant.active ? 'active' : 'inactive',
          tenant.operator ? 'operators' : '',
        ]
          .join('  ')
          .trimEnd(),
        `  ${tenant.name}`,
      );
    }
  }
}

@Command({
  name: 'user:list',
  arguments: '<tenant>',
  description: "List a tenant's users (id or slug): roles, two-factor",
})
@Injectable()
export class UserListCommand extends CommandRunner {
  constructor(private readonly ops: OpsService) {
    super();
  }
  async run([tenant]: string[]) {
    const { members } = await this.ops.userList(tenant!);
    for (const member of members) {
      console.log(
        [
          member.email.padEnd(36),
          (member.roles.join(',') || '-').padEnd(24),
          member.mfa ? 'mfa' : '   ',
          member.accountActive && member.membershipActive
            ? 'active'
            : 'INACTIVE',
        ].join('  '),
      );
    }
  }
}

@Command({
  name: 'admin:create',
  arguments: '<email>',
  description:
    'Create an administrator of a tenant (a new account gets a one-time password)',
})
@Injectable()
export class AdminCreateCommand extends Changing {
  async run([email]: string[], options: ChangeOptions) {
    const result = await carryOut(
      this.confirmer,
      await this.ops.adminCreate(email!, options),
      options,
    );
    if (!result.changed) {
      return;
    }
    console.log(
      result.created
        ? `Created ${email} as an administrator of "${result.tenant}".`
        : `${email} is now an administrator of "${result.tenant}".`,
    );
    if (result.password) {
      showPassword(result.password);
    }
  }
  @Option(YES) parseYes() {
    return true;
  }
  @Option({
    flags: '-t, --tenant <tenant>',
    description: 'tenant id or slug (optional when there is only one)',
  })
  parseTenant(value: string) {
    return value;
  }
  @Option({ flags: '-n, --name <name>', description: "a new account's name" })
  parseName(value: string) {
    return value;
  }
}

@Command({
  name: 'user:reset-password',
  arguments: '<email>',
  description: 'Set a one-time password and sign the account out everywhere',
})
@Injectable()
export class UserResetPasswordCommand extends Changing {
  async run([email]: string[], options: ChangeOptions) {
    showPassword(
      await carryOut(
        this.confirmer,
        await this.ops.resetPassword(email!),
        options,
      ),
    );
  }
  @Option(YES) parseYes() {
    return true;
  }
}

@Command({
  name: 'user:remove-mfa',
  arguments: '<email>',
  description: "Remove an account's authenticator and recovery codes",
})
@Injectable()
export class UserRemoveMfaCommand extends Changing {
  async run([email]: string[], options: ChangeOptions) {
    const { had } = await carryOut(
      this.confirmer,
      await this.ops.removeMfa(email!),
      options,
    );
    console.log(
      had
        ? `Removed the authenticator and the recovery codes of ${email}.`
        : `${email} had no authenticator.`,
    );
  }
  @Option(YES) parseYes() {
    return true;
  }
}

@Command({
  name: 'user:unlock',
  arguments: '<email>',
  description: 'Clear the failed-code lockout and the mail suppression',
})
@Injectable()
export class UserUnlockCommand extends Changing {
  async run([email]: string[], options: ChangeOptions) {
    const result = await carryOut(
      this.confirmer,
      await this.ops.unlock(email!),
      options,
    );
    console.log(
      `Unlocked ${email}: ${result.failures} failed attempt(s) cleared${result.suppressed ? ', taken off the suppression list' : ''}.`,
    );
  }
  @Option(YES) parseYes() {
    return true;
  }
}

@Command({
  name: 'setting:delete',
  arguments: '<key>',
  description: "Delete a stored setting value (a tenant's, or the platform's)",
})
@Injectable()
export class SettingDeleteCommand extends Changing {
  async run([key]: string[], options: ChangeOptions) {
    const { removed } = await carryOut(
      this.confirmer,
      await this.ops.deleteSetting(key!, options),
      options,
    );
    console.log(
      removed ? `Deleted "${key}".` : `Nothing to delete for "${key}".`,
    );
  }
  @Option(YES) parseYes() {
    return true;
  }
  @Option({
    flags: '-t, --tenant <tenant>',
    description: 'the tenant (id or slug) whose value to delete',
  })
  parseTenant(value: string) {
    return value;
  }
  @Option({
    flags: '-p, --platform',
    description: "delete the operators' platform-wide value",
  })
  parsePlatform() {
    return true;
  }
}

@Command({
  name: 'notifications:settle',
  arguments: '<email>',
  description:
    "Drop a user's undelivered notification backlog (no push or mail), leaving mandatory types",
})
@Injectable()
export class NotificationsSettleCommand extends Changing {
  async run([email]: string[], options: ChangeOptions) {
    const result = await carryOut(
      this.confirmer,
      await this.ops.settleNotifications(email!, options),
      options,
    );
    console.log(
      `Settled ${email}: ${result.messages} message(s) deleted, ${result.notifications} notification(s) marked delivered and read.`,
    );
  }
  @Option(YES) parseYes() {
    return true;
  }
  @Option({
    flags: '-b, --before <date>',
    description: 'only those created before this date (ISO 8601); default all',
  })
  parseBefore(value: string) {
    return value;
  }
}

export const OPS_COMMANDS = [
  TenantListCommand,
  UserListCommand,
  AdminCreateCommand,
  UserResetPasswordCommand,
  UserRemoveMfaCommand,
  UserUnlockCommand,
  SettingDeleteCommand,
  NotificationsSettleCommand,
];
