// Pure reading of a `/jot` draft as it is typed: which words are a kind or a
// target, and what the next word could be. The engine offers no argument
// completion, so the mod paints the draft and lists the candidates under the
// prompt instead.

import { KINDS, WORDS, kindTypo, typoReason } from './core'

export type Mark = { start: number; end: number; state: 'ok' | 'bad' }
export type Reading = { hint: string | null; marks: Mark[] }

const COMMAND = '/jot'
// The widest a hint gets, in characters; the band and the hint line share it.
const HINT_WIDTH = 80

const startingWith = (options: readonly string[], prefix: string) =>
  options.filter(option => option.toLowerCase().startsWith(prefix.toLowerCase()))

// Candidates in one line, cut with … when they do not fit.
export function hintLine(options: readonly string[], width = HINT_WIDTH): string {
  const line = options.join(' · ')

  return line.length <= width ? line : `${line.slice(0, width - 1)}…`
}

export function readDraft(text: string, targets: readonly string[]): Reading | null {
  if (!text.startsWith(`${COMMAND} `)) {
    return null
  }
  const offset = COMMAND.length + (/^\s*/.exec(text.slice(COMMAND.length))?.[0].length ?? 0)
  const rest = text.slice(offset)
  const word = /^\p{L}*/u.exec(rest)?.[0] ?? ''
  const after = rest.slice(word.length)
  const end = offset + word.length

  // Still typing the first word, painted as a shell paints a command: green
  // once it is a kind or word, red once it can only be a mistyped kind, and
  // plain while it may still become one, or is just the note's text.
  if (after === '') {
    const matches = startingWith([...KINDS, ...WORDS], word)
    const isExact = matches.some(match => match === word.toLowerCase())
    const meant = matches.length === 0 ? kindTypo(word) : null
    const marks: Mark[] = isExact ? [{ start: offset, end, state: 'ok' }] : meant === null ? [] : [{ start: offset, end, state: 'bad' }]
    const hint = meant !== null ? typoReason(word, meant) : matches.length === 0 ? null : hintLine(matches)

    return { hint, marks }
  }

  const at = /^\s*@([\p{L}\p{N}_.-]*)/u.exec(after)
  const closes = at === null ? after.startsWith(':') : after.slice(at[0].length).startsWith(':')
  if (!closes && at === null) {
    return { hint: null, marks: [] }
  }
  const isKind = (KINDS as readonly string[]).includes(word.toLowerCase())
  const meant = isKind ? null : kindTypo(word)
  if (!isKind && meant === null) {
    return { hint: null, marks: [] }
  }
  if (meant !== null) {
    return { hint: typoReason(word, meant), marks: [{ start: offset, end, state: 'bad' }] }
  }
  const marks: Mark[] = [{ start: offset, end, state: 'ok' }]
  if (at === null) {
    return { hint: null, marks }
  }
  // The target likewise: green as soon as it names a known one. An unknown
  // one is allowed (a repo the vault has not seen yet), so it is never red.
  const name = at[1] ?? ''
  const atStart = end + at[0].indexOf('@')
  const isKnown = targets.some(target => target.toLowerCase() === name.toLowerCase())
  const targetMarks: Mark[] = isKnown ? [...marks, { start: atStart, end: atStart + 1 + name.length, state: 'ok' }] : marks
  const matches = startingWith(targets, name)
  if (isKnown || (!closes && matches.length > 0)) {
    return { hint: closes ? null : hintLine(matches.map(target => `@${target}`)), marks: targetMarks }
  }

  return { hint: name === '' ? null : `new target @${name}`, marks }
}
