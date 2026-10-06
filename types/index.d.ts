// The inbox backlog the footer label and band show; null until first read or
// when the inbox cannot be read.
export type Backlog = { count: number; oldestDays: number }

// The incubate pane's shelves, one per vault folder it browses.
export type Shelf = 'ideas' | 'reading'

// Where the incubate pane is: shelves, one shelf's notes, or one note.
export type View =
  | { layer: 'home' }
  | { layer: 'list'; shelf: Shelf }
  | { layer: 'detail'; shelf: Shelf; file: string }

declare module 'claude-code' {
  interface PluginState {
    'vault-jot': { backlog: Backlog | null; isHidden: boolean; view: View }
  }
}
