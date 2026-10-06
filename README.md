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

### Draft from the conversation

`/jot` with no text asks a fork of the conversation for the one thing worth keeping, and puts it in your prompt as `/jot <kind>: <draft>`. Edit it and press Enter to save, or clear it. Nothing is saved until you do.

### Incubate

`/incubate` opens a small pane you move through layer by layer:

```text
Shelves            🌱 Ideas 2   📖 Reading 1
└ Ideas            ‹ Shelves · 🌱 Replay Mode · developing · 🌱 Band Snooze · seed
  └ Replay Mode    open questions, options [Choose], a Decision box, [Expand], [Export to <repo>]
└ Reading
  └ Hooks Post     url, [Reading] [Done] [Drop]
```

`/incubate <title>` jumps straight to an idea. Every change is handed to Claude as a prompt (recorded under "## Decisions", status moves, design doc exported to `<repo>/docs/design/`), so claude-obsidian stays the only writer under `wiki/`. Export appears when the session is in a repo other than the vault. Hotkeys: `b` back, `i`/`r` shelves, `1`–`9` choose an option, `e` expand, `x` export or drop.

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

`hooks/core.ts` (captures, backlog), `hooks/notes.ts` (reading notes) and `hooks/handoff.ts` (prompts for Claude) are pure; `hooks/register.tsx` is the only module that talks to Claude Code, because the engine follows `$` only into functions declared in the hooks module itself.
