// The inbox backlog the footer label and band show; null until first read or
// when the inbox cannot be read.
export type Backlog = { count: number; oldestDays: number }

// Open ideas aimed at the session's repo, for the footer label; null when the
// session is not in a repo other than the vault.
export type OpenForRepo = { target: string; count: number }

// The incubate pane's shelves, one per vault folder it browses.
export type Shelf = 'ideas' | 'reading'

// Where the incubate pane is: shelves, one shelf's notes, or one note.
export type View =
  | { layer: 'home' }
  | { layer: 'review' }
  | { layer: 'list'; shelf: Shelf }
  | { layer: 'detail'; shelf: Shelf; file: string }

declare module 'claude-code' {
  interface PluginState {
    'vault-jot': { backlog: Backlog | null; isHidden: boolean; view: View; openForRepo: OpenForRepo | null }
  }
}
