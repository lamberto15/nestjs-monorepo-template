import { Module } from '@nestjs/common';
import { AppModule } from '../app.module.js';
import { ConfirmQuestions, Confirmer } from './confirm.js';
import { OPS_COMMANDS } from './ops.commands.js';
import { OpsService } from './ops.service.js';

/**
 * What the operator CLI adds to the app (IAM's and the platform's services
 * are global): the commands, their logic and the one question they ask.
 */
export const OPS_PROVIDERS = [
  OpsService,
  Confirmer,
  ConfirmQuestions,
  ...OPS_COMMANDS,
];

/**
 * The app with the operator commands: what `pnpm ops` boots (run.ts), never
 * the API or the worker.
 */
@Module({
  imports: [AppModule],
  providers: OPS_PROVIDERS,
})
export class OpsModule {}
