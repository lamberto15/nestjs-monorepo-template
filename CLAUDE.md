# Claude Code instructions

@AGENTS.md

Shared project rules live in `AGENTS.md`; update that file for changes that apply
to every agent. Keep only Claude-specific settings here.

## Claude model selection

- **Models for Claude: never Fable.** Subagents and delegated tasks use the
  cheapest model that does the job well: Haiku 5.5 for simple searches and
  mechanical edits, Sonnet 5.5 for ordinary coding and exploration, Opus 5.5
  only for complex or security work (and the main session). Set `model` on
  every Agent call.
