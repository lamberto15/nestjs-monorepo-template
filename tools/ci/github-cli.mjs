import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Release tooling holds a GitHub token. Resolve gh only from standard system
// installations, never from a repository directory prepended to PATH.
export function githubCli() {
  const locations =
    process.platform === 'darwin'
      ? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']
      : ['/usr/bin/gh', '/usr/local/bin/gh'];
  const binary = locations.find((location) => existsSync(location));
  if (!binary)
    throw new Error('Install the GitHub CLI in a standard system location');
  return binary;
}

/**
 * Runs a command (gh from githubCli()) and returns its output. The buffer is
 * large: a page of 100 workflow runs from the API is more than Node's 1 MB
 * default, which failed the promotion of v0.1.0 with ENOBUFS.
 */
export function execute(command, args) {
  return execFileSync(command === 'gh' ? githubCli() : command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}
