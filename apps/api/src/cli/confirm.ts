import { Injectable } from '@nestjs/common';
import { InquirerService, Question, QuestionSet } from 'nest-commander';
import type { Plan } from './ops.service.js';

/** The one question every command asks (nest-commander's prompts: inquirer). */
@QuestionSet({ name: 'ops-confirm' })
export class ConfirmQuestions {
  @Question({
    type: 'confirm',
    name: 'proceed',
    message: 'Proceed?',
    default: false,
  })
  parseProceed(value: boolean) {
    return value;
  }
}

/** Raised when the operator declines, or a script forgot `--yes`. */
export class NotConfirmed extends Error {}

/**
 * Shows what a command will do and asks before it does it. `--yes` skips
 * the question (scripts); without it a terminal is needed, so a pipeline
 * that forgot the flag stops instead of hanging or guessing.
 */
@Injectable()
export class Confirmer {
  constructor(private readonly inquirer: InquirerService) {}

  async confirm<T>(plan: Plan<T>, yes: boolean | undefined): Promise<void> {
    for (const line of plan.summary) {
      console.log(line);
    }
    if (yes) {
      return;
    }
    if (!process.stdin.isTTY) {
      throw new NotConfirmed(
        'No terminal to ask on: run with -it (docker compose run without -T), or pass --yes.',
      );
    }
    const { proceed } = await this.inquirer.ask<{ proceed: boolean }>(
      'ops-confirm',
      undefined,
    );
    if (!proceed) {
      throw new NotConfirmed('Nothing was changed.');
    }
  }
}
