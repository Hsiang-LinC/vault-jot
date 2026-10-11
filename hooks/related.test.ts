import { describe, expect, test } from 'claude-code/testing'

import { parseNote } from './notes'
import { relatedIndex } from './related'

const VAULT = '/vault'
const capture = (file: string, title: string, target?: string) =>
  parseNote(file, `---\ntitle: ${JSON.stringify(title)}\n${target === undefined ? '' : `target: ${target}\n`}---\n\nbody\n`)

describe('relatedIndex', () => {
  test('lists notes aimed at the repo apart from the other inbox titles', () => {
    const text = relatedIndex({
      vault: VAULT,
      repo: 'usage-band',
      captures: [capture('jot-2.md', 'add /ub toggles', 'Usage-Band'), capture('jot-1.md', 'hermes PATH pitfall')],
      ideas: [capture('Band Snooze.md', 'Band snooze', 'usage-band'), capture('Replay.md', 'Replay mode', 'cx')],
    })

    expect(text).toContain('For this repo (usage-band):\n- add /ub toggles — /vault/inbox/jot-2.md\n- Band snooze — /vault/wiki/ideas/Band Snooze.md')
    expect(text).toContain('Other inbox captures:\n- hermes PATH pitfall — /vault/inbox/jot-1.md')
    expect(text).not.toContain('Replay mode')
    expect(text).toContain('read a file only when it matters')
  })

  test('outside a repo lists the inbox alone', () => {
    const text = relatedIndex({ vault: VAULT, repo: null, captures: [capture('jot-1.md', 'x', 'cx')], ideas: [] })

    expect(text).not.toContain('For this repo')
    expect(text).toContain('- x — /vault/inbox/jot-1.md')
  })

  test('is null with nothing to list', () => {
    expect(relatedIndex({ vault: VAULT, repo: 'app', captures: [], ideas: [capture('a.md', 'a', 'cx')] })).toBe(null)
  })

  test('is bounded, says how many were left out, and cuts long titles', () => {
    const many = Array.from({ length: 30 }, (_, i) => capture(`jot-${i}.md`, `t${i} ${'z'.repeat(200)}`))
    const text = relatedIndex({ vault: VAULT, repo: null, captures: many, ideas: [] }) ?? ''

    expect(text.split('\n').filter(line => line.startsWith('- ')).length).toBe(20)
    expect(text).toContain('(10 more not listed)')
    expect(text).not.toContain('z'.repeat(101))
  })
})
