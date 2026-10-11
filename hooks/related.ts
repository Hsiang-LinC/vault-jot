// The related-notes index a conversation starts with: what in the vault is
// aimed at the session's repo, and the other inbox titles, so Claude can
// point out a note that bears on the work. Titles and paths only, bounded;
// bodies are read on demand (the vault's Lazy Context Loading).

import { titleOf, targetOf } from './notes'
import type { Note } from './notes'

const RELATED_MAX = 15
const INBOX_MAX = 20
const TITLE_MAX = 100

export type IndexInput = {
  vault: string
  // The session repo's folder name; null outside a repo or in the vault.
  repo: string | null
  // Inbox captures, newest first.
  captures: readonly Note[]
  // Open ideas.
  ideas: readonly Note[]
}

function lines(notes: readonly Note[], folder: string, max: number): string[] {
  const listed = notes.slice(0, max).map(note => {
    const chars = [...titleOf(note)]
    const title = chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : chars.join('')

    return `- ${title} — ${folder}/${note.file}`
  })

  return notes.length > max ? [...listed, `(${notes.length - max} more not listed)`] : listed
}

export function relatedIndex({ vault, repo, captures, ideas }: IndexInput): string | null {
  const wanted = repo?.toLowerCase()
  const isForRepo = (note: Note) => wanted !== undefined && targetOf(note)?.toLowerCase() === wanted
  const forRepo = [
    ...lines(captures.filter(isForRepo), `${vault}/inbox`, RELATED_MAX),
    ...lines(ideas.filter(isForRepo), `${vault}/wiki/ideas`, RELATED_MAX),
  ]
  const others = lines(captures.filter(note => !isForRepo(note)), `${vault}/inbox`, INBOX_MAX)
  if (forRepo.length === 0 && others.length === 0) {
    return null
  }

  return [
    `Notes in the vault at ${vault} that may bear on this session: titles only; read a file only when it matters.`,
    forRepo.length === 0 ? null : [`For this repo (${repo}):`, ...forRepo].join('\n'),
    others.length === 0 ? null : ['Other inbox captures:', ...others].join('\n'),
    'When the current work relates to one of these, say so in one line and name the file. Do not edit the vault for it.',
  ]
    .filter(part => part !== null)
    .join('\n\n')
}
