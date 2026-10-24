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
