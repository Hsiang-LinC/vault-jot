import { atom, read, update } from 'claude-code'
import type { CommandRunResult, CommandSpec, EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Shelf, View } from '../types'

import {
  KINDS,
  backlogLabel,
  expandHome,
  fileName,
  isOverdue,
  localStamp,
  parseJot,
  renderNote,
  summarizeInbox,
} from './core'
import type { Jot, Thresholds } from './core'
import { DRAFT_PROMPT, decisionPrompt, draftCommand, expandPrompt, exportPrompt, parseDraft, readingPrompt } from './handoff'
import type { ReadingState } from './handoff'
import { SHELVES, findNote, parseNote, sortNotes, stateOf, titleOf } from './notes'
import type { Note } from './notes'

const backlog = atom({ plugin: 'vault-jot', key: 'backlog' } as const, null)
const isHidden = atom({ plugin: 'vault-jot', key: 'isHidden' } as const, false)

const USAGE = `Usage: /jot [${KINDS.join('|')}:] <text>`
const MAX_NAME_ATTEMPTS = 5
const GIT_TIMEOUT_MS = 3000
const STATUS_MAX = 80

type Config = { vaultPath: string; thresholds: Thresholds }

function readConfig(options: PluginOptions): Config {
  return {
    vaultPath: String(options.vaultPath ?? '').trim(),
    thresholds: { count: Number(options.backlogCount ?? 10), days: Number(options.backlogDays ?? 7) },
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Resolves the vault root, failing loudly when it is unset or does not look
// like a vault. `$.fs.write` creates missing directories, so writing without
// this check would silently start a new "vault" at a mistyped path.
async function resolveVault($: EngineInterface, config: Config) {
  if (config.vaultPath === '') {
    throw new Error('vaultPath is not set; set it in /config under vault-jot')
  }
  const vault = expandHome(config.vaultPath, await $.env.get('HOME')).replace(/\/+$/, '')
  const inbox = `${vault}/inbox`
  const stat = await $.fs.stat(inbox).catch((error: unknown) => {
    throw new Error(`cannot read ${inbox}: ${describe(error)}`)
  })
  if (stat.kind !== 'dir') {
    throw new Error(`${inbox} is not a directory`)
  }

  return { vault, inbox }
}

// Provenance is best effort: outside a repo, or where processes cannot run
// (a desktop host), the capture is still saved without a branch.
async function gitBranch($: EngineInterface, cwd: string): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    })

    return exitCode === 0 && stdout.trim() !== '' ? stdout.trim() : null
  } catch (error) {
    $.ui.log(`vault-jot: no branch recorded: ${describe(error)}`, { to: 'debug' })

    return null
  }
}

async function freePath($: EngineInterface, inbox: string, jot: Jot, compactStamp: string) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const path = `${inbox}/${fileName(jot, compactStamp, attempt)}`
    if (!(await $.fs.exists(path))) {
      return path
    }
  }
  throw new Error(`${MAX_NAME_ATTEMPTS} captures with the same name this second; try again`)
}

async function capture($: EngineInterface, config: Config, jot: Jot): Promise<string> {
  const { inbox } = await resolveVault($, config)
  const now = await $.clock.now()
  const stamp = localStamp(now, -new Date(now).getTimezoneOffset())
  const cwd = await $.session.cwd()
  const [repo, branch, session] = await Promise.all([$.session.repo(), gitBranch($, cwd), $.session.id()])
  const note = renderNote(jot, stamp.iso, {
    cwd,
    repo: repo === null ? null : (repo.remote ?? repo.root),
    branch,
    session,
  })
  const path = await freePath($, inbox, jot, stamp.compact)
  await $.fs.write(path, note)

  return path.slice(inbox.length + 1)
}

// The backlog shows as a prompt-footer label (see the SessionMode hook); the
// status line is kept for problems, which the engine marks as notices.
// `/jot` with no text: a fork of the conversation drafts one capture, and the
// draft goes into the prompt box as a `/jot` command, so nothing is saved
// until the person edits or accepts it with Enter.
async function draft($: EngineInterface): Promise<CommandRunResult> {
  const reply = await $.model.fork({ prompt: DRAFT_PROMPT })
  if (!reply.isAnswered) {
    return {
      text:
        reply.reason === 'nothing-to-fork'
          ? `vault-jot: nothing to draft from yet. ${USAGE}`
          : `vault-jot: could not draft a capture (${reply.reason}). ${USAGE}`,
    }
  }
  const jot = parseDraft(reply.text)
  if (jot === null) {
    return { text: `vault-jot: the draft came back empty. ${USAGE}` }
  }
  const command = draftCommand(jot)
  const filled = await $.prompt.fill({ text: command })
  if (!filled.isFilled) {
    return { text: `vault-jot: could not fill the prompt (${filled.refusal ?? 'refused'}). Draft: ${command}` }
  }

  return { text: 'vault-jot: draft is in your prompt. Edit it and press Enter to save, or clear it.' }
}

