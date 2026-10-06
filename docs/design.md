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
| 1 ✅ | `/jot <text>` with optional kind prefix (`idea:`, `read:`, `plugin:`, `til:`, `pitfall:`) writes a timestamped inbox file with provenance | slash command, `$.fs` | M1 |
| 3 ✅ | Inbox backlog as a prompt-footer label (`📥 inbox 4 · 9d`); band with an ingest button past a threshold | `SessionMode` label, `AbovePrompt` band, `$.clock` | M1 |
| 2 ✅ | `/jot` with no text drafts a capture from the conversation into the prompt for review | `$.model.fork`, `$.prompt.fill` | M2 |
| 5 ✅ | `/incubate [idea]`: decide on an idea (choose an option or type a decision), expand it, or export it as a design doc to the session's repo | pane, `$.prompt.submit` hand-off | M3 |
| 4 ✅ | Same pane: shelves → notes → note navigation over ideas and the reading list; mark reading items reading / done / dropped | pane, `ui.render` | M3 |
| 7 ✅ | `improve @<target>:` captures app feedback; ingested as an `idea` with `target`; `🛠 <repo> N` footer label in a matching repo | `parseJot`, `SessionMode` label | M4 |
| 8 ✅ | Hand off an idea to its repo through the repo's own harness skills (design doc as fallback); Review layer: open ideas per app, stale seeds | pane, `$.prompt.submit` | M4 |
| 6 | Suggest-only "worth noting?" toasts after a fail→fix sequence or a plugin install | `tool.call`, `$.ui.toast` | Later, if not noisy |

## Configuration

- `vaultPath` (`userConfig`): absolute or `~/` path to the vault root. Unset, `/jot` refuses and the status line says so; a missing `inbox/` is refused rather than created, since `$.fs.write` would otherwise create a stray vault at a mistyped path.
- `backlogCount` (10) and `backlogDays` (7): band thresholds.

## Decisions (M1)

- Capture format: `inbox/jot-<YYYYMMDD-HHMMSS>-<kind>-<slug>.md`, local time; flat frontmatter `title`, `kind`, `captured` (ISO with offset), `origin_cwd`, `origin_repo`, `origin_branch`, `origin_session`. Unknown origin fields are omitted, not faked. Same-second name clashes get a `-2`…`-5` suffix; never overwrite.
- Kinds (`idea`, `read`, `til`, `pitfall`, `plugin`, `note`) mirror the vault's Vault Guide "Capture Kinds" table, which owns how ingest files each kind.
- Backlog is recounted at session start, after each `/jot`, and after each main-agent turn (one directory listing); no timer.
- The backlog is a `SessionMode` footer label, not `$.ui.status`: the engine prefixes every pinned status with a `!` notice marker the API cannot change, which reads as an error. The status line carries only real problems (vault unset or unreadable).
- Band "Hide" lasts for the session only, so a stale inbox nudges again next session. "Ingest" fills the prompt instead of submitting, so the person reviews it.

## Decisions (M2, M3)

- The mod never writes under `wiki/`. Decisions, expansions, exports and reading-state changes are prompts to Claude (`hooks/handoff.ts`), which edits through claude-obsidian; the pane only reads notes. Cost: each change is a Claude turn.
- The `/jot` draft is filled into the prompt, not saved: the person accepts or edits it with Enter.
- `/incubate` is one pane navigated in layers (shelves → notes → note) rather than separate commands; it re-reads notes on each draw (at most 200 per shelf) and redraws after each turn, so it shows what Claude last wrote.
- Export targets the session's repo (`$.session.repo()`), shown only when that is not the vault, instead of a typed path.
- Engine constraints that shape the code: one `session.start` hook per plugin, and `$` is followed only into functions declared in the hooks module, so all shell code lives in `register.tsx` and the other modules stay pure.

## Decisions (M4)

- App feedback is an `idea` with `target`, not a new note type: it has the same lifecycle, and the vault stays one second brain with `/incubate` as the place app work happens. A separate type would be justified only if the lifecycles diverge.
- `target` is the repo folder name; there is no mapping table to maintain. Matching is case-insensitive.
- Hand-off replaces export. The repo side is the repo's own business (`docs/harness/index.md` present → its tracker skills; absent → a design doc). The vault side is fixed: `handoff:`, `project:`, `status: archived`.
- Review is a pane layer, not a scheduled nudge: the inbox band already nudges, and a weekly timer would be a second reminder to ignore. Revisit if reviews get skipped.
- Cost: the footer count reads the ideas shelf (up to 200 notes) on each refresh when the session is in a repo.

## Open questions

- Resolved 2026-10-06: the vault is a personal knowledge base; `idea` and `reading` types with lifecycles now exist (`wiki/ideas/`, `wiki/reading/`).
- Resolved 2026-10-06: pane actions hand off to Claude; the mod is never a second writer under `wiki/`.
