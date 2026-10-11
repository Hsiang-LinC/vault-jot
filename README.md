# vault-jot

A Claude Code plugin for capturing thoughts into an Obsidian vault without leaving the session you are working in, and for keeping the vault's inbox from going stale.

Design and roadmap: [docs/design.md](docs/design.md).

## Use

Most of the time, just write the thought:

```text
/jot Obsidian Bases can group by any property
/jot https://example.com/long-post — recommended in the hooks thread
```

With no kind it is saved as `note`, and ingest decides what it becomes (idea, concept, pitfall, reading, ...) from the text and its origin. Prefix a kind when you already know, or when it needs a target:

```text
/jot idea: a mod that turns jots into design docs
/jot improve @cx: make the panel smaller and navigable by layer
/jot read: https://example.com/long-post — recommended in the hooks thread
/jot til: Obsidian Bases can group by any property
/jot pitfall: fs.write creates missing parent directories
/jot plugin: claude-obsidian — lint is fast, the router ignores custom types
```

Each capture becomes `inbox/jot-<YYYYMMDD-HHMMSS>-<kind>-<slug>.md` in the vault, with flat frontmatter: `title`, `kind`, `captured`, and the origin (`origin_cwd`, `origin_repo`, `origin_branch`, `origin_session`). `/jot` runs immediately, even mid-turn. Kinds and how ingest files them are defined in the vault's Vault Guide ("Capture Kinds").

`improve @<target>:` is a change to make to an app. `<target>` is the repo's folder name, so a session in that repo can find it; leave it out when the jot is not about one app. Ingest files it as an `idea` with a `target`.

The prompt footer shows the backlog (`📥 inbox 4 · 9d`), and `🛠 cx 3` when a session runs in a repo that has open ideas targeting it; problems such as an unset or unreadable `vaultPath` go to the status line instead. When the inbox reaches `backlogCount` captures or its oldest is `backlogDays` old, a band above the prompt offers **Ingest** (runs ingest in a background subagent) and **Hide** (for this session).

`/jot ingest` does the same on demand, at any backlog size: it starts the ingest subagent right away. An empty inbox says so and starts nothing. Text that merely starts with the word (`/jot ingest is slow`) is still captured.

### Recall from the vault

`/recall <question>` sends a read-only background subagent into the vault, where it searches with claude-obsidian's `wiki-query` (and `wiki-retrieve` when needed). Its answer, with the notes it rests on, waits in the incubate pane under **Recall** (`c`); a toast says when it is ready. Nothing enters your conversation until you press **Add to chat**, which appends it to the session for the model to read on its next turn. `/recall` alone opens the answers. The last 10 are kept for the session; an answer is cut at 20,000 characters.

### Draft from the conversation

Any kind can name the repo it is about: `/jot note @usage-band: add a toggle command`. That `target` is the note's subject, which may differ from the repo you were in when you jotted it; drafts fill it in when the conversation is about a specific repo.

While you type `/jot`, the kind and `@target` turn green when known and a mistyped kind turns red; on the terminal the hint line under the prompt lists the kinds or targets that match what you have typed. A mistyped kind (`/jot iddea: …`) is refused rather than saved as a note.

Each conversation starts with a short index of vault notes for Claude: captures and open ideas whose `target` is the session's repo, then the other inbox titles (titles and paths only, bounded). When your work relates to one of them, Claude says so and names the file.

`/jot` with no text asks a fork of the conversation for the one thing worth keeping from the last few turns, and puts it in your prompt as `/jot <kind>: <draft>`. A kind alone (`/jot pitfall:`, `/jot improve @cx:`) drafts that kind. Edit the draft and press Enter to save, or clear it. Nothing is saved until you do.

`/jot summary` summarizes the whole discussion instead: a title line with the insight, then the question, the wrong turns and what corrected them, and where you landed. It opens in a **Summary draft** pane: **Save** (`s`) writes it to the inbox, **Edit in prompt** (`e`) moves it into your prompt as a `/jot` command, **Discard** (`d`) drops it. The fork always reads the whole transcript; only its prompt decides what it looks at.

### Incubate

`/incubate` opens a small pane you move through layer by layer:

```text
Shelves            🌱 Ideas 2   📖 Reading 1   Review
└ Ideas            ‹ Shelves · 🌱 Replay Mode · developing · 🌱 Smaller Panel @cx · seed
  └ Replay Mode    open questions, options [Choose], a Decision box, [Expand], [Hand off to <repo>]
└ Reading
  └ Hooks Post     url, [Reading] [Done] [Drop]
└ Review           open ideas per app, seeds waiting 14+ days
```

`/incubate <title>` jumps straight to an idea. Every change is handed to a background subagent of the session, so the turn you are in is never interrupted; a toast says when it starts and finishes (recorded under "## Decisions", status moves, idea handed off to the repo), so claude-obsidian stays the only writer under `wiki/`. Within a state, ideas group by target.

**Hand off** appears when the session is in a repo other than the vault. If the repo has a harness (`docs/harness/index.md`), Claude uses that repo's `to-issues` (or `to-prd`) skill; otherwise it writes `docs/design/<title>.md`. Either way the idea gets `handoff:` (what was created), `project:`, and `status: archived`. Hotkeys: `b` back, `i`/`r`/`v` shelves and review, `1`–`9` choose an option, `e` expand, `x` hand off or drop.

## Configure

In `/config`, under vault-jot:

| Field | Default | Meaning |
|---|---|---|
| `vaultPath` | (unset) | Vault root, absolute or `~/...`. Required; `/jot` refuses and the status line says so until it is set. |
| `backlogCount` | 10 | Band threshold by count. |
| `backlogDays` | 7 | Band threshold by age of the oldest capture. |

The mod never creates `inbox/`: a missing one means a wrong `vaultPath`, and the capture is refused rather than written elsewhere.

## Install

The repo is its own plugin marketplace (`.claude-plugin/marketplace.json`).

From GitHub (the repo is private, so git must be able to clone it, e.g. after `gh auth setup-git`):

```sh
claude plugin marketplace add Hsiang-LinC/vault-jot
claude plugin install vault-jot@vault-jot
```

From a local clone, read live from the folder (after an edit, run `/reload-plugins`):

```sh
claude plugin marketplace add ~/Developer/personal/vault-jot
claude plugin install vault-jot@vault-jot
```

Then set the vault path, in Claude Code with `/plugin configure vault-jot@vault-jot`, or:

```sh
echo '{"vaultPath":"~/Developer/personal/notes"}' | claude plugin configure vault-jot@vault-jot --values-stdin
```

Update a GitHub install with `claude plugin marketplace update vault-jot` then `claude plugin update vault-jot@vault-jot`. Install it one way only: the same plugin also loaded through `--plugin-dir` or a mods folder runs twice.

For a one-off session without installing: `claude --plugin-dir ~/Developer/personal/vault-jot`.

## Develop

```sh
claude plugin validate .
claude plugin test .
tsc -p .   # once the engine has loaded the mod and written .claude-plugin/types/
```

`hooks/core.ts` (captures, backlog), `hooks/notes.ts` (reading notes) and `hooks/handoff.ts` (prompts for the subagents) are pure; `hooks/register.tsx` is the only module that talks to Claude Code, because the engine follows `$` only into functions declared in the hooks module itself.
