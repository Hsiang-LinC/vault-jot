import { describe, expect, test } from 'claude-code/testing'

import { hintLine, readDraft } from './composer'

const TARGETS = ['usage-band', 'vault-jot', 'cx']

describe('readDraft', () => {
  test('ignores drafts that are not /jot', () => {
    expect(readDraft('hello', TARGETS)).toBe(null)
    expect(readDraft('/jotx idea', TARGETS)).toBe(null)
  })

  test('filters the kinds and words as the first word is typed', () => {
    expect(readDraft('/jot ', TARGETS)?.hint).toBe('idea · improve · read · til · pitfall · plugin · note · summary · ingest')
    expect(readDraft('/jot i', TARGETS)?.hint).toBe('idea · improve · ingest')
    expect(readDraft('/jot P', TARGETS)?.hint).toBe('pitfall · plugin')
  })

  test('paints the first word as it is typed, like a shell', () => {
    expect(readDraft('/jot ide', TARGETS)?.marks).toEqual([])
    expect(readDraft('/jot idea', TARGETS)).toEqual({ hint: 'idea', marks: [{ start: 5, end: 9, state: 'ok' }] })
    expect(readDraft('/jot iddea', TARGETS)).toEqual({ hint: 'unknown kind "iddea"; did you mean idea?', marks: [{ start: 5, end: 10, state: 'bad' }] })
    expect(readDraft('/jot Obsidian', TARGETS)).toEqual({ hint: null, marks: [] })
  })

  test('paints a target as soon as it names a known one', () => {
    expect(readDraft('/jot idea @usage-ban', TARGETS)?.marks).toEqual([{ start: 5, end: 9, state: 'ok' }])
    expect(readDraft('/jot idea @usage-band', TARGETS)).toEqual({
      hint: '@usage-band',
      marks: [{ start: 5, end: 9, state: 'ok' }, { start: 10, end: 21, state: 'ok' }],
    })
    expect(readDraft('/jot idea @zz', TARGETS)).toEqual({ hint: 'new target @zz', marks: [{ start: 5, end: 9, state: 'ok' }] })
  })

  test('marks a known kind and an unknown one', () => {
    expect(readDraft('/jot idea: x', TARGETS)).toEqual({ hint: null, marks: [{ start: 5, end: 9, state: 'ok' }] })
    expect(readDraft('/jot iddea: x', TARGETS)).toEqual({
      hint: 'unknown kind "iddea"; did you mean idea?',
      marks: [{ start: 5, end: 10, state: 'bad' }],
    })
  })

  test('filters the targets as @ is typed, and marks a known one', () => {
    expect(readDraft('/jot idea @', TARGETS)?.hint).toBe('@usage-band · @vault-jot · @cx')
    expect(readDraft('/jot idea @u', TARGETS)?.hint).toBe('@usage-band')
    expect(readDraft('/jot idea @usage-band: x', TARGETS)?.marks).toEqual([
      { start: 5, end: 9, state: 'ok' },
      { start: 10, end: 21, state: 'ok' },
    ])
    expect(readDraft('/jot idea @newapp: x', TARGETS)).toEqual({ hint: 'new target @newapp', marks: [{ start: 5, end: 9, state: 'ok' }] })
  })

  test('leaves plain text alone', () => {
    expect(readDraft('/jot https://example.com/post', TARGETS)).toEqual({ hint: null, marks: [] })
    expect(readDraft('/jot Obsidian Bases can group', TARGETS)).toEqual({ hint: null, marks: [] })
  })
})

describe('hintLine', () => {
  test('cuts candidates that do not fit', () => {
    expect(hintLine(['idea', 'improve'], 80)).toBe('idea · improve')
    expect(hintLine(['@usage-band', '@vault-jot', '@cx'], 20)).toBe('@usage-band · @vaul…')
  })
})
