# vault-jot

A Claude Code mod for capturing thoughts into an Obsidian vault without leaving the session you are working in, and for keeping the vault's inbox from going stale.

Design and roadmap: [docs/design.md](docs/design.md).

## Use

```text
/jot idea: a mod that turns jots into design docs
/jot read: https://example.com/long-post — recommended in the hooks thread
/jot til: Obsidian Bases can group by any property
/jot pitfall: fs.write creates missing parent directories
/jot plugin: claude-obsidian — lint is fast, the router ignores custom types
/jot just a loose thought
```

Each capture becomes `inbox/jot-<YYYYMMDD-HHMMSS>-<kind>-<slug>.md` in the vault, with flat frontmatter: `title`, `kind`, `captured`, and the origin (`origin_cwd`, `origin_repo`, `origin_branch`, `origin_session`). `/jot` runs immediately, even mid-turn. Kinds and how ingest files them are defined in the vault's Vault Guide ("Capture Kinds").

The prompt footer shows the backlog (`📥 inbox 4 · 9d`); problems such as an unset or unreadable `vaultPath` go to the status line instead. When the inbox reaches `backlogCount` captures or its oldest is `backlogDays` old, a band above the prompt offers **Ingest** (fills the prompt with an ingest request to review and send) and **Hide** (for this session).

## Configure

In `/config`, under vault-jot:

| Field | Default | Meaning |
|---|---|---|
| `vaultPath` | (unset) | Vault root, absolute or `~/...`. Required; `/jot` refuses and the status line says so until it is set. |
| `backlogCount` | 10 | Band threshold by count. |
| `backlogDays` | 7 | Band threshold by age of the oldest capture. |

The mod never creates `inbox/`: a missing one means a wrong `vaultPath`, and the capture is refused rather than written elsewhere.

## Load

```sh
claude --plugin-dir ~/Developer/personal/vault-jot
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Develop

```sh
claude plugin validate .
claude plugin test .
tsc -p .   # once the engine has loaded the mod and written .claude-plugin/types/
```

`hooks/core.ts` is the pure logic; `hooks/register.tsx` is the shell that talks to Claude Code.
