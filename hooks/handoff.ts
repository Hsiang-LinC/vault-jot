// Pure builders for what vault-jot asks Claude to do. The mod never writes
// under wiki/: claude-obsidian is the single writer there, so changes to
// maintained notes are handed to Claude as prompts built here.

import { KINDS, parseJot } from './core'
import type { Jot } from './core'

const DRAFT_MAX = 500

const rules = (vault: string) =>
  `Work in the vault at ${vault}: follow its CLAUDE.md and wiki/meta/Vault Guide.md, set \`updated\` to today, and record the change in wiki/log.md.`

// What the inbox band's Ingest button and `/jot ingest` both fill into the prompt.
export const ingestPrompt = (inbox: string) =>
  `Ingest the captures in ${inbox} with claude-obsidian wiki-ingest (batch).`

export function expandPrompt(vault: string, notePath: string): string {
  return [
    `Incubate the idea note ${notePath}.`,
    `Fill in "Why It's Interesting", "Open Questions" (concrete and answerable), "Options" (2-3 list items, one line each with its tradeoff), and "Next Step", from the note and anything related in the vault.`,
    `If its status is seed, set it to developing.`,
    rules(vault),
  ].join(' ')
}

export function decisionPrompt(vault: string, notePath: string, decision: string): string {
  return [
    `Record a decision on the idea note ${notePath}: ${JSON.stringify(decision)}.`,
    `Add it as a dated list item under a "## Decisions" section, remove open questions it answers, and update "Next Step".`,
    `If the decision drops the idea, set status: archived and keep the reason; if it makes the idea ready to start, set status: mature.`,
    rules(vault),
  ].join(' ')
}

// Where a handed-off idea lands depends on the target repo: with a harness
// (`docs/harness/index.md`) its own tracker skills decide the artifact; without
// one, a design doc. Either way the vault side is fixed: `handoff:` points at
// what was created and the idea is closed out.
export const HARNESS_INDEX = 'docs/harness/index.md'

export function handoffPrompt(vault: string, notePath: string, repoRoot: string, hasHarness: boolean): string {
  const root = repoRoot.replace(/\/+$/, '')
  const project = root.split('/').at(-1) ?? root
  const repoStep = hasHarness
    ? `Hand off the idea note ${notePath} to the repo at ${root}, which has a harness: read ${root}/${HARNESS_INDEX}, then use the to-issues skill there (to-prd if the idea is a whole feature), taking the note's Spark, Options, Decisions and Next Step as the plan, and publish through the harness tracker.`
    : `Turn the idea note ${notePath} into a design doc at ${root}/docs/design/<kebab-case title>.md: problem, goals, non-goals, options with tradeoffs, decisions, open questions, next steps. Follow that repo's conventions.`

  return [
    repoStep,
    `Then, in the vault, set the idea's \`project:\` to ${project}, \`handoff:\` to the path or URL of what you created, status: archived, and add it under "Related".`,
    rules(vault),
  ].join(' ')
}

export type ReadingState = 'reading' | 'done' | 'dropped'

export function readingPrompt(vault: string, notePath: string, state: ReadingState): string {
  const followUp = {
    reading: '',
    done: 'Then ask me for my takeaways, add them under "## Takeaways", and ask whether to ingest the item as a source.',
    dropped: 'Ask me for a one-line reason and record it under "## Notes".',
  }[state]

  return [`Set reading_state: ${state} on the reading note ${notePath}.`, followUp, rules(vault)]
    .filter(Boolean)
    .join(' ')
}

// What `/jot` with no text asks a fork of the conversation.
export const DRAFT_PROMPT = [
  `Draft one capture for my notes vault: the single most useful thing in this conversation worth keeping.`,
  `Reply with exactly one line, \`<kind>: <text>\`, where kind is one of ${KINDS.join(', ')}`,
  `(idea: something to explore or build; improve: a change to make to an app, as "improve @<repo folder name>: <text>" when it is about a specific app; read: something to read, with its URL; til: something learned; pitfall: a failure mode and how to prevent it; plugin: a take on a tool; note: anything else).`,
  `Keep the text under 200 characters, in the language of the conversation. No other words.`,
].join(' ')

// The model's first non-empty line, unwrapped from quotes or backticks.
export function parseDraft(reply: string): Jot | null {
  const line = reply
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '')
  if (line === undefined) {
    return null
  }

  return parseJot(line.replace(/^[`"']+|[`"']+$/g, ''))
}

export function draftCommand(jot: Jot): string {
  const chars = [...jot.text]
  const text = chars.length > DRAFT_MAX ? `${chars.slice(0, DRAFT_MAX - 1).join('')}…` : jot.text

  return `/jot ${jot.kind}: ${text}`
}
