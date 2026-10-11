import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, PromptEditInput, PromptEditResult } from 'claude-code'
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
  spawnDenied?: string
}

function world(on: On, opts: WorldOptions = {}) {
  const dirs = new Set(opts.dirs ?? [INBOX])
  const files = new Map(Object.entries(opts.files ?? {}))
  const statuses: (string | undefined)[] = []
  const fills: string[] = []
  const forks: string[] = []
  const submits: string[] = []
  const spawns: { prompt: string; description: string; cwd?: string; agentId: string }[] = []
  const toasts: string[] = []
  const appended: string[] = []
  const opened: string[] = []
  const closed: string[] = []
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
  on('model.fork', async (_$, e) => {
    forks.push(e.prompt)
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
  on('ui.close', async (_$, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.append', async (_$, e) => {
    appended.push(e.message.content.map(block => ('text' in block ? block.text : '')).join(''))

    return e
  })
  on('agent.spawn', async (_$, e) => {
    const agentId = `agent-${spawns.length + 1}`
    spawns.push({ prompt: e.prompt, description: e.description, ...(e.cwd === undefined ? {} : { cwd: e.cwd }), agentId })

    return opts.spawnDenied === undefined ? { model: 'sonnet', agentId } : { deny: opts.spawnDenied }
  })
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

  return { files, statuses, fills, forks, submits, spawns, toasts, appended, opened, closed }
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
  // Claude Code labels a plugin command's output with the plugin's name, so
  // the text must not repeat it.
  test('command output never repeats the plugin name', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on)

    for (const ran of [await $.command.run(jot('til: x')), await $.command.run({ ...jot(''), command: 'incubate' })]) {
      expect(ran.text).not.toMatch(/^vault-jot/)
    }
  })

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

  test('writes an improve capture with its target', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files } = world(on)

    const ran = await $.command.run(jot('improve @app: smaller panel'))

    expect(ran.text).toMatch(/^Jotted improve → inbox\/jot-\d{8}-\d{6}-improve-smaller-panel\.md$/)
    expect(files.get(captures(files)[0] ?? '')?.text).toContain('kind: improve\ntarget: "app"\ncaptured:')
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

  test('refuses loudly when vaultPath is unset', async ($, on) => {
    const { files, statuses } = world(on)

    const ran = await $.command.run(jot('lost thought'))

    expect(ran.text).toBe('not saved: vaultPath is not set; set it in /config under vault-jot')
    expect(files.size).toBe(0)
    expect(statuses).toEqual([])
  })

  test('never creates an inbox at a mistyped path', { options: { vaultPath: '/vualt' } }, async ($, on) => {
    const { files } = world(on)

    const ran = await $.command.run(jot('lost thought'))

    expect(ran.text).toMatch(/^not saved: cannot read \/vualt\/inbox: .*ENOENT/)
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

// The props the engine hands the band.
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

describe('backlog band', () => {

  const stale = Object.fromEntries(
    ['a', 'b'].map(name => [`${INBOX}/${name}.md`, { text: name, mtimeMs: NOW - 8 * DAY }]),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`offers ingest when the inbox is stale (${surface})`, { options: { vaultPath: '/vault' } }, async ($, on) => {
      const { statuses, spawns } = world(on, { files: stale })
      on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
        const { Text } = $.ui.resolve(e)

        return <Text key="engine">engine</Text>
      })
      await $.session.start({ cwd: '/work/app', surface, isInteractive: true })
      expect(statuses).toEqual([undefined])

      const ui = await $.ui.mount({ plugin: 'vault-jot', surface, component: 'AbovePrompt', props: PROPS })
      expect((await ui.find({ key: 'ingest' }))?.text).toBe('Ingest')

      await ui.press({ key: 'ingest' })
      expect(spawns.map(spawn => spawn.prompt)).toEqual([
        'Ingest the captures in /vault/inbox with claude-obsidian wiki-ingest (batch).',
      ])

      expect(await ui.find({ text: 'engine' as never })).not.toBe(undefined)

      await ui.press({ key: 'hide' })
      expect(await ui.find({ key: 'ingest' })).toBe(undefined)
      expect(await ui.find({ text: 'engine' as never })).not.toBe(undefined)
    })
  }

  test('keeps the drawing beneath it when nothing is due (terminal)', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { files: { [`${INBOX}/a.md`]: { text: 'a', mtimeMs: NOW } } })
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text key="engine">engine</Text>
    })
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'vault-jot', surface: 'terminal', component: 'AbovePrompt', props: PROPS })

    expect(await ui.drawn()).toMatchObject({ type: 'Text', children: ['engine'] })
  })

  // The desktop draws no footer labels, so the band carries them there.
  test('carries the footer labels at the right end of the band (desktop)', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { files: { [`${INBOX}/a.md`]: { text: 'a', mtimeMs: NOW } } })
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text key="engine">engine</Text>
    })
    await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'vault-jot', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

    const root = await ui.drawn()
    expect(root).toMatchObject({ type: 'Box', props: { justifyContent: 'space-between' } })
    expect((root as { children: unknown[] }).children).toMatchObject([
      { type: 'Box', children: [{ type: 'Text', children: ['engine'] }] },
      { type: 'Box', children: [{ type: 'Text', children: ['📥 inbox 1 · 0d'] }] },
    ])
    expect(await ui.find({ key: 'ingest' })).toBe(undefined)
  })

  test('shows a vault problem in the band (desktop)', async ($, on) => {
    world(on)
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Box } = $.ui.resolve(e)

      return <Box key="engine" />
    })
    await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'vault-jot', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

    expect(await ui.find({ text: /vault-jot: vaultPath is not set/ as never })).not.toBe(undefined)
  })

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

