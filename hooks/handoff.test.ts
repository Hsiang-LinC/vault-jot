import { describe, expect, test } from 'claude-code/testing'

import { DRAFT_PROMPT, decisionPrompt, draftCommand, expandPrompt, handoffPrompt, parseDraft, readingPrompt } from './handoff'

const VAULT = '/vault'
const NOTE = '/vault/wiki/ideas/Replay Mode.md'

describe('drafts', () => {
  test('the draft prompt offers the improve kind', () => {
    expect(DRAFT_PROMPT).toContain('improve @<repo folder name>')
  })

  test('takes the first line, unwrapped, with its kind', () => {
    expect(parseDraft('\n`idea: replay mode for the committee`\nextra')).toEqual({ kind: 'idea', text: 'replay mode for the committee' })
    expect(parseDraft('"just a thought"')).toEqual({ kind: 'note', text: 'just a thought' })
  })

  test('is null when the reply has nothing usable', () => {
    expect(parseDraft('  \n ')).toBe(null)
    expect(parseDraft('idea:')).toBe(null)
  })

  test('becomes a bounded /jot command', () => {
    expect(draftCommand({ kind: 'til', text: 'short' })).toBe('/jot til: short')
    expect([...draftCommand({ kind: 'note', text: 'z'.repeat(900) })].length).toBe('/jot note: '.length + 500)
  })
})

describe('hand-off prompts', () => {
  test('every prompt names the note and the vault rules', () => {
    for (const prompt of [
      expandPrompt(VAULT, NOTE),
      decisionPrompt(VAULT, NOTE, 'go'),
      handoffPrompt(VAULT, NOTE, '/work/app', false),
      readingPrompt(VAULT, NOTE, 'reading'),
    ]) {
      expect(prompt).toContain(NOTE)
      expect(prompt).toContain('Work in the vault at /vault: follow its CLAUDE.md and wiki/meta/Vault Guide.md')
    }
  })

  test('a decision is quoted as given', () => {
    expect(decisionPrompt(VAULT, NOTE, 'Drop it: "too slow"')).toContain('"Drop it: \\"too slow\\""')
  })

  test('hand-off names the project after the repo folder and closes the idea', () => {
    const prompt = handoffPrompt(VAULT, NOTE, '/work/trading-advisor/', false)
    expect(prompt).toContain('`project:` to trading-advisor')
    expect(prompt).toContain('`handoff:`')
    expect(prompt).toContain('status: archived')
  })

  test('with a harness it uses the repo tracker skills, without one a design doc', () => {
    const withHarness = handoffPrompt(VAULT, NOTE, '/work/app', true)
    expect(withHarness).toContain('/work/app/docs/harness/index.md')
    expect(withHarness).toContain('to-issues')
    expect(withHarness).not.toContain('docs/design/')
    const without = handoffPrompt(VAULT, NOTE, '/work/app', false)
    expect(without).toContain('/work/app/docs/design/')
    expect(without).not.toContain('to-issues')
  })

  test('reading states ask for the right follow-up', () => {
    expect(readingPrompt(VAULT, NOTE, 'done')).toContain('ask whether to ingest the item as a source')
    expect(readingPrompt(VAULT, NOTE, 'dropped')).toContain('one-line reason')
    expect(readingPrompt(VAULT, NOTE, 'reading')).not.toContain('ask me')
  })
})
