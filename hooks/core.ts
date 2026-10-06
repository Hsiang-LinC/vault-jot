// Pure logic for vault-jot: parsing captures, naming and rendering inbox
// files, and summarizing the inbox backlog. No `$` calls here.

import type { Backlog } from '../types'

// Must match the "Capture Kinds" table in the vault's Vault Guide, which
// says what ingest turns each kind into.
export const KINDS = ['idea', 'improve', 'read', 'til', 'pitfall', 'plugin', 'note'] as const
export type Kind = (typeof KINDS)[number]

// `target` names the app or repo an `improve` capture is about; ingest files
// it as the idea's `target`, and the incubate pane matches it to the repo
// folder name.
export type Jot = { kind: Kind; text: string; target?: string }

export type Origin = {
  cwd: string
  repo: string | null
  branch: string | null
  session: string
}

export type InboxEntry = { name: string; mtimeMs: number }

export type Thresholds = { count: number; days: number }

const KIND_PREFIX = new RegExp(`^(${KINDS.join('|')})(?:\\s+@([\\p{L}\\p{N}_.-]+))?:\\s*`, 'iu')
const DAY_MS = 24 * 60 * 60 * 1000
const SLUG_MAX = 40
const TITLE_MAX = 80

// `/jot idea: text` → { kind: 'idea', text }; `/jot improve @cx: text` also
// carries a target. No known prefix → kind `note`, so text like
// "https://..." is never mistaken for a kind. Null when empty.
export function parseJot(args: string): Jot | null {
  const trimmed = args.trim()
  const match = KIND_PREFIX.exec(trimmed)
  const kind = (match?.[1]?.toLowerCase() ?? 'note') as Kind
  const text = (match ? trimmed.slice(match[0].length) : trimmed).trim()

  if (text === '') {
    return null
  }
  const target = match?.[2]

  return target === undefined ? { kind, text } : { kind, text, target }
}

// Letters and digits in any script survive, so a non-English capture still
// gets a readable name.
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')

  return [...slug].slice(0, SLUG_MAX).join('').replace(/-+$/, '')
}

export function titleOf(text: string): string {
  const firstLine = (text.split('\n', 1)[0] ?? '').trim()
  const chars = [...firstLine]

  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : firstLine
}

// Local wall-clock parts for `ms`, given the zone offset in minutes east of
// UTC (the negation of Date#getTimezoneOffset).
export function localStamp(ms: number, offsetMinutes: number) {
  const shifted = new Date(ms + offsetMinutes * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const zone = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`

  return { iso: `${date}T${time}${zone}`, compact: `${date.replaceAll('-', '')}-${time.replaceAll(':', '')}` }
}

// `attempt` 0 is the plain name; later attempts add a suffix for the rare
// capture landing in the same second with the same slug.
export function fileName(jot: Jot, compactStamp: string, attempt = 0): string {
  const slug = slugify(jot.text)
  const base = ['jot', compactStamp, jot.kind, slug].filter(Boolean).join('-')

  return attempt === 0 ? `${base}.md` : `${base}-${attempt + 1}.md`
}

// JSON strings are valid YAML double-quoted scalars.
const yamlString = (value: string) => JSON.stringify(value)

export function renderNote(jot: Jot, isoStamp: string, origin: Origin): string {
  const lines = [
    '---',
    `title: ${yamlString(titleOf(jot.text))}`,
    `kind: ${jot.kind}`,
    jot.target === undefined ? null : `target: ${yamlString(jot.target)}`,
    `captured: ${isoStamp}`,
    `origin_cwd: ${yamlString(origin.cwd)}`,
    origin.repo === null ? null : `origin_repo: ${yamlString(origin.repo)}`,
    origin.branch === null ? null : `origin_branch: ${yamlString(origin.branch)}`,
    `origin_session: ${yamlString(origin.session)}`,
    '---',
    '',
    jot.text,
    '',
  ]

  return lines.filter(line => line !== null).join('\n')
}

// Dotfiles (`.gitkeep`) are not captures.
export function summarizeInbox(entries: readonly InboxEntry[], nowMs: number): Backlog {
  const captures = entries.filter(entry => !entry.name.startsWith('.'))
  if (captures.length === 0) {
    return { count: 0, oldestDays: 0 }
  }
  const oldest = captures.reduce((min, entry) => Math.min(min, entry.mtimeMs), Infinity)

  return { count: captures.length, oldestDays: Math.max(0, Math.floor((nowMs - oldest) / DAY_MS)) }
}

// The prompt-footer label; undefined for an empty inbox so nothing shows.
export function backlogLabel(backlog: Backlog): string | undefined {
  if (backlog.count === 0) {
    return undefined
  }

  return `📥 inbox ${backlog.count} · ${backlog.oldestDays}d`
}

export function isOverdue(backlog: Backlog, thresholds: Thresholds): boolean {
  return backlog.count > 0 && (backlog.count >= thresholds.count || backlog.oldestDays >= thresholds.days)
}

export function expandHome(path: string, home: string | undefined): string {
  if (path !== '~' && !path.startsWith('~/')) {
    return path
  }
  if (home === undefined || home === '') {
    throw new Error(`cannot expand "${path}": HOME is not set`)
  }

  return home + path.slice(1)
}
