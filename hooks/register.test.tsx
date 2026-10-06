import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fileName, localStamp } from './core'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 6, 6, 3, 22)
const INBOX = '/vault/inbox'

type File = { text: string; mtimeMs: number }

// The world beneath the plugin: a vault on a fake disk, a session in a repo,
// and the status line and prompt box it writes to.
function world(on: On, opts: { dirs?: string[]; files?: Record<string, File>; branchFails?: boolean } = {}) {
  const dirs = new Set(opts.dirs ?? [INBOX])
  const files = new Map(Object.entries(opts.files ?? {}))
  const statuses: (string | undefined)[] = []
  const fills: string[] = []
  const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/'))

  mock.env(on, { HOME: '/Users/me' })
  mock.clock(on, { now: NOW })
  // Operations beneath the plugins answer { value } or { deny }.
  on('fs.stat', async (_$, e) => {
    if (dirs.has(e.path)) {
      return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    }
    const file = files.get(e.path)
    if (file === undefined) {
      return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    }

    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.exists', async (_$, e) => ({ value: dirs.has(e.path) || files.has(e.path) }))
  on('fs.write', async (_$, e) => {
    files.set(e.path, { text: e.text, mtimeMs: NOW })

    return { value: undefined }
  })
  on('fs.list', async (_$, e) => ({
    value: [...files]
      .filter(([path]) => dirOf(path) === e.path)
      .map(([path, file]) => ({
        name: path.slice(e.path.length + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })),
  }))
  on('session.cwd', async () => ({ value: '/work/app' }))
  on('session.id', async () => ({ value: 'session-1' }))
  on('session.repo', async () => ({
    value: { root: '/work/app', remote: 'git@github.com:me/app.git', internal: false, name: null },
  }))
  on('process.run', async () =>
    opts.branchFails
      ? { deny: 'processes are not available here' }
      : { value: { exitCode: 0, stdout: 'feature/jot\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async (_$, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('prompt.fill', async (_$, e) => {
    fills.push(e.text)

    return { isFilled: true }
  })

  return { files, statuses, fills }
}

// `/jot <args>` as the person types it at the prompt.
const jot = (args: string) => ({
  command: 'jot',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

const captures = (files: Map<string, File>) => [...files.keys()].filter(path => path.startsWith(`${INBOX}/jot-`))

describe('/jot', () => {
  test('writes a capture with its kind and provenance, then updates the status', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files, statuses } = world(on)

    const ran = await $.command.run(jot('idea: A vault mod'))

    expect(ran.text).toMatch(/^Jotted idea → inbox\/jot-\d{8}-\d{6}-idea-a-vault-mod\.md$/)
    const [path] = captures(files)
    const text = files.get(path ?? '')?.text ?? ''
    expect(text).toContain('title: "A vault mod"\nkind: idea\n')
    expect(text).toContain('origin_cwd: "/work/app"\norigin_repo: "git@github.com:me/app.git"\norigin_branch: "feature/jot"\norigin_session: "session-1"\n---\n\nA vault mod\n')
    expect(statuses.at(-1)).toBe('inbox: 1 · oldest 0d')
  })

  test('expands ~ in vaultPath', { options: { vaultPath: '~/notes/' } }, async ($, on) => {
    const { files } = world(on, { dirs: ['/Users/me/notes/inbox'] })

    await $.command.run(jot('til: something'))

    expect([...files.keys()][0]).toMatch(/^\/Users\/me\/notes\/inbox\/jot-.*-til-something\.md$/)
  })

  test('saves without a branch when git cannot run', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files } = world(on, { branchFails: true })

    await $.command.run(jot('no branch here'))

    const text = [...files.values()][0]?.text ?? ''
    expect(text).toContain('kind: note\n')
    expect(text).not.toContain('origin_branch')
  })

  test('adds a suffix instead of overwriting a capture with the same name', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const stamp = localStamp(NOW, -new Date(NOW).getTimezoneOffset()).compact
    const taken = `${INBOX}/${fileName({ kind: 'idea', text: 'same' }, stamp)}`
    const { files } = world(on, { files: { [taken]: { text: 'first', mtimeMs: NOW } } })

    const ran = await $.command.run(jot('idea: same'))

    expect(ran.text).toMatch(/-idea-same-2\.md$/)
    expect(files.get(taken)?.text).toBe('first')
  })

  test('shows usage for empty text and writes nothing', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files } = world(on)

    const ran = await $.command.run(jot('idea:  '))

    expect(ran.text).toMatch(/^Usage: \/jot/)
    expect(files.size).toBe(0)
  })

  test('refuses loudly when vaultPath is unset', async ($, on) => {
    const { files, statuses } = world(on)

    const ran = await $.command.run(jot('lost thought'))

    expect(ran.text).toBe('vault-jot: not saved: vaultPath is not set; set it in /config under vault-jot')
    expect(files.size).toBe(0)
    expect(statuses).toEqual([])
  })

  test('never creates an inbox at a mistyped path', { options: { vaultPath: '/vualt' } }, async ($, on) => {
    const { files } = world(on)

    const ran = await $.command.run(jot('lost thought'))

    expect(ran.text).toMatch(/^vault-jot: not saved: cannot read \/vualt\/inbox: .*ENOENT/)
    expect(files.size).toBe(0)
  })
})

describe('backlog band', () => {
  const PROPS = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  }

  const stale = Object.fromEntries(
    ['a', 'b'].map(name => [`${INBOX}/${name}.md`, { text: name, mtimeMs: NOW - 8 * DAY }]),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`offers ingest when the inbox is stale (${surface})`, { options: { vaultPath: '/vault' } }, async ($, on) => {
      const { statuses, fills } = world(on, { files: stale })
      on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
        const { Text } = $.ui.resolve(e)

        return <Text key="engine">engine</Text>
      })
      await $.session.start({ cwd: '/work/app', surface, isInteractive: true })
      expect(statuses.at(-1)).toBe('inbox: 2 · oldest 8d')

      const ui = await $.ui.mount({ plugin: 'vault-jot', surface, component: 'AbovePrompt', props: PROPS })
      expect((await ui.find({ key: 'ingest' }))?.text).toBe('Ingest')

      await ui.press({ key: 'ingest' })
      expect(fills).toEqual(['Ingest the captures in /vault/inbox with claude-obsidian wiki-ingest (batch).'])

      await ui.press({ key: 'hide' })
      expect(await ui.find({ key: 'ingest' })).toBe(undefined)
      expect(await ui.drawn()).toMatchObject({ type: 'Text', children: ['engine'] })
    })
  }

  test('stays out of the way below the thresholds', { options: { vaultPath: '/vault', backlogDays: 30 } }, async ($, on) => {
    world(on, { files: stale })
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text key="engine">engine</Text>
    })
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'vault-jot', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect(await ui.find({ key: 'ingest' })).toBe(undefined)
  })
})
