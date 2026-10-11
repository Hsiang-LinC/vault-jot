// The inbox backlog the footer label and band show; null until first read or
// when the inbox cannot be read.
export type Backlog = { count: number; oldestDays: number }

// Open ideas aimed at the session's repo, for the footer label; null when the
// session is not in a repo other than the vault.
export type OpenForRepo = { target: string; count: number }

// The incubate pane's shelves, one per vault folder it browses.
export type Shelf = 'ideas' | 'reading'

// One /recall: a question handed to a background subagent, then its answer
// (or why it failed), kept for the pane until it falls off the bounded list.
export type Recall = { id: string; question: string; status: 'running' | 'done' | 'failed'; answer: string }

// A drafted capture; the same shape as core's Jot, whose kinds it repeats
// because this contract must be self-contained.
export type DraftJot = {
  kind: 'idea' | 'improve' | 'read' | 'til' | 'pitfall' | 'plugin' | 'note'
  text: string
  target?: string
}

// `/jot summary`'s draft while the preview pane shows it.
export type SummaryDraft =
  | { status: 'drafting' }
  | { status: 'ready'; jot: DraftJot }
  | { status: 'failed'; reason: string }

// Where the incubate pane is: shelves, one shelf's notes, or one note.
export type View =
  | { layer: 'home' }
  | { layer: 'review' }
  | { layer: 'recalls' }
  | { layer: 'recall'; id: string }
  | { layer: 'list'; shelf: Shelf }
  | { layer: 'detail'; shelf: Shelf; file: string }

declare module 'claude-code' {
  interface PluginState {
    'vault-jot': { backlog: Backlog | null; problem: string | null; isHidden: boolean; view: View; openForRepo: OpenForRepo | null; recalls: Recall[]; summary: SummaryDraft | null; draftHint: string | null; knownTargets: string[] }
  }
}