async function refresh($: EngineInterface, config: Config) {
  try {
    const { inbox } = await resolveVault($, config)
    const files = (await $.fs.list(inbox)).filter(entry => entry.kind === 'file')
    const next = summarizeInbox(files, await $.clock.now())
    $.ui.status(undefined)
    await update($, backlog, () => next)
  } catch (error) {
    $.ui.status(`vault-jot: ${describe(error)}`.slice(0, STATUS_MAX))
    await update($, backlog, () => null)
  }
}

// The incubate pane browses wiki/ideas and wiki/reading; it only reads notes
// and hands every change to Claude.
const PANE = 'incubate'
const HOME: View = { layer: 'home' }
const view = atom({ plugin: 'vault-jot', key: 'view' } as const, HOME)

// Each draw reads a shelf's notes from disk, so the pane always shows what
// Claude last wrote. Bounded: past this many notes a shelf says it is cut.
const SHELF_MAX = 200

type Loaded = { notes: Note[]; isTruncated: boolean }

async function loadShelf($: EngineInterface, vault: string, shelf: Shelf): Promise<Loaded> {
  const dir = `${vault}/${SHELVES[shelf].folder}`
  // No folder yet means nothing has been ingested into this shelf.
  if (!(await $.fs.exists(dir))) {
    return { notes: [], isTruncated: false }
  }
  const files = (await $.fs.list(dir))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name))
  const kept = files.slice(0, SHELF_MAX)
  const notes = await Promise.all(kept.map(async entry => parseNote(entry.name, await $.fs.read(`${dir}/${entry.name}`))))

  return { notes: sortNotes(shelf, notes), isTruncated: files.length > kept.length }
}

const notePath = (vault: string, shelf: Shelf, file: string) => `${vault}/${SHELVES[shelf].folder}/${file}`

