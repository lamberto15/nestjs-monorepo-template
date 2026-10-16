// Conventional Commits (https://www.conventionalcommits.org), checked by
// commitlint: the commit-msg hook (lefthook.yml) checks each commit; CI
// (.github/workflows/commit-messages.yml) a pull request's title, and its
// commit's subject when it has only one: the squash merge takes that one as
// main's commit subject (COMMIT_OR_PR_TITLE), the title otherwise.
//
// `type(scope)!: subject`, the types of @commitlint/config-conventional: feat,
// fix, docs, refactor, perf, test, build, ci, chore, style, revert. Any scope,
// several with commas (`fix(iam,usage): …`). Git's `Revert "…"` passes.
export default {
  extends: ['@commitlint/config-conventional'],
  // commitlint's default ignores let merge commits (`Merge remote-tracking
  // branch 'origin/main' …`) through the hook. In CI they're off: a title or
  // squashed subject like `Merge pull request …`, `fixup! …` or `v1.2.3`
  // would land on main as it is.
  defaultIgnores: !process.env.GITHUB_ACTIONS,
  ignores: [(message) => message.startsWith('Revert "')],
  rules: {
    // Subjects may start with a name (`Prometheus alert rules…`).
    'subject-case': [0],
    // Room for the subjects main already has; GitHub appends ` (#123)`.
    'header-max-length': [2, 'always', 120],
    // URLs and quoted output in bodies and trailers aren't wrapped.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
