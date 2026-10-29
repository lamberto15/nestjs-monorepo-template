import { Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { Confirmer } from './confirm.js';
import { currentOperator } from './operator.js';
import {
  type BacklogOptions,
  OpsService,
  type OneTimePassword,
  type Plan,
} from './ops.service.js';

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

@Command({
  name: 'diagnostics',
  description:
    'Show the integrations (database, Redis, workers, mail, storage, realtime): state, driver, hint; --test probes them safely',
})
@Injectable()
export class DiagnosticsCommand extends CommandRunner {
  constructor(private readonly ops: OpsService) {
    super();
  }
  async run(_args: string[], options: { test?: boolean }) {
    for (const item of await this.ops.diagnostics()) {
      let line = [
        item.check.padEnd(10),
        item.state.padEnd(13),
        (item.driver ?? '-').padEnd(12),
        item.detail ?? '',
      ]
        .join('  ')
        .trimEnd();
      if (options.test && item.testable) {
        const result = await this.ops.testDiagnostic(
          item.check,
          currentOperator(),
        );
        line += `\n  test: ${result.ok ? 'ok' : `FAILED ${result.detail}`} (${result.durationMs} ms)`;
        if (!result.ok) process.exitCode = 1;
      } else if (
        item.state === 'unavailable' ||
        item.state === 'unconfigured'
      ) {
        process.exitCode = 1;
      }
      console.log(item.hint ? `${line}\n  hint: ${item.hint}` : line);
    }
  }
  @Option({
    flags: '-t, --test',
    description:
      'also run the safe tests (SMTP connect and QUIT, a storage probe file written, read and deleted)',
  })
  parseTest() {
    return true;
  }
}

/** The `backlog:*` commands' scope options. */
@Injectable()
abstract class BacklogCommand extends Changing {
  @Option({
    flags: '-t, --tenant <tenant>',
    description: "one tenant's backlog (id or slug)",
  })
  parseTenant(value: string) {
    return value;
  }
  @Option({
    flags: '-g, --global',
    description: "every tenant's backlog (and the accounts' own)",
  })
  parseGlobal() {
    return true;
  }
  @Option({
    flags: '--topic <topic>',
    description: 'only this outbox topic (notifications.deliver, …)',
  })
  parseTopic(value: string) {
    return value;
  }
  @Option({
    flags: '--type <type>',
    description: 'only this notification type (note.published, …)',
  })
  parseType(value: string) {
    return value;
  }
  @Option({
    flags: '--template <mail>',
    description: 'only this mail class (NotificationMail, …)',
  })
  parseTemplate(value: string) {
    return value;
  }
  @Option({
    flags: '-b, --before <date>',
    description: 'only what was created before this date (ISO 8601)',
  })
  parseBefore(value: string) {
    return value;
  }
}

@Command({
  name: 'backlog:count',
  description:
    'Count the outbox and mail backlog of --tenant or --global (a dry run: changes nothing)',
})
@Injectable()
export class BacklogCountCommand extends BacklogCommand {
  async run(_args: string[], options: BacklogOptions) {
    const { outbox, mail } = await this.ops.backlogPreview(options);
    console.log(
      `Outbox: ${outbox.pending.total} pending, ${outbox.deadLetters.total} dead letter(s), ${outbox.leased} being delivered`,
    );
    for (const [label, part] of [
      ['pending', outbox.pending],
      ['dead', outbox.deadLetters],
    ] as const) {
      for (const group of part.groups) {
        console.log(
          `  ${label.padEnd(8)}  ${String(group.count).padStart(8)}  ${group.topic}${group.type ? ` ${group.type}` : ''}${group.mandatory ? '  (mandatory: kept)' : ''}`,
        );
      }
    }
    console.log(`Mail queue:${mail.capped ? ' (more than counted)' : ''}`);
    for (const group of mail.groups) {
      console.log(
        `  ${group.state.padEnd(11)}  ${String(group.count).padStart(8)}  ${group.template}${group.essential ? `  (${group.essential} essential: kept)` : ''}`,
      );
    }
  }
}

@Command({
  name: 'backlog:discard',
  arguments: '<target>',
  description:
    'Discard the outbox or mail backlog (target: outbox | mail) of --tenant or --global, in batches; never mandatory or essential, audited',
})
@Injectable()
export class BacklogDiscardCommand extends BacklogCommand {
  async run([target]: string[], options: BacklogOptions & ChangeOptions) {
    const { count } = await carryOut(
      this.confirmer,
      await this.ops.backlogAction('discard', target!, options),
      options,
    );
    console.log(`Discarded ${count}.`);
  }
  @Option(YES) parseYes() {
    return true;
  }
}

@Command({
  name: 'backlog:retry',
  arguments: '<target>',
  description:
    'Retry the failed backlog (outbox: dead letters; mail: failed jobs) of --tenant or --global, audited',
})
@Injectable()
export class BacklogRetryCommand extends BacklogCommand {
  async run([target]: string[], options: BacklogOptions & ChangeOptions) {
    const { count } = await carryOut(
      this.confirmer,
      await this.ops.backlogAction('retry', target!, options),
      options,
    );
    console.log(`Retried ${count}.`);
  }
  @Option(YES) parseYes() {
    return true;
  }
}

@Command({
  name: 'queue:pause',
  arguments: '<name>',
  description:
    'Pause a queue for every worker (mail, …): jobs wait in Redis, audited',
})
@Injectable()
export class QueuePauseCommand extends Changing {
  async run([name]: string[], options: ChangeOptions) {
    await carryOut(
      this.confirmer,
      await this.ops.queueSwitch(name!, true),
      options,
    );
    console.log(`Paused "${name}".`);
  }
  @Option(YES) parseYes() {
    return true;
  }
}

@Command({
  name: 'queue:resume',
  arguments: '<name>',
  description: 'Resume a paused queue, audited',
})
@Injectable()
export class QueueResumeCommand extends Changing {
  async run([name]: string[], options: ChangeOptions) {
    await carryOut(
      this.confirmer,
      await this.ops.queueSwitch(name!, false),
      options,
    );
    console.log(`Resumed "${name}".`);
  }
  @Option(YES) parseYes() {
    return true;
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
  DiagnosticsCommand,
  BacklogCountCommand,
  BacklogDiscardCommand,
  BacklogRetryCommand,
  QueuePauseCommand,
  QueueResumeCommand,
];
