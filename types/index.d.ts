// The inbox backlog the status line and band show; null until first read or
// when the inbox cannot be read.
export type Backlog = { count: number; oldestDays: number }

declare module 'claude-code' {
  interface PluginState {
    'vault-jot': { backlog: Backlog | null; isHidden: boolean }
  }
}
