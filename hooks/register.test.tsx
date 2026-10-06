import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { fileName, localStamp } from './core'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 6, 6, 3, 22)
const INBOX = '/vault/inbox'

type File = { text: string; mtimeMs: number }

// The world beneath the plugin: a vault on a fake disk, a session in a repo,
// and the status line and prompt box it writes to.
type WorldOptions = {
  dirs?: string[]
  files?: Record<string, File>
  branchFails?: boolean
  repoRoot?: string
  forkReply?: string | null
  isFillRefused?: boolean
}

function world(on: On, opts: WorldOptions = {}) {
  const dirs = new Set(opts.dirs ?? [INBOX])
  const files = new Map(Object.entries(opts.files ?? {}))
  const statuses: (string | undefined)[] = []
  const fills: string[] = []
  const submits: string[] = []
  const opened: string[] = []
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
  on('fs.read', async (_$, e) => {
    const file = files.get(e.path)

    return file === undefined ? { deny: `ENOENT: ${e.path}` } : { value: file.text }
  })
  on('session.repo', async () => ({
    value: { root: opts.repoRoot ?? '/work/app', remote: 'git@github.com:me/app.git', internal: false, name: null },
  }))
  on('model.fork', async () => {
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

    return {
      value:
        opts.forkReply === null
          ? { isAnswered: false as const, reason: 'nothing-to-fork' as const }
          : { isAnswered: true as const, text: opts.forkReply ?? 'idea: a drafted thought', usage },
    }
  })
  on('ui.open', async (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('prompt.submit', async (_$, e) => {
    submits.push(e.text)

    return { text: e.text }
  })
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

    return opts.isFillRefused ? { isFilled: false } : { isFilled: true }
  })

  return { files, statuses, fills, submits, opened }
}

// `/jot <args>` as the person types it at the prompt.
const jot = (args: string) => ({
  command: 'jot',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})

// The engine's own footer: the mode labels joined, as the terminal draws them.
function engineFooter(on: On) {
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.modes.join(' & ')}</Text>
  })
}

const footerOf = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ plugin: 'vault-jot', surface, component: 'SessionMode', props: { modes: ['focus'] } })

  return ui.drawn()
}

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
    expect(statuses.at(-1)).toBe(undefined)
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

describe('backlog footer', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`labels the footer with the backlog (${surface})`, { options: { vaultPath: '/vault' } }, async ($, on) => {
      world(on)
      engineFooter(on)

      expect(await footerOf($, surface)).toMatchObject({ children: ['focus'] })
      await $.command.run(jot('idea: one'))
      expect(await footerOf($, surface)).toMatchObject({ children: ['focus & 📥 inbox 1 · 0d'] })
    })
  }

  test('reports a misconfigured vault on the status line, not the footer', async ($, on) => {
    const { statuses } = world(on)
    engineFooter(on)

    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

    expect(statuses).toEqual(['vault-jot: vaultPath is not set; set it in /config under vault-jot'.slice(0, 80)])
    expect(await footerOf($)).toMatchObject({ children: ['focus'] })
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
      expect(statuses).toEqual([undefined])

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

describe('/jot with no text (M2)', () => {
  test('drafts a capture into the prompt and saves nothing', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files, fills } = world(on, { forkReply: '`pitfall: fs.write creates parent dirs; stat first`' })

    const ran = await $.command.run(jot(''))

    expect(fills).toEqual(['/jot pitfall: fs.write creates parent dirs; stat first'])
    expect(ran.text).toMatch(/draft is in your prompt/)
    expect(files.size).toBe(0)
  })

  test('says so when there is no conversation to draft from', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { fills } = world(on, { forkReply: null })

    const ran = await $.command.run(jot('  '))

    expect(ran.text).toMatch(/^vault-jot: nothing to draft from yet\. Usage: \/jot/)
    expect(fills).toEqual([])
  })

  test('keeps the draft visible when the prompt box refuses it', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { forkReply: 'til: x', isFillRefused: true })

    const ran = await $.command.run(jot(''))

    expect(ran.text).toBe('vault-jot: could not fill the prompt (refused). Draft: /jot til: x')
  })
})