const INCUBATE_COMMAND: CommandSpec = {
  name: 'incubate',
  description: 'Browse vault ideas and reading, and decide what to do with them',
  argumentHint: '[idea title]',
}

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jot',
      description: 'Capture a thought into the vault inbox',
      argumentHint: `[${KINDS.join('|')}:] <text>, or nothing to draft one`,
      immediate: true,
    })
    await $.command.register(INCUBATE_COMMAND)
    await refresh($, config)

    return next(e)
  })

  on('command.run', { command: 'jot' }, async ($, e) => {
    if (e.args.trim() === '') {
      return draft($)
    }
    const jot = parseJot(e.args)
    if (jot === null) {
      return { text: USAGE }
    }
    try {
      const name = await capture($, config, jot)
      await refresh($, config)

      return { text: `Jotted ${jot.kind} → inbox/${name}` }
    } catch (error) {
      return { text: `vault-jot: not saved: ${describe(error)}` }
    }
  })

  // Ingest may run in any session, so recount after each main-agent turn;
  // Claude may also have edited notes the incubate pane shows.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await refresh($, config)
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const current = await read($, backlog)
    const label = current === null ? undefined : backlogLabel(current)

    return label === undefined ? next(e) : next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, backlog)
    const isQuiet =
      e.props.hasSurvey || current === null || !isOverdue(current, config.thresholds) || (await read($, isHidden))
    if (isQuiet) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const fillIngest = async () => {
      const { inbox } = await resolveVault($, config)
      await $.prompt.fill({ text: `Ingest the captures in ${inbox} with claude-obsidian wiki-ingest (batch).` })
    }

    return (
      <Box>
        <Text dimColor>
          Vault inbox: {current.count} captures, oldest {current.oldestDays}d{' '}
        </Text>
        <Button key="ingest" label="Ingest" variant="primary" onPress={fillIngest} />
        <Text> </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })

  // The incubate pane: shelves → notes → one note, with decisions handed to Claude.
  on('command.run', { command: 'incubate' }, async ($, e) => {
    try {
      const { vault } = await resolveVault($, config)
      const query = e.args.trim()
      let next: View = HOME
      let text = 'vault-jot: incubate pane opened.'
      if (query !== '') {
        const found = findNote((await loadShelf($, vault, 'ideas')).notes, query)
        if (found === undefined || found === 'ambiguous') {
          next = { layer: 'list', shelf: 'ideas' }
          text =
            found === undefined
              ? `vault-jot: no idea matches "${query}"; showing all ideas.`
              : `vault-jot: several ideas match "${query}"; pick one.`
        } else {
          next = { layer: 'detail', shelf: 'ideas', file: found.file }
        }
      }
      await update($, view, () => next)
      const opened = await $.ui.open({ id: PANE, title: 'Incubate', focus: true })

      return { text: opened.isPlaced ? text : `${text} The pane is waiting: ${opened.reason}` }
    } catch (error) {
      return { text: `vault-jot: ${describe(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    let vault: string
    try {
      vault = (await resolveVault($, config)).vault
    } catch (error) {
      return <Text color="red">vault-jot: {describe(error)}</Text>
    }
    const current = await read($, view)
    const go = (to: View) => () => update($, view, () => to)
    const send = (text: string, what: string) => async () => {
      await $.prompt.submit({ text })
      $.ui.toast(`vault-jot: asked Claude to ${what}`)
    }

    if (current.layer === 'home') {
      const [ideas, reading] = await Promise.all([loadShelf($, vault, 'ideas'), loadShelf($, vault, 'reading')])

      return (
        <Box flexDirection="column">
          <Text dimColor>Pick a shelf.</Text>
          <Box>
            <Button key="ideas" hotkey="i" label={`${SHELVES.ideas.icon} Ideas ${ideas.notes.length}`} onPress={go({ layer: 'list', shelf: 'ideas' })} />
            <Text> </Text>
            <Button key="reading" hotkey="r" label={`${SHELVES.reading.icon} Reading ${reading.notes.length}`} onPress={go({ layer: 'list', shelf: 'reading' })} />
          </Box>
        </Box>
      )
    }

    const shelf = SHELVES[current.shelf]
    const { notes, isTruncated } = await loadShelf($, vault, current.shelf)

    if (current.layer === 'list') {
      return (
        <Box flexDirection="column">
          <Box>
            <Button key="back" hotkey="b" plain label="‹ Shelves" onPress={go(HOME)} />
            <Text bold> {shelf.label}</Text>
          </Box>
          {notes.length === 0 && (
            <Text dimColor>
              Nothing here yet. Captures of kind {current.shelf === 'ideas' ? 'idea' : 'read'} land here after ingest.
            </Text>
          )}
          {notes.map(note => (
            <Button
              key={`note:${note.file}`}
              plain
              label={`${shelf.icon} ${titleOf(note)} · ${stateOf(current.shelf, note)}`}
              onPress={go({ layer: 'detail', shelf: current.shelf, file: note.file })}
            />
          ))}
          {isTruncated && <Text dimColor>Showing the first {SHELF_MAX} notes.</Text>}
        </Box>
      )
    }

    const note = notes.find(candidate => candidate.file === current.file)
    const back = <Button key="back" hotkey="b" plain label={`‹ ${shelf.label}`} onPress={go({ layer: 'list', shelf: current.shelf })} />
    if (note === undefined) {
      return (
        <Box flexDirection="column">
          {back}
          <Text dimColor>{current.file} is no longer in {shelf.folder}.</Text>
        </Box>
      )
    }
    const path = notePath(vault, current.shelf, note.file)
    const header = (
      <Box>
        {back}
        <Text bold> {titleOf(note)}</Text>
        <Text dimColor> · {stateOf(current.shelf, note)}</Text>
      </Box>
    )

    if (current.shelf === 'reading') {
      const mark = (state: ReadingState, label: string, hotkey: string) => (
        <Button key={`mark:${state}`} hotkey={hotkey} label={label} onPress={send(readingPrompt(vault, path, state), `mark it ${state}`)} />
      )

      return (
        <Box flexDirection="column">
          {header}
          {note.props.url && <Text dimColor>{note.props.url}</Text>}
          <Box>
            {mark('reading', 'Reading', 'r')}
            <Text> </Text>
            {mark('done', 'Done', 'd')}
            <Text> </Text>
            {mark('dropped', 'Drop', 'x')}
          </Box>
        </Box>
      )
    }

    const questions = note.sections['Open Questions'] ?? []
    const options = note.sections['Options'] ?? []
    const repo = await $.session.repo()
    const exportRoot = repo !== null && repo.root !== vault ? repo.root : undefined
    const decide = (decision: string) => send(decisionPrompt(vault, path, decision), 'record the decision')()
    // Mobile has no Input; there the options' Choose buttons still decide.
    let decisionInput = null
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      decisionInput = (
        <Input
          key="decision"
          label="Decision"
          placeholder="type a decision, Enter sends it to Claude"
          onSubmit={value => {
            if (value.trim() !== '') {
              void decide(value.trim())
            }
          }}
        />
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        <Text bold>Open questions</Text>
        {questions.length === 0 ? <Text dimColor> none yet; Expand drafts some</Text> : questions.map(question => <Text>  • {question}</Text>)}
        <Text bold>Options</Text>
        {options.length === 0 && <Text dimColor> none yet; Expand drafts some</Text>}
        {options.map((option, index) => (
          <Box>
            <Button key={`choose:${index}`} hotkey={index < 9 ? String(index + 1) : undefined} plain label="Choose" onPress={() => decide(`Chose: ${option}`)} />
            <Text> {option}</Text>
          </Box>
        ))}
        {decisionInput}
        <Box>
          <Button key="expand" hotkey="e" label="Expand" onPress={send(expandPrompt(vault, path), 'expand the idea')} />
          {exportRoot !== undefined && <Text> </Text>}
          {exportRoot !== undefined && (
            <Button
              key="export"
              hotkey="x"
              label={`Export to ${exportRoot.split('/').at(-1)}`}
              onPress={send(exportPrompt(vault, path, exportRoot), 'export it as a design doc')}
            />
          )}
        </Box>
      </Box>
    )
  })
}
