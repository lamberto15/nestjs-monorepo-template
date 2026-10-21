// First: .env.development into process.env (as main.ts), NODE_ENV included.
import '../dev-env.js';
import { CommandFactory } from 'nest-commander';
import { createLogger } from '../core/logging/logging.js';
import { NotConfirmed } from './confirm.js';
import { OpsModule } from './ops.module.js';
import { OpsError } from './ops.service.js';

/** A refusal is a message and an exit code, not a stack. */
const fail = (error: unknown) => {
  if (error instanceof OpsError || error instanceof NotConfirmed) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  throw error;
};

await CommandFactory.run(OpsModule, {
  // The app's logger (its redaction included), warnings and errors only.
  logger: createLogger(process.env, { logLevels: ['warn', 'error', 'fatal'] }),
  cliName: 'ops',
  usePlugins: false,
  serviceErrorHandler: fail,
});
