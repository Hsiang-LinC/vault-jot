import { describe, expect, test } from 'claude-code/testing'

import {
  expandHome,
  fileName,
  isOverdue,
  localStamp,
  parseJot,
  renderNote,
  slugify,
  statusText,
  summarizeInbox,
  titleOf,
} from './core'

const DAY = 24 * 60 * 60 * 1000

describe('parseJot', () => {
  test('reads a kind prefix case-insensitively', () => {
    expect(parseJot('  Idea:  a mod for the vault ')).toEqual({ kind: 'idea', text: 'a mod for the vault' })
  })

  test('defaults to note, and does not mistake a URL scheme for a kind', () => {
    expect(parseJot('https://example.com/post')).toEqual({ kind: 'note', text: 'https://example.com/post' })
  })

  test('is null for empty text, with or without a prefix', () => {
    expect(parseJot('   ')).toBe(null)
    expect(parseJot('read:   ')).toBe(null)
  })
})

describe('naming', () => {
  test('slugs keep letters in any script and are bounded', () => {
    expect(slugify('Hook it: Claude Code & Obsidian!')).toBe('hook-it-claude-code-obsidian')
    expect(slugify('讀書清單 reading list')).toBe('讀書清單-reading-list')
    expect([...slugify('x'.repeat(100))].length).toBe(40)
  })

  test('titles take the first line and cut long ones', () => {
    expect(titleOf('first\nsecond')).toBe('first')
    expect([...titleOf('y'.repeat(200))].length).toBe(80)
  })

  test('file names carry stamp, kind and slug, with a suffix on retry', () => {
    const jot = { kind: 'idea' as const, text: 'Vault mod' }
    expect(fileName(jot, '20261006-140322')).toBe('jot-20261006-140322-idea-vault-mod.md')
    expect(fileName(jot, '20261006-140322', 1)).toBe('jot-20261006-140322-idea-vault-mod-2.md')
    expect(fileName({ kind: 'note', text: '!!!' }, '20261006-140322')).toBe('jot-20261006-140322-note.md')
  })

  test('local stamps apply the zone offset', () => {
    const ms = Date.UTC(2026, 9, 6, 20, 3, 22)
    expect(localStamp(ms, 480)).toEqual({ iso: '2026-10-07T04:03:22+08:00', compact: '20261007-040322' })
    expect(localStamp(ms, -330).iso).toBe('2026-10-06T14:33:22-05:30')
  })
})

describe('renderNote', () => {
  test('writes flat, quoted provenance and omits what is unknown', () => {
    const note = renderNote({ kind: 'til', text: 'He said "hi"\nmore' }, '2026-10-06T14:03:22+08:00', {
      cwd: '/work/app',
      repo: null,
      branch: 'main',
      session: 'abc',
    })
    expect(note).toBe(
      [
        '---',
        'title: "He said \\"hi\\""',
        'kind: til',
        'captured: 2026-10-06T14:03:22+08:00',
        'origin_cwd: "/work/app"',
        'origin_branch: "main"',
        'origin_session: "abc"',
        '---',
        '',
        'He said "hi"\nmore',
        '',
      ].join('\n'),
    )
  })
})

describe('backlog', () => {
  const now = 100 * DAY

  test('ignores dotfiles and reports the oldest capture age', () => {
    const backlog = summarizeInbox(
      [
        { name: '.gitkeep', mtimeMs: 0 },
        { name: 'a.md', mtimeMs: now - 9 * DAY - 1 },
        { name: 'b.md', mtimeMs: now - DAY },
      ],
      now,
    )
    expect(backlog).toEqual({ count: 2, oldestDays: 9 })
    expect(statusText(backlog)).toBe('inbox: 2 · oldest 9d')
  })

  test('an empty inbox clears the status and is never overdue', () => {
    const empty = summarizeInbox([{ name: '.gitkeep', mtimeMs: 0 }], now)
    expect(statusText(empty)).toBe(undefined)
    expect(isOverdue(empty, { count: 0, days: 0 })).toBe(false)
  })

  test('is overdue by count or by age', () => {
    const thresholds = { count: 10, days: 7 }
    expect(isOverdue({ count: 10, oldestDays: 0 }, thresholds)).toBe(true)
    expect(isOverdue({ count: 1, oldestDays: 7 }, thresholds)).toBe(true)
    expect(isOverdue({ count: 9, oldestDays: 6 }, thresholds)).toBe(false)
  })
})

describe('expandHome', () => {
  test('expands a leading ~ and leaves other paths alone', () => {
    expect(expandHome('~/notes', '/Users/me')).toBe('/Users/me/notes')
    expect(expandHome('/abs/~x', '/Users/me')).toBe('/abs/~x')
  })

  test('fails when HOME is needed but unset', () => {
    expect(() => expandHome('~/notes', undefined)).toThrow('HOME is not set')
  })
})
