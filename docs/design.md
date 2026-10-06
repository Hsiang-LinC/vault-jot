# vault-jot design

## Problem

Useful thoughts surface mid-session: a lesson from building an app, a take on a plugin, something to read, a half-formed idea for a project. Filing them properly breaks flow, so they are lost. The vault (`~/Developer/personal/notes`, claude-obsidian layout) already has a capture → ingest → promote loop; what is missing is a near-zero-cost capture step that works from any repo, and a nudge to run the rest of the loop.

## Goals

- Capture in one command from any Claude Code session, without interrupting the turn.
- Record provenance automatically (repo, branch, session, date) so ingestion can trace a note to its origin.
- Respect the vault contract: write only raw captures to `inbox/`; never write to `wiki/` or `.raw/` directly.
- Surface inbox backlog so captures get ingested.

## Non-goals

- Replacing claude-obsidian's `wiki-ingest` or `save`. vault-jot captures; claude-obsidian curates.
- Injecting vault content into every prompt (see the vault's "Eager Context Loading" pitfall).

## Features and roadmap

| # | Feature | Mechanism | Milestone |
|---|---|---|---|
| 1 | `/jot <text>` with optional kind prefix (`idea:`, `read:`, `plugin:`, `til:`, `pitfall:`) writes a timestamped inbox file with provenance | slash command, `$.fs` | M1 |
| 3 | Inbox backlog in the status line (`inbox: 4 · oldest 9d`); band with an ingest button past a threshold | `$.ui.status`, `AbovePrompt` band, `$.clock` | M1 |
| 2 | `/jot` with no text drafts a note from the last exchange for review | `$.model` | M2 |
| 5 | `/incubate <idea>` grows a seed into a design-doc skeleton; `--export <repo>` copies it into a project's `docs/` | slash command, `$.model`, `$.fs` | M3 |
| 4 | Ideas pane: browse seeds and the reading list, open / promote / mark read / drop | pane, `ui.render` | M3 |
| 6 | Suggest-only "worth noting?" toasts after a fail→fix sequence or a plugin install | `tool.call`, `$.ui.toast` | Later, if not noisy |

## Configuration

- `vaultPath` (`userConfig`, required): absolute path to the vault root. The mod fails loudly if `inbox/` is missing there rather than writing elsewhere.
- Backlog thresholds (count, age in days) with defaults.

## Open questions

- Vault scope: the vault describes itself as a knowledge base for agentic systems; ideas, reading lists, and opinions need a defined home and lifecycle after ingest before features 4 and 5 can target them.
- Capture file format: filename scheme, and whether captures carry minimal frontmatter (`kind`, `captured`, `origin`) for ingest to read.
- Ownership of "promote" in the ideas pane: should it invoke `wiki-ingest`, or only queue the item?