describe('/jot ingest', () => {
  const inbox = { [`${INBOX}/jot-a.md`]: { text: 'x', mtimeMs: NOW } }
  const REQUEST = 'Ingest the captures in /vault/inbox with claude-obsidian wiki-ingest (batch).'

  test('runs ingest in a background subagent below the band thresholds', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { fills, submits, spawns } = world(on, { files: inbox })

    const ran = await $.command.run(jot(' Ingest '))

    expect(spawns).toEqual([{ prompt: REQUEST, description: 'ingest 1 captures', cwd: '/vault', agentId: 'agent-1' }])
    expect(fills).toEqual([])
    expect(submits).toEqual([])
    expect(ran.text).toMatch(/ingesting 1 captures in the background/)
  })

  test('says so when the inbox is empty', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { spawns } = world(on)

    const ran = await $.command.run(jot('ingest'))

    expect(ran.text).toBe('inbox is empty; nothing to ingest.')
    expect(spawns).toEqual([])
  })

  test('says so when the engine starts the subagent without an id', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { toasts } = world(on, { files: inbox })

    await $.command.run(jot('ingest'))

    expect(toasts).toEqual(['vault-jot: started in the background: ingest 1 captures (no completion notice)'])
  })

  test('reports a refused spawn instead of dropping the request', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { files: inbox, spawnDenied: 'agents are disabled' })

    const ran = await $.command.run(jot('ingest'))

    expect(ran.text).toBe('not started: agents are disabled')
  })

  test('still captures text that merely starts with the word', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files, spawns } = world(on)

    await $.command.run(jot('ingest is slow today'))

    expect(captures(files)).toHaveLength(1)
    expect(spawns).toEqual([])
  })
})

