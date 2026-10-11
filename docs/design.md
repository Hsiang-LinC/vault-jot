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
- Injecting vault content into every prompt (see the vault's "Eager Context Loading" pitfall). A bounded index of titles at the start of a conversation is not that: see Decisions (M5).

## Features and roadmap

| # | Feature | Mechanism | Milestone |
|---|---|---|---|
| 1 ✅ | `/jot <text>` with optional kind prefix (`idea:`, `read:`, `plugin:`, `til:`, `pitfall:`) writes a timestamped inbox file with provenance | slash command, `$.fs` | M1 |
| 3 ✅ | Inbox backlog as a prompt-footer label (`📥 inbox 4 · 9d`); band with an ingest button past a threshold | `SessionMode` label, `AbovePrompt` band, `$.clock` | M1 |
| 2 ✅ | `/jot` with no text drafts a capture from the recent turns into the prompt for review; `/jot <kind>:` drafts that kind; `/jot summary` previews a multi-line summary of the whole discussion in a pane to save, edit or discard | `$.model.fork`, `$.prompt.fill` | M2 |
| 5 ✅ | `/incubate [idea]`: decide on an idea (choose an option or type a decision), expand it, or export it as a design doc to the session's repo | pane, `$.prompt.submit` hand-off | M3 |
| 4 ✅ | Same pane: shelves → notes → note navigation over ideas and the reading list; mark reading items reading / done / dropped | pane, `ui.render` | M3 |
| 7 ✅ | `improve @<target>:` captures app feedback; ingested as an `idea` with `target`; `🛠 <repo> N` footer label in a matching repo | `parseJot`, `SessionMode` label | M4 |
| 8 ✅ | Hand off an idea to its repo through the repo's own harness skills (design doc as fallback); Review layer: open ideas per app, stale seeds | pane, `$.prompt.submit` | M4 |
| 9 ✅ | Related-notes index: at a conversation's start, the titles of captures and ideas aimed at the session's repo, plus other inbox titles, so Claude can point out a note that bears on the work; `@<target>` on any kind | `prompt.context`, `parseJot` | M5 |
| 6 | Suggest-only "worth noting?" toasts after a fail→fix sequence or a plugin install | `tool.call`, `$.ui.toast` | Later, if not noisy |

## Configuration

- `vaultPath` (`userConfig`): absolute or `~/` path to the vault root. Unset, `/jot` refuses and the status line says so; a missing `inbox/` is refused rather than created, since `$.fs.write` would otherwise create a stray vault at a mistyped path.
- `backlogCount` (10) and `backlogDays` (7): band thresholds.

## Decisions (M1)

- Capture format: `inbox/jot-<YYYYMMDD-HHMMSS>-<kind>-<slug>.md`, local time; flat frontmatter `title`, `kind`, `captured` (ISO with offset), `origin_cwd`, `origin_repo`, `origin_branch`, `origin_session`. Unknown origin fields are omitted, not faked. Same-second name clashes get a `-2`…`-5` suffix; never overwrite.
- Kinds (`idea`, `read`, `til`, `pitfall`, `plugin`, `note`) mirror the vault's Vault Guide "Capture Kinds" table, which owns how ingest files each kind.
- Backlog is recounted at session start, after each `/jot`, and after each main-agent turn (one directory listing); no timer.
- The backlog is a `SessionMode` footer label, not `$.ui.status`: the engine prefixes every pinned status with a `!` notice marker the API cannot change, which reads as an error. The status line carries only real problems (vault unset or unreadable).
- Band "Hide" lasts for the session only, so a stale inbox nudges again next session.
- Every request for Claude (ingest, and each incubate action) is a background subagent of the session (`$.agent.spawn`), never a typed prompt: it cannot interrupt a turn in progress or land in the prompt box. Vault requests run with the vault as cwd, a hand-off with the repo. The subagent uses the session's permission mode, so an ask it raises surfaces like any other; its end is matched by `agentId` on `turn.complete` for a toast. Cost: no review before the request runs, and the result is a toast line, not a transcript row. A fully independent session (`claude -p` via `$.process.spawn`) was left out: it has no way to ask permission, so it would need a blanket permission bypass.

## Decisions (M2, M3)

- `/recall` answers land in the incubate pane, not the conversation: a subagent's reply can be long or wrong, and an appended row cannot be taken back, so **Add to chat** (`$.session.append`) is the person's call. The subagent is read-only and uses claude-obsidian's own query skills rather than a search the mod would have to keep correct. Results live in mod state (last 10, session only); persisting them would mean `$.store`. Unlike ingest, a recall needs the subagent's id to collect its answer, so a spawn without one fails loudly.
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

## Decisions (M5)

- A note's subject is its `target` (the repo folder name), not where it was captured: `origin_repo` records where the thought came up, which is often another repo. Any kind may carry `@<target>`, extending the `improve` convention instead of adding tags; drafts ask the model to fill it in, since it knows what the conversation is about.
- The index is a context block of the conversation's first message (`prompt.context`), computed once: it rides along every later request like the rest of the transcript, but it is a snapshot, not a section re-rendered as the inbox changes. Notes captured during the session are already in the conversation. It is re-read on compaction and `/clear`.
- Lazy loading, not eager: titles and file paths only, bounded (15 notes for the repo, 20 other inbox titles), bodies read on demand. Notes for the repo match `target` exactly (case-insensitive); the rest is left to the model's judgment from titles. Matching on `origin_repo` was rejected for the reason above.
- `/jot` as it is typed: the engine has no argument completion (`argumentHint` is fixed, `$.prompt.suggest` only shows in an empty box), so a `prompt.edit` hook paints the kind and target as they are typed, as a shell paints a command (green on an exact match, red for a near miss of a kind, plain while still a prefix or plain text; an unknown target is allowed, so never red) and the `PromptHint` tail lists the candidates; the tail is drawn on the terminal only. A kind within two edits of a known one is refused at run time instead of becoming a `note`; words further off (`Remember:`, `https:`) stay text. On the desktop, which draws no hint line, the candidates take the place of the inbox labels at the right of the band, so nothing appears or jumps. Tab completion was tried and removed: the engine takes Tab in a slash command before `prompt.edit` sees it.
- Outside a repo, or in the vault itself, only the inbox titles are listed; with nothing to list there is no block.

## Open questions

- Resolved 2026-10-06: the vault is a personal knowledge base; `idea` and `reading` types with lifecycles now exist (`wiki/ideas/`, `wiki/reading/`).
- Resolved 2026-10-06: pane actions hand off to Claude; the mod is never a second writer under `wiki/`.
