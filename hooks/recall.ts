// Pure logic for /recall: the prompt a subagent searches the vault with, the
// bounded list of results the pane shows, and the text that joins the chat.
// No `$` calls here.

import type { Recall } from '../types'

export const RECALLS_MAX = 10
// A subagent's answer is cut here, so one runaway reply cannot fill the state
// or, later, the conversation.
export const ANSWER_MAX = 20_000

// Read-only on purpose: a recall only fetches, and the vault's single writer
// stays claude-obsidian via the ingest and incubate requests.
export function recallPrompt(vault: string, question: string): string {
  return [
    `Answer a question from the notes vault at ${vault}. Read only: do not create, edit or delete any file.`,
    `Use the claude-obsidian wiki-query skill scoped to that vault (add wiki-retrieve when the question needs passage-level search), and follow the vault's CLAUDE.md.`,
    `Reply with a concise answer in the language of the question, then a "Sources" list of the vault-relative paths of the notes it rests on.`,
    `If the vault has nothing relevant, say so in one line and stop.`,
    `Question: ${JSON.stringify(question)}`,
  ].join(' ')
}

export function addRecall(list: readonly Recall[], recall: Recall): Recall[] {
  return [recall, ...list].slice(0, RECALLS_MAX)
}

// A finished subagent's turn: an answer is the result, anything else (an
// error, an interrupt) marks the recall failed with why.
export function settleRecall(list: readonly Recall[], id: string, reason: string, answer: string): Recall[] {
  const result: Pick<Recall, 'status' | 'answer'> =
    reason === 'answer' && answer.trim() !== ''
      ? { status: 'done', answer: [...answer].slice(0, ANSWER_MAX).join('') }
      : { status: 'failed', answer: reason === 'answer' ? 'the subagent returned no answer' : `the subagent ended: ${reason}` }

  return list.map(recall => (recall.id === id ? { ...recall, ...result } : recall))
}

export function failRecall(list: readonly Recall[], id: string, why: string): Recall[] {
  return list.map(recall => (recall.id === id ? { ...recall, status: 'failed' as const, answer: why } : recall))
}

// What the model reads when a recall is added to the conversation.
export function chatContext(recall: Recall): string {
  return `Context retrieved from my notes vault by a vault-jot recall. Question: ${JSON.stringify(recall.question)}\n\n${recall.answer}`
}