describe('/recall', () => {
  const pane = ($: Engine) =>
    $.ui.mount({ plugin: 'vault-jot', surface: 'terminal', component: 'Pane', requestId: 'incubate', props: { width: 100, height: 30 } as never })

  test('asks a read-only subagent in the vault and lists the question', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { spawns, submits, appended } = world(on)

    await $.command.run({ ...jot('where do pitfalls go?'), command: 'recall' })

    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.cwd).toBe('/vault')
    expect(spawns[0]?.prompt).toContain('do not create, edit or delete any file')
    expect(spawns[0]?.prompt).toContain('Question: "where do pitfalls go?"')
    expect(submits).toEqual([])
    expect(appended).toEqual([])
  })

  test('fails the recall loudly when its subagent has no id to collect from', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on)

    const ran = await $.command.run({ ...jot('where do pitfalls go?'), command: 'recall' })
    await $.command.run({ ...jot(''), command: 'recall' })
    const ui = await pane($)

    expect(ran.text).toMatch(/^not started: the engine started the subagent without an id/)
    expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toContain('✗ where do pitfalls go?')
  })

  test('opens the answers with no question, and says when nothing was asked', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { opened, spawns } = world(on)

    const ran = await $.command.run({ ...jot(''), command: 'recall' })
    const ui = await pane($)

    expect(ran.text).toBe('recall answers opened.')
    expect(opened).toEqual(['incubate'])
    expect(spawns).toEqual([])
    expect(await ui.find({ text: /Nothing asked yet/ as never })).not.toBe(undefined)
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

    expect(ran.text).toMatch(/^nothing to draft from yet\. Usage: \/jot/)
    expect(fills).toEqual([])
  })

  test('keeps the draft visible when the prompt box refuses it', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { forkReply: 'til: x', isFillRefused: true })

    const ran = await $.command.run(jot(''))

    expect(ran.text).toBe('could not fill the prompt (refused). Draft: /jot til: x')
  })

  test('a kind alone drafts that kind', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { fills, forks } = world(on, { forkReply: 'idea: stat before fs.write' })

    await $.command.run(jot('pitfall:'))

    expect(forks[0]).toContain('where kind is pitfall.')
    expect(fills).toEqual(['/jot pitfall: stat before fs.write'])
  })

  const SUMMARY = 'til: fork sees the whole transcript\n\n- we assumed it could be cut\n- only the prompt can steer it'
  const draftPane = ($: Engine) =>
    $.ui.mount({ plugin: 'vault-jot', surface: 'terminal', component: 'Pane', requestId: 'jot-draft', props: { width: 100, height: 30 } as never })

  test('/jot summary previews the summary in a pane and saves nothing', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files, fills, forks, opened } = world(on, { forkReply: SUMMARY })

    const ran = await $.command.run(jot('summary'))
    const ui = await draftPane($)

    expect(forks[0]).toContain('whole discussion')
    expect(opened).toEqual(['jot-draft'])
    expect(ran.text).toBe('summary draft is in the pane.')
    expect(await ui.find({ text: /only the prompt can steer it/ as never })).not.toBe(undefined)
    expect(fills).toEqual([])
    expect(files.size).toBe(0)
  })

  test('saving the summary from the pane writes it and closes the pane', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files, closed, toasts } = world(on, { forkReply: SUMMARY })
    await $.command.run(jot('summary'))
    const ui = await draftPane($)

    await ui.press({ key: 'save' })

    const [note] = [...files.values()]
    expect(note?.text).toMatch(/kind: til/)
    expect(note?.text).toMatch(/- only the prompt can steer it\n$/)
    expect(toasts[0]).toMatch(/^vault-jot: Jotted til → inbox\//)
    expect(closed).toEqual(['jot-draft'])
  })

  test('edit moves the summary into the prompt; discard drops it', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files, fills, closed } = world(on, { forkReply: SUMMARY })
    await $.command.run(jot('summary'))

    const first = await draftPane($)
    await first.press({ key: 'edit' })
    expect(fills).toEqual([`/jot ${SUMMARY}`])
    await first.unmount()

    await $.command.run(jot('summary'))
    await (await draftPane($)).press({ key: 'discard' })
    expect(closed).toEqual(['jot-draft', 'jot-draft'])
    expect(files.size).toBe(0)
  })

  test('a failed summary says why in the pane', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { forkReply: null })

    const ran = await $.command.run(jot('summary'))
    const ui = await draftPane($)

    expect(ran.text).toMatch(/^nothing to draft from yet/)
    expect(await ui.find({ text: /nothing to draft from yet/ as never })).not.toBe(undefined)
  })

  test('saving a summary draft keeps its lines', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files } = world(on)

    await $.command.run(jot('til: fork sees the whole transcript\n\n- only the prompt can steer it'))

    const [note] = [...files.values()]
    expect(note?.text).toMatch(/title: "fork sees the whole transcript"/)
    expect(note?.text).toMatch(/\n\nfork sees the whole transcript\n\n- only the prompt can steer it\n$/)
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
      expect(ran.text).toBe('incubate pane opened.')
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

  test('opens an idea by title and hands decisions to background subagents', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { submits, spawns } = world(on, shelves)
    await $.command.run({ ...jot('replay mode'), command: 'incubate' })
    const ui = await pane($)

    await ui.press({ key: 'choose:1' })
    await ui.input({ key: 'decision', text: 'Ship verdict replay first' })
    await ui.press({ key: 'expand' })
    await ui.press({ key: 'handoff' })

    const note = `${IDEAS}/Replay Mode.md`
    expect(submits).toEqual([])
    const prompts = spawns.map(spawn => spawn.prompt)
    expect(spawns.map(spawn => spawn.cwd)).toEqual(['/vault', '/vault', '/vault', '/work/app'])
    expect(prompts).toHaveLength(4)
    expect(prompts[0]).toContain(`Record a decision on the idea note ${note}: "Chose: Replay verdicts only".`)
    expect(prompts[1]).toContain(`Record a decision on the idea note ${note}: "Ship verdict replay first".`)
    expect(prompts[2]).toContain(`Incubate the idea note ${note}.`)
    expect(prompts[3]).toContain(`into a design doc at /work/app/docs/design/`)
    expect(prompts[3]).toContain('`handoff:`')
  })

  test('offers no hand-off from inside the vault itself', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { ...shelves, repoRoot: '/vault' })
    await $.command.run({ ...jot('Replay Mode'), command: 'incubate' })

    const ui = await pane($)

    expect(await ui.find({ key: 'expand' })).not.toBe(undefined)
    expect(await ui.find({ key: 'handoff' })).toBe(undefined)
  })

  test('marks a reading item in the background', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { spawns } = world(on, shelves)
    await $.command.run({ ...jot(''), command: 'incubate' })
    const ui = await pane($)

    await ui.press({ key: 'reading' })
    await ui.press({ key: 'note:Hooks Post.md' })
    expect(await ui.find({ text: 'https://example.com/hooks' })).not.toBe(undefined)
    await ui.press({ key: 'mark:done' })

    expect(spawns[0]?.prompt).toContain(`Set reading_state: done on the reading note ${READING}/Hooks Post.md.`)
  })

  test('falls back to the idea list when the title matches nothing', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, shelves)

    const ran = await $.command.run({ ...jot('nonexistent'), command: 'incubate' })

    expect(ran.text).toBe('no idea matches "nonexistent"; showing all ideas.')
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

  test('hands an idea off through the repo harness when it has one', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { spawns } = world(on, {
      ...shelves,
      files: { ...shelves.files, '/work/app/docs/harness/index.md': { text: '# harness', mtimeMs: NOW } },
    })
    await $.command.run({ ...jot('replay mode'), command: 'incubate' })
    const ui = await pane($)

    expect((await ui.find({ key: 'handoff' }))?.text).toBe('Hand off to app')
    await ui.press({ key: 'handoff' })

    expect(spawns[0]?.prompt).toContain('/work/app/docs/harness/index.md')
    expect(spawns[0]?.prompt).toContain('to-issues')
    expect(spawns[0]?.cwd).toBe('/work/app')
  })

  test('shows an idea target in the list and detail header', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, {
      ...shelves,
      files: {
        ...shelves.files,
        [`${IDEAS}/Smaller Panel.md`]: { text: '---\ntitle: "Smaller Panel"\nstatus: seed\ntarget: "app"\n---\n', mtimeMs: NOW },
      },
    })
    await $.command.run({ ...jot(''), command: 'incubate' })
    const ui = await pane($)

    await ui.press({ key: 'ideas' })
    expect(await ui.find({ text: '🌱 Smaller Panel @app · seed' })).not.toBe(undefined)
    await ui.press({ key: 'note:Smaller Panel.md' })
    expect(await ui.find({ text: ' · @app' })).not.toBe(undefined)
  })

  test('review lists open ideas per app and stale seeds', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, {
      ...shelves,
      files: {
        ...shelves.files,
        [`${IDEAS}/Old Seed.md`]: { text: '---\ntitle: "Old Seed"\nstatus: seed\ncreated: 2026-09-01\ntarget: "app"\n---\n', mtimeMs: NOW },
      },
    })
    await $.command.run({ ...jot(''), command: 'incubate' })
    const ui = await pane($)

    await ui.press({ key: 'review' })

    expect(await ui.find({ text: '  • app: 1' })).not.toBe(undefined)
    expect(await ui.find({ text: '  • no target: 2' })).not.toBe(undefined)
    await ui.press({ key: 'stale:Old Seed.md' })
    expect(await ui.find({ text: ' · @app' })).not.toBe(undefined)
  })
})

