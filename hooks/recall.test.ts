import { describe, expect, test } from 'claude-code/testing'

import type { Recall } from '../types'

import { ANSWER_MAX, RECALLS_MAX, addRecall, chatContext, failRecall, recallPrompt, settleRecall } from './recall'

const running = (id: string): Recall => ({ id, question: `q${id}`, status: 'running', answer: '' })

describe('recallPrompt', () => {
  test('is read-only, names the skill and quotes the question safely', () => {
    const prompt = recallPrompt('/vault', 'what about "hooks"?')

    expect(prompt).toContain('/vault')
    expect(prompt).toContain('do not create, edit or delete any file')
    expect(prompt).toContain('wiki-query')
    expect(prompt).toContain('Question: "what about \\"hooks\\"?"')
  })
})

describe('recall list', () => {
  test('keeps the newest first and drops the oldest past the bound', () => {
    let list: Recall[] = []
    for (let n = 0; n < RECALLS_MAX + 2; n += 1) {
      list = addRecall(list, running(String(n)))
    }

    expect(list).toHaveLength(RECALLS_MAX)
    expect(list[0]?.id).toBe(String(RECALLS_MAX + 1))
    expect(list.at(-1)?.id).toBe('2')
  })

  test('settles only the matching recall with the answer', () => {
    const list = [running('b'), running('a')]

    const next = settleRecall(list, 'a', 'answer', 'It is X.\n\nSources\n- wiki/x.md')

    expect(next[0]).toEqual(running('b'))
    expect(next[1]).toMatchObject({ id: 'a', status: 'done', answer: 'It is X.\n\nSources\n- wiki/x.md' })
  })

  test('cuts an oversized answer', () => {
    const [done] = settleRecall([running('a')], 'a', 'answer', 'x'.repeat(ANSWER_MAX + 5))

    expect(done?.answer).toHaveLength(ANSWER_MAX)
  })

  test('marks an empty answer or a non-answer end as failed with why', () => {
    expect(settleRecall([running('a')], 'a', 'answer', '  ')[0]).toMatchObject({
      status: 'failed',
      answer: 'the subagent returned no answer',
    })
    expect(settleRecall([running('a')], 'a', 'aborted', 'partial')[0]).toMatchObject({
      status: 'failed',
      answer: 'the subagent ended: aborted',
    })
    expect(failRecall([running('a')], 'a', 'no id')[0]).toMatchObject({ status: 'failed', answer: 'no id' })
  })
})

test('chatContext frames the answer with its question', () => {
  const text = chatContext({ id: 'a', question: 'why X?', status: 'done', answer: 'Because Y.' })

  expect(text).toBe('Context retrieved from my notes vault by a vault-jot recall. Question: "why X?"\n\nBecause Y.')
})
