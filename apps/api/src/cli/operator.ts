import { hostname, userInfo } from 'node:os';

/** Who runs a command, as the audit entries name them. */
export interface Operator {
  /** The OS user of the shell (`ubuntu`, `root`). */
  user: string;
  /** The host (a container's id under `docker compose run`). */
  host: string;
}

/** The OS user and host of this process; `unknown` where the OS can't say (a user without an entry in /etc/passwd). */
export function currentOperator(): Operator {
  let user = process.env.USER ?? process.env.LOGNAME ?? 'unknown';
  try {
    user = userInfo().username;
  } catch {
    // keep the environment's
  }
  return { user, host: hostname() };
}