describe('repo footer', () => {
  const IDEAS = '/vault/wiki/ideas'
  const ideas = {
    dirs: [INBOX, IDEAS],
    files: {
      [`${IDEAS}/A.md`]: { text: '---\nstatus: seed\ntarget: "app"\n---\n', mtimeMs: NOW },
      [`${IDEAS}/B.md`]: { text: '---\nstatus: developing\ntarget: "APP"\n---\n', mtimeMs: NOW },
      [`${IDEAS}/C.md`]: { text: '---\nstatus: archived\ntarget: "app"\n---\n', mtimeMs: NOW },
      [`${IDEAS}/D.md`]: { text: '---\nstatus: seed\ntarget: "other"\n---\n', mtimeMs: NOW },
    },
  }

  test('counts open ideas aimed at the session repo', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, ideas)
    engineFooter(on)
    await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })

    expect(await footerOf($)).toMatchObject({ children: ['focus & 🛠 app 2'] })
  })

  test('shows nothing inside the vault or when no idea targets the repo', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { ...ideas, repoRoot: '/vault' })
    engineFooter(on)
    await $.session.start({ cwd: '/vault', surface: 'terminal', isInteractive: true })

    expect(await footerOf($)).toMatchObject({ children: ['focus'] })
  })
})

describe('related-notes index (M5)', () => {
  const IDEAS = '/vault/wiki/ideas'
  const files = {
    [`${INBOX}/jot-20261007-note-ub.md`]: { text: '---\ntitle: "add /ub toggles"\nkind: note\ntarget: usage-band\n---\n\nx\n', mtimeMs: NOW },
    [`${INBOX}/jot-20261008-pitfall-hermes.md`]: { text: '---\ntitle: "hermes PATH"\nkind: pitfall\norigin_repo: "git@github.com:me/usage-band.git"\n---\n\nx\n', mtimeMs: NOW },
    [`${IDEAS}/Band Snooze.md`]: { text: '---\ntitle: "Band snooze"\nstatus: seed\ntarget: usage-band\n---\n', mtimeMs: NOW },
  }

  test('opens the conversation with the notes aimed at the repo', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { dirs: [INBOX, IDEAS], files, repoRoot: '/work/usage-band' })
    on('prompt.context', async (_$, e) => ({ blocks: e.blocks }))
    await $.session.start({ cwd: '/work/usage-band', surface: 'terminal', isInteractive: true })

    const { blocks } = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })

    expect(blocks.map(block => block.name)).toEqual(['currentDate', 'vaultNotes'])
    const text = blocks[1]?.text ?? ''
    expect(text).toContain('For this repo (usage-band):\n- add /ub toggles — /vault/inbox/jot-20261007-note-ub.md\n- Band snooze — /vault/wiki/ideas/Band Snooze.md')
    // captured from inside the repo, but not aimed at it
    expect(text).toContain('Other inbox captures:\n- hermes PATH — /vault/inbox/jot-20261008-pitfall-hermes.md')
  })

  test('adds nothing when the vault cannot be read', async ($, on) => {
    world(on)
    on('prompt.context', async (_$, e) => ({ blocks: e.blocks }))

    const { blocks } = await $.prompt.context({ blocks: [] })

    expect(blocks).toEqual([])
  })
})

