// Pure reading of vault notes for the incubate pane: flat frontmatter, list
// items per `##` section, and lookup by title. The pane only reads notes;
// every write is handed to Claude (see handoff.ts).

import type { Shelf } from '../types'

export type Note = {
  file: string
  props: Readonly<Record<string, string>>
  sections: Readonly<Record<string, readonly string[]>>
}

export const SHELVES: Readonly<Record<Shelf, { folder: string; label: string; icon: string }>> = {
  ideas: { folder: 'wiki/ideas', label: 'Ideas', icon: '🌱' },
  reading: { folder: 'wiki/reading', label: 'Reading', icon: '📖' },
}

// Lifecycles from the vault's Vault Guide, in the order the pane lists them:
// what needs attention first.
const STATE_ORDER: Readonly<Record<Shelf, readonly string[]>> = {
  ideas: ['developing', 'seed', 'mature', 'archived'],
  reading: ['reading', 'queued', 'done', 'dropped'],
}

const unquote = (raw: string): string => {
  const value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return String(JSON.parse(value))
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'")
  }

  return value
}

// Scalar `key: value` lines only; block lists (tags, sources) are skipped,
// since the pane needs none of them.
export function parseNote(file: string, text: string): Note {
  const lines = text.split(/\r?\n/)
  const props: Record<string, string> = {}
  let bodyStart = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
        const value = match ? unquote(match[2] ?? '') : ''
        if (match?.[1] && value !== '') {
          props[match[1]] = value
        }
      }
      bodyStart = end + 1
    }
  }

  const sections: Record<string, string[]> = {}
  let current: string[] | undefined
  for (const line of lines.slice(bodyStart)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading?.[1]) {
      current = sections[heading[1]] = []
      continue
    }
    const item = /^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line)
    if (current && item?.[1]) {
      current.push(item[1])
    }
  }

  return { file, props, sections }
}

export const titleOf = (note: Note): string => note.props.title ?? note.file.replace(/\.md$/, '')

export function stateOf(shelf: Shelf, note: Note): string {
  return shelf === 'ideas' ? (note.props.status ?? 'seed') : (note.props.reading_state ?? 'queued')
}

export function sortNotes(shelf: Shelf, notes: readonly Note[]): Note[] {
  const order = STATE_ORDER[shelf]
  const rank = (note: Note) => {
    const index = order.indexOf(stateOf(shelf, note))

    return index === -1 ? order.length : index
  }

  return [...notes].sort((a, b) => rank(a) - rank(b) || titleOf(a).localeCompare(titleOf(b)))
}

// Exact title or file name first (case-insensitive), then a unique substring.
export function findNote(notes: readonly Note[], query: string): Note | 'ambiguous' | undefined {
  const wanted = query.trim().toLowerCase()
  const names = (note: Note) => [titleOf(note).toLowerCase(), note.file.replace(/\.md$/, '').toLowerCase()]
  const exact = notes.find(note => names(note).includes(wanted))
  if (exact) {
    return exact
  }
  const partial = notes.filter(note => names(note).some(name => name.includes(wanted)))
  if (partial.length > 1) {
    return 'ambiguous'
  }

  return partial[0]
}
