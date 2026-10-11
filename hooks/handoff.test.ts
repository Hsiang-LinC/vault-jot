import { describe, expect, test } from 'claude-code/testing'

import { decisionPrompt, draftCommand, draftPrompt, expandPrompt, handoffPrompt, parseDraft, readingPrompt } from './handoff'

const VAULT = '/vault'
const NOTE = '/vault/wiki/ideas/Replay Mode.md'

describe('drafts', () => {
  test('a recent draft looks at the last turns and offers every kind', () => {
    const prompt = draftPrompt({ scope: 'recent' })
    expect(prompt).toContain('most recent exchange')
    expect(prompt).toContain('improve: a change to make to an app')
  })

  test('a draft for one kind asks for that kind only', () => {
    expect(draftPrompt({ scope: 'recent', kind: 'pitfall' })).toContain('where kind is pitfall.')
    expect(draftPrompt({ scope: 'recent', kind: 'improve', target: 'cx' })).toContain('where kind is improve, about cx.')
  })

  test('a summary traces how the discussion converged', () => {
    const prompt = draftPrompt({ scope: 'summary' })
    expect(prompt).toContain('whole discussion')
    expect(prompt).toContain('misunderstandings')
  })

  test('takes the first line, unwrapped, with its kind', () => {
    expect(parseDraft('\n`idea: replay mode for the committee`\nextra')).toEqual({ kind: 'idea', text: 'replay mode for the committee' })
    expect(parseDraft('"just a thought"')).toEqual({ kind: 'note', text: 'just a thought' })
  })

  test('is null when the reply has nothing usable', () => {
    expect(parseDraft('  \n ')).toBe(null)
    expect(parseDraft('idea:')).toBe(null)
    expect(parseDraft('```\n```', { scope: 'summary' })).toBe(null)
  })

  test('a summary keeps every line, unwrapped from a code fence', () => {
    expect(parseDraft('```markdown\ntil: retries need idempotency\n\n- we first thought X\n- it was Y\n```', { scope: 'summary' })).toEqual({
      kind: 'til',
      text: 'retries need idempotency\n\n- we first thought X\n- it was Y',
    })
  })

  test('keeps the target the model inferred unless one was asked for', () => {
    expect(parseDraft('note @usage-band: add /ub toggles', { scope: 'recent', kind: 'idea' })).toEqual({ kind: 'idea', text: 'add /ub toggles', target: 'usage-band' })
    expect(parseDraft('til @cx: x', { scope: 'recent', kind: 'til', target: 'app' })).toEqual({ kind: 'til', text: 'x', target: 'app' })
  })

  test('any kind may name its repo in a draft', () => {
    expect(draftPrompt({ scope: 'recent' })).toContain('"<kind> @<repo folder name>: <text>"')
    expect(draftPrompt({ scope: 'summary' })).toContain('@<repo folder name>')
  })

  test('the requested kind and target win over what the model chose', () => {
    expect(parseDraft('idea: x', { scope: 'recent', kind: 'pitfall' })).toEqual({ kind: 'pitfall', text: 'x' })
    expect(parseDraft('smaller panel', { scope: 'recent', kind: 'improve', target: 'cx' })).toEqual({ kind: 'improve', text: 'smaller panel', target: 'cx' })
  })

  test('becomes a bounded /jot command', () => {
    expect(draftCommand({ kind: 'til', text: 'short' })).toBe('/jot til: short')
    expect([...draftCommand({ kind: 'note', text: 'z'.repeat(900) })].length).toBe('/jot note: '.length + 500)
    expect([...draftCommand({ kind: 'note', text: 'z'.repeat(9000) }, 'summary')].length).toBe('/jot note: '.length + 4000)
  })

  test('keeps an improve target', () => {
    expect(draftCommand({ kind: 'improve', text: 'smaller panel', target: 'cx' })).toBe('/jot improve @cx: smaller panel')
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