describe('/jot as it is typed', () => {
  const hint = { isDraft: true, isWorking: false, hint: '? for shortcuts' }

  test('paints the kind and lists matching words under the prompt', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { repoRoot: '/work/usage-band' })
    on('prompt.edit', async (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
    on('ui.render', { component: 'PromptHint' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.hint}{e.props.tail ?? ''}</Text>
    })
    await $.session.start({ cwd: '/work/usage-band', surface: 'terminal', isInteractive: true })
    // The testing engine raises `prompt.edit` though its type does not list it.
    const prompt = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptEditResult> }
    const edit = (text: string, inputText: string) =>
      prompt.edit({ origin: { kind: 'composer' }, text, cursor: text.length, start: text.length, end: text.length, inputText })
    const footer = async () =>
      (await $.ui.mount({ plugin: 'vault-jot', surface: 'terminal', component: 'PromptHint', props: hint })).drawn()

    const typed = await edit('/jot iddea', ':')
    expect(typed.decorations).toEqual([{ start: 5, end: 10, color: 'red', underline: true }])
    expect(await footer()).toMatchObject({ children: ['? for shortcuts', '  unknown kind "iddea"; did you mean idea?'] })

    await edit('/jot idea @', 'u')
    expect(await footer()).toMatchObject({ children: ['? for shortcuts', '  @usage-band'] })
  })

  test('the desktop band shows the candidates in place of the labels', { options: { vaultPath: '/vault' } }, async ($, on) => {
    world(on, { files: { [`${INBOX}/a.md`]: { text: 'a', mtimeMs: NOW } } })
    on('prompt.edit', async (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text key="engine">engine</Text>
    })
    await $.session.start({ cwd: '/work/app', surface: 'desktop', isInteractive: true })
    const prompt = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptEditResult> }

    await prompt.edit({ origin: { kind: 'composer' }, text: '/jot ', cursor: 5, start: 5, end: 5, inputText: 'i' })
    const ui = await $.ui.mount({ plugin: 'vault-jot', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

    expect(await ui.find({ text: 'idea · improve · ingest' as never })).not.toBe(undefined)
    expect(await ui.find({ text: /📥/ as never })).toBe(undefined)
  })

  test('refuses a mistyped kind instead of saving a note', { options: { vaultPath: '/vault' } }, async ($, on) => {
    const { files } = world(on)

    const ran = await $.command.run(jot('iddea: x'))

    expect(ran.text).toBe('not saved: unknown kind "iddea"; did you mean idea?')
    expect(files.size).toBe(0)
  })
})
