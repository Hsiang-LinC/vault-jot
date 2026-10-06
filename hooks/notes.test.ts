import { describe, expect, test } from 'claude-code/testing'

import { findNote, parseNote, sortNotes, stateOf, titleOf } from './notes'

const IDEA = `---
title: "Replay Mode"
type: idea
status: developing
tags:
  - idea
url:
note: 'it''s quoted'
---

# Replay Mode

## Open Questions

- Which week counts as "last"?
- [ ] Do we replay the committee or only the verdict?

## Options

1. Replay everything — slow but faithful
2. Replay verdicts only — fast

Not a list item.
`

describe('parseNote', () => {
  test('reads flat frontmatter, skipping block lists and empty values', () => {
    const note = parseNote('Replay Mode.md', IDEA)
    expect(note.props).toEqual({ title: 'Replay Mode', type: 'idea', status: 'developing', note: "it's quoted" })
  })

  test('collects list items per ## section, checkboxes and numbering stripped', () => {
    const note = parseNote('Replay Mode.md', IDEA)
    expect(note.sections['Open Questions']).toEqual([
      'Which week counts as "last"?',
      'Do we replay the committee or only the verdict?',
    ])
    expect(note.sections['Options']).toEqual(['Replay everything — slow but faithful', 'Replay verdicts only — fast'])
  })

  test('a note without frontmatter falls back to its file name and default state', () => {
    const note = parseNote('Loose Idea.md', '## Options\n- one\n')
    expect(titleOf(note)).toBe('Loose Idea')
    expect(stateOf('ideas', note)).toBe('seed')
    expect(stateOf('reading', note)).toBe('queued')
  })
})

describe('shelf order and lookup', () => {
  const note = (file: string, status: string) => parseNote(file, `---\nstatus: ${status}\n---\n`)
  const notes = [note('b.md', 'seed'), note('a.md', 'archived'), note('c.md', 'developing'), note('d.md', 'seed')]

  test('lists ideas needing attention first, then by title', () => {
    expect(sortNotes('ideas', notes).map(one => one.file)).toEqual(['c.md', 'b.md', 'd.md', 'a.md'])
  })

  test('finds by exact title first, then a unique substring', () => {
    const shelf = [parseNote('Replay Mode.md', ''), parseNote('Replay Mode v2.md', ''), parseNote('Band Snooze.md', '')]
    expect(findNote(shelf, 'replay mode')).toMatchObject({ file: 'Replay Mode.md' })
    expect(findNote(shelf, 'snooze')).toMatchObject({ file: 'Band Snooze.md' })
    expect(findNote(shelf, 'replay')).toBe('ambiguous')
    expect(findNote(shelf, 'nothing')).toBe(undefined)
  })
})