describe('/incubate (M3)', () => {
  const IDEAS = '/vault/wiki/ideas'
  const READING = '/vault/wiki/reading'
  const idea = `---\ntitle: "Replay Mode"\nstatus: developing\n---\n\n## Open Questions\n\n- Which week?\n\n## Options\n\n- Replay everything\n- Replay verdicts only\n`
  const shelves = {
    dirs: [INBOX, IDEAS, READING],
    files: {
      [`${IDEAS}/Replay Mode.md`]: { text: idea, mtimeMs: NOW },
      [`${IDEAS}/Band Snooze.md`]: { text: '---\nstatus: seed\n---\n', mtimeMs: NOW },
      [`${READING}/Hooks Post.md`]: { text: '---\nurl: "https://example.com/hooks"\n---\n', mtimeMs: NOW },
    },
  }
  const PANE_PROPS = {
    title: 'Incubate',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  }
  const pane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
    $.ui.mount({ plugin: 'vault-jot', surface, component: 'Pane', requestId: 'incubate', props: PANE_PROPS })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`navigates shelves → notes → note and back (${surface})`, { options: { vaultPath: '/vault' } }, async ($, on) => {
      const { opened } = world(on, shelves)

      const ran = await $.command.run({ ...jot(''), command: 'incubate' })
      expect(ran.text).toBe('vault-jot: incubate pane opened.')
      expect(opened).toEqual(['incubate'])

      const ui = await pane($, surface)
      expect((await ui.find({ key: 'ideas' }))?.text).toBe('🌱 Ideas 2')
      expect((await ui.find({ key: 'reading' }))?.text).toBe('📖 Reading 1')

      await ui.press({ key: 'ideas' })
      expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual([
        '‹ Shelves',
        '🌱 Replay Mode · developing',
        '🌱 Band Snooze · seed',
      ])

      await ui.press({ key: 'note:Replay Mode.md' })
      expect(await ui.find({ text: 'Which week?' })).not.toBe(undefined)

      await ui.press({ key: 'back' })
      await ui.press({ key: 'back' })
      expect(await ui.find({ key: 'ideas' })).not.toBe(undefined)
    })
  }

  test('opens an idea by title and hands decisions to Claude', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { submits } = world(on, shelves)
    await $.command.run({ ...jot('replay mode'), command: 'incubate' })
    const ui = await pane($)

    await ui.press({ key: 'choose:1' })
    await ui.input({ key: 'decision', text: 'Ship verdict replay first' })
    await ui.press({ key: 'expand' })
    await ui.press({ key: 'export' })

    const note = `${IDEAS}/Replay Mode.md`
    expect(submits).toHaveLength(4)
    expect(submits[0]).toContain(`Record a decision on the idea note ${note}: "Chose: Replay verdicts only".`)
    expect(submits[1]).toContain(`Record a decision on the idea note ${note}: "Ship verdict replay first".`)
    expect(submits[2]).toContain(`Incubate the idea note ${note}.`)
    expect(submits[3]).toContain(`into a design doc at /work/app/docs/design/`)
  })

  test('offers no export from inside the vault itself', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { ...shelves, repoRoot: '/vault' })
    await $.command.run({ ...jot('Replay Mode'), command: 'incubate' })

    const ui = await pane($)

    expect(await ui.find({ key: 'expand' })).not.toBe(undefined)
    expect(await ui.find({ key: 'export' })).toBe(undefined)
  })

  test('marks a reading item through Claude', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { submits } = world(on, shelves)
    await $.command.run({ ...jot(''), command: 'incubate' })
    const ui = await pane($)

    await ui.press({ key: 'reading' })
    await ui.press({ key: 'note:Hooks Post.md' })
    expect(await ui.find({ text: 'https://example.com/hooks' })).not.toBe(undefined)
    await ui.press({ key: 'mark:done' })

    expect(submits[0]).toContain(`Set reading_state: done on the reading note ${READING}/Hooks Post.md.`)
  })

  test('falls back to the idea list when the title matches nothing', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, shelves)

    const ran = await $.command.run({ ...jot('nonexistent'), command: 'incubate' })

    expect(ran.text).toBe('vault-jot: no idea matches "nonexistent"; showing all ideas.')
    expect(await (await pane($)).find({ key: 'note:Band Snooze.md' })).not.toBe(undefined)
  })

  test('shows empty shelves when nothing has been ingested yet', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on)
    await $.command.run({ ...jot(''), command: 'incubate' })
    const ui = await pane($)

    expect((await ui.find({ key: 'ideas' }))?.text).toBe('🌱 Ideas 0')
    await ui.press({ key: 'ideas' })
    expect(await ui.find({ text: /Nothing here yet/ })).not.toBe(undefined)
  })
})
