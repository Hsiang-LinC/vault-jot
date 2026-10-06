# vault-jot

A Claude Code mod for capturing thoughts into an Obsidian vault without leaving the session you are working in, and for keeping the vault's inbox from going stale.

Status: design. See [docs/design.md](docs/design.md).

## Loading during development

```sh
claude --plugin-dir ~/Developer/personal/vault-jot
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.
