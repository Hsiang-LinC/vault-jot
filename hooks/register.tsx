import { atom, read, update } from 'claude-code'
import type { CommandRunResult, CommandSpec, EngineInterface, PluginOptions, Register } from 'claude-code'

import type { OpenForRepo, Recall, Shelf, SummaryDraft, View } from '../types'

import {
  KINDS,
  backlogLabel,
  expandHome,
  fileName,
  isOverdue,
  localStamp,
  parseRequest,
  renderNote,
  summarizeInbox,
} from './core'
import type { DraftRequest, Jot, Thresholds } from './core'
import { HARNESS_INDEX, decisionPrompt, draftCommand, draftPrompt, expandPrompt, handoffPrompt, ingestPrompt, parseDraft, readingPrompt } from './handoff'
import type { ReadingState } from './handoff'
import { addRecall, chatContext, failRecall, recallPrompt, settleRecall } from './recall'
import { SHELVES, STALE_SEED_DAYS, findNote, openForTarget, parseNote, reviewIdeas, sortNotes, stateOf, targetOf, titleOf } from './notes'
import type { Note } from './notes'
import { relatedIndex } from './related'
import { readDraft } from './composer'

const backlog = atom({ plugin: 'vault-jot', key: 'backlog' } as const, null)
// Why the vault could not be read on the last refresh; null when it could.
const problem = atom({ plugin: 'vault-jot', key: 'problem' } as const, null as string | null)
const isHidden = atom({ plugin: 'vault-jot', key: 'isHidden' } as const, false)
const openForRepo = atom({ plugin: 'vault-jot', key: 'openForRepo' } as const, null as OpenForRepo | null)
const summary = atom({ plugin: 'vault-jot', key: 'summary' } as const, null as SummaryDraft | null)
// What the prompt-hint line says about a `/jot` draft being typed, and the
// targets it offers: the session's repo and those the ideas name.
const draftHint = atom({ plugin: 'vault-jot', key: 'draftHint' } as const, null as string | null)
const knownTargets = atom({ plugin: 'vault-jot', key: 'knownTargets' } as const, [] as string[])
const recalls = atom({ plugin: 'vault-jot', key: 'recalls' } as const, [] as Recall[])

// Command output carries no "vault-jot:" prefix: Claude Code already labels
// a plugin command's output with the plugin's name.
const USAGE = `Usage: /jot [${KINDS.join('|')}:] <text>; /jot [<kind>:] or /jot summary to draft one; or /jot ingest`
const MAX_NAME_ATTEMPTS = 5
// Inbox files read for the related-notes index; past this the oldest are left out.
const INBOX_READ_MAX = 100
const GIT_TIMEOUT_MS = 3000
const STATUS_MAX = 80
const TOAST_MAX = 160
const ANSWER_LINES = 60
const RECALL_ICON = { running: '⏳', done: '✓', failed: '✗' } as const

// Requests for Claude run as background subagents of this session, so they
// never type into the prompt box or interrupt a turn in progress. `jobs` maps
// a running subagent's id to what it was asked, until its turn completes.
// `onSettled` receives its end (for a request whose answer is the point).
type Job = { label: string; onSettled?: (reason: string, answer: string) => Promise<void> }
type Jobs = Map<string, Job>

// `cwd` is where the subagent works; the vault for vault-only requests. A
// request with `onSettled` needs the subagent's id to be answered, so
// without one it fails; any other only loses its completion toast.
async function dispatch(
  $: EngineInterface,
  jobs: Jobs,
  label: string,
  prompt: string,
  cwd?: string,
  onSettled?: Job['onSettled'],
) {
  const spawned = await $.agent.spawn(cwd === undefined ? { prompt, description: label } : { prompt, description: label, cwd })
  if (spawned.deny !== undefined) {
    throw new Error(spawned.deny)
  }
  if (spawned.agentId === undefined) {
    if (onSettled !== undefined) {
      throw new Error('the engine started the subagent without an id, so its answer cannot be collected')
    }
    $.ui.toast(`vault-jot: started in the background: ${label} (no completion notice)`)

    return
  }
  jobs.set(spawned.agentId, onSettled === undefined ? { label } : { label, onSettled })
  $.ui.toast(`vault-jot: started in the background: ${label}`)
}

const firstLine = (text: string) => (text.split('\n').find(line => line.trim() !== '') ?? '').trim().slice(0, TOAST_MAX)

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
// A fork of the conversation drafts one capture; the reason when it cannot.
async function requestDraft($: EngineInterface, request: DraftRequest): Promise<Jot | string> {
  const reply = await $.model.fork({ prompt: draftPrompt(request) })
  if (!reply.isAnswered) {
    return reply.reason === 'nothing-to-fork'
      ? `nothing to draft from yet. ${USAGE}`
      : `could not draft a capture (${reply.reason}). ${USAGE}`
  }

  return parseDraft(reply.text, request) ?? `the draft came back empty. ${USAGE}`
}

// `/jot` or `/jot <kind>:`: the one-line draft goes into the prompt box as a
// `/jot` command, so nothing is saved until the person edits or accepts it
// with Enter. `/jot summary` previews its many lines in a pane instead.
async function draft($: EngineInterface, request: DraftRequest): Promise<CommandRunResult> {
  if (request.scope === 'summary') {
    return draftSummary($)
  }
  const jot = await requestDraft($, request)
  if (typeof jot === 'string') {
    return { text: jot }
  }
  const command = draftCommand(jot, request.scope)
  const filled = await $.prompt.fill({ text: command })
  if (!filled.isFilled) {
    return { text: `could not fill the prompt (${filled.refusal ?? 'refused'}). Draft: ${command}` }
  }

  return { text: 'draft is in your prompt. Edit it and press Enter to save, or clear it.' }
}

async function draftSummary($: EngineInterface): Promise<CommandRunResult> {
  await update($, summary, () => ({ status: 'drafting' }))
  const opened = await $.ui.open({ id: DRAFT_PANE, title: 'Summary draft' })
  const jot = await requestDraft($, { scope: 'summary' })
  const settled: SummaryDraft = typeof jot === 'string' ? { status: 'failed', reason: jot } : { status: 'ready', jot }
  await update($, summary, () => settled)
  if (typeof jot === 'string') {
    return { text: jot }
  }

  return { text: opened.isPlaced ? 'summary draft is in the pane.' : `summary drafted; the pane is waiting: ${opened.reason}` }
}

// `/jot ingest`: the band's Ingest button on demand, whatever the thresholds.
async function ingest($: EngineInterface, config: Config, jobs: Jobs): Promise<CommandRunResult> {
  try {
    const { vault, inbox } = await resolveVault($, config)
    const files = (await $.fs.list(inbox)).filter(entry => entry.kind === 'file')
    const { count } = summarizeInbox(files, await $.clock.now())
    if (count === 0) {
      return { text: 'inbox is empty; nothing to ingest.' }
    }
    await dispatch($, jobs, `ingest ${count} captures`, ingestPrompt(inbox), vault)

    return { text: `ingesting ${count} captures in the background.` }
  } catch (error) {
    return { text: `not started: ${describe(error)}` }
  }
}

let recallSeq = 0

// `/recall <question>`: a read-only subagent searches the vault with the
// claude-obsidian skills; its answer lands in the pane, not the conversation.
async function recall($: EngineInterface, config: Config, jobs: Jobs, question: string): Promise<CommandRunResult> {
  const id = `${await $.clock.now()}-${(recallSeq += 1)}`
  try {
    const { vault } = await resolveVault($, config)
    await update($, recalls, list => addRecall(list, { id, question, status: 'running', answer: '' }))
    const settle = async (reason: string, answer: string) => {
      await update($, recalls, list => settleRecall(list, id, reason, answer))
    }
    try {
      await dispatch($, jobs, `recall: ${firstLine(question)}`, recallPrompt(vault, question), vault, settle)
    } catch (error) {
      await update($, recalls, list => failRecall(list, id, describe(error)))
      throw error
    }

    return { text: 'asking the vault in the background; the answer shows under /recall.' }
  } catch (error) {
    return { text: `not started: ${describe(error)}` }
  }
}

// The last path segment of the session's repo, which is what an idea's
// `target` is matched against; null outside a repo and inside the vault.
async function repoName($: EngineInterface, vault: string): Promise<string | null> {
  const repo = await $.session.repo()

  return repo === null || repo.root === vault ? null : (repo.root.replace(/\/+$/, '').split('/').at(-1) ?? null)
}

// The inbox backlog and the open ideas aimed at this repo, as short labels.
async function footerLabels($: EngineInterface): Promise<string[]> {
  const current = await read($, backlog)
  const forRepo = await read($, openForRepo)

  return [
    current === null ? undefined : backlogLabel(current),
    forRepo === null || forRepo.count === 0 ? undefined : `🛠 ${forRepo.target} ${forRepo.count}`,
  ].filter(label => label !== undefined)
}

async function refresh($: EngineInterface, config: Config) {
  try {
    const { vault, inbox } = await resolveVault($, config)
    const files = (await $.fs.list(inbox)).filter(entry => entry.kind === 'file')
    const next = summarizeInbox(files, await $.clock.now())
    const name = await repoName($, vault)
    const ideas = (await loadShelf($, vault, 'ideas')).notes
    $.ui.status(undefined)
    await update($, problem, () => null)
    await update($, backlog, () => next)
    await update($, openForRepo, () => (name === null ? null : { target: name, count: openForTarget(ideas, name).length }))
    const targets = [name, ...ideas.map(targetOf)].filter((target): target is string => target !== null && target !== undefined)
    await update($, knownTargets, () => [...new Set(targets)].sort())
  } catch (error) {
    $.ui.status(`vault-jot: ${describe(error)}`.slice(0, STATUS_MAX))
    await update($, problem, () => describe(error).slice(0, STATUS_MAX))
    await update($, backlog, () => null)
    await update($, openForRepo, () => null)
  }
}

// The incubate pane browses wiki/ideas and wiki/reading; it only reads notes
// and hands every change to Claude.
const PANE = 'incubate'
// Where `/jot summary` previews its draft before anything is saved.
const DRAFT_PANE = 'jot-draft'
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

const RECALL_COMMAND: CommandSpec = {
  name: 'recall',
  description: 'Ask the vault a question in the background; the answer waits in the incubate pane',
  argumentHint: '<question>, or nothing to open the answers',
}

const INCUBATE_COMMAND: CommandSpec = {
  name: 'incubate',
  description: 'Browse vault ideas and reading, and decide what to do with them',
  argumentHint: '[idea title]',
}

export const register: Register = (on, options) => {
  const config = readConfig(options)
  const jobs: Jobs = new Map()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jot',
      description: 'Capture a thought into the vault inbox',
      argumentHint: `[${KINDS.join('|')}:] [text] | summary | ingest`,
      immediate: true,
    })
    await $.command.register(INCUBATE_COMMAND)
    await $.command.register(RECALL_COMMAND)
    await refresh($, config)

    return next(e)
  })

  on('command.run', { command: 'jot' }, async ($, e) => {
    await update($, draftHint, () => null)
    const request = parseRequest(e.args)
    if (request.mode === 'draft') {
      return draft($, request)
    }
    if (request.mode === 'ingest') {
      return ingest($, config, jobs)
    }
    if (request.mode === 'invalid') {
      return { text: `not saved: ${request.reason}` }
    }
    const { jot } = request
    try {
      const name = await capture($, config, jot)
      await refresh($, config)

      return { text: `Jotted ${jot.kind} → inbox/${name}` }
    } catch (error) {
      return { text: `not saved: ${describe(error)}` }
    }
  })

  // Ingest may run in any session, so recount after each main-agent turn;
  // Claude may also have edited notes the incubate pane shows. A background
  // job this mod started reports when its own turn completes.
  on('turn.complete', async ($, e, next) => {
    const job = e.agentId === undefined ? undefined : jobs.get(e.agentId)
    if (e.agentId !== undefined && job !== undefined) {
      jobs.delete(e.agentId)
      await job.onSettled?.(e.reason, e.answer)
      const outcome = e.reason === 'answer' ? `done: ${job.label}` : `${e.reason}: ${job.label}`
      const detail = job.onSettled === undefined ? firstLine(e.answer) : ''
      $.ui.toast(`vault-jot: ${outcome}${detail === '' ? '' : ` · ${detail}`}`, { timeoutMs: 8000 })
      await refresh($, config)
      $.ui.invalidate('ui.render')
    } else if (e.agentId === undefined) {
      await refresh($, config)
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const labels = await footerLabels($)

    return labels.length === 0 ? next(e) : next({ ...e, props: { ...e.props, modes: [...e.props.modes, ...labels] } })
  })

  // The band other mods share: this one sets its items at the right end of
  // what they drew (`next(e)`), never in place of it. On the desktop, which
  // draws no footer labels, the items also carry them and any vault problem
  // the status line would show; elsewhere they appear only while the inbox
  // is overdue.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const current = await read($, backlog)
    const isDue = current !== null && isOverdue(current, config.thresholds) && !(await read($, isHidden))
    const isDesktop = e.surface === 'desktop'
    // While a `/jot` draft is typed, its hint takes the labels' place, so the
    // desktop (which draws no hint line) gets the candidates where the row
    // already is, and nothing jumps.
    const typing = isDesktop ? await read($, draftHint) : null
    const labels = typing !== null ? [typing] : isDesktop ? await footerLabels($) : []
    const fault = isDesktop ? await read($, problem) : null
    if (!isDue && labels.length === 0 && fault === null) {
      return next(e)
    }
    const beneath = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const runIngest = async () => {
      $.ui.toast(`vault-jot: ${(await ingest($, config, jobs)).text}`)
    }

    // The desktop trims the whitespace at each flex item's edges, so the
    // items are spaced with `gap`, not with spaces inside their text.
    return (
      <Box justifyContent="space-between" gap={2}>
        <Box flexShrink={1}>{beneath}</Box>
        <Box flexShrink={0} gap={1} paddingRight={1}>
          {fault === null ? null : <Text color="red">vault-jot: {fault}</Text>}
          {labels.length === 0 ? null : <Text dimColor>{labels.join(' · ')}</Text>}
          {isDue && current !== null ? (
            <Text dimColor>
              Vault inbox: {current.count} captures, oldest {current.oldestDays}d
            </Text>
          ) : null}
          {isDue ? <Button key="ingest" label="Ingest" variant="primary" onPress={runIngest} /> : null}
          {isDue ? <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} /> : null}
        </Box>
      </Box>
    )
  })

  // `/jot` as it is typed: the kind and target are painted (red for a
  // mistyped kind), and the prompt-hint line lists what could come next.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const reading = readDraft(box.text, await read($, knownTargets))
    const hint = reading?.hint ?? null
    if (hint !== (await read($, draftHint))) {
      await update($, draftHint, () => hint)
    }
    if (reading === null || reading.marks.length === 0) {
      return box
    }
    const painted = reading.marks.map(mark =>
      mark.state === 'ok'
        ? { start: mark.start, end: mark.end, color: 'green' }
        : { start: mark.start, end: mark.end, color: 'red', underline: true },
    )

    return { ...box, decorations: [...(box.decorations ?? []), ...painted] }
  })

  // The terminal draws `tail` after the engine's hint line; no other surface
  // draws it yet, so the desktop gets the painted draft alone.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const hint = await read($, draftHint)

    return hint === null || !e.props.isDraft ? next(e) : next({ ...e, props: { ...e.props, tail: `${e.props.tail ?? ''}  ${hint}` } })
  })

  // A conversation starts with the index of vault notes that may bear on it
  // (see related.ts); computed once, re-read on compaction and /clear. A
  // vault that cannot be read adds nothing: the status line already says why.
  on('prompt.context', async ($, e, next) => {
    const built = await next(e)
    let text: string | null
    try {
      const { vault, inbox } = await resolveVault($, config)
      const entries = (await $.fs.list(inbox))
        .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, INBOX_READ_MAX)
      const captures = await Promise.all(entries.map(async entry => parseNote(entry.name, await $.fs.read(`${inbox}/${entry.name}`))))
      const repo = await repoName($, vault)
      const ideas = repo === null ? [] : openForTarget((await loadShelf($, vault, 'ideas')).notes, repo)
      text = relatedIndex({ vault, repo, captures, ideas })
    } catch (error) {
      $.ui.log(`vault-jot: no related-notes index: ${describe(error)}`)
      text = null
    }

    return text === null ? built : { ...built, blocks: [...built.blocks, { name: 'vaultNotes', text }] }
  })

  // `/recall <question>` starts a search; `/recall` alone opens its answers.
  on('command.run', { command: 'recall' }, async ($, e) => {
    const question = e.args.trim()
    if (question !== '') {
      return recall($, config, jobs, question)
    }
    try {
      await resolveVault($, config)
      await update($, view, () => ({ layer: 'recalls' }))
      const opened = await $.ui.open({ id: PANE, title: 'Incubate', focus: true })

      return { text: opened.isPlaced ? 'recall answers opened.' : `The pane is waiting: ${opened.reason}` }
    } catch (error) {
      return { text: `cannot open recall: ${describe(error)}` }
    }
  })

  // The incubate pane: shelves → notes → one note, with decisions handed to a background subagent.
  on('command.run', { command: 'incubate' }, async ($, e) => {
    try {
      const { vault } = await resolveVault($, config)
      const query = e.args.trim()
      let next: View = HOME
      let text = 'incubate pane opened.'
      if (query !== '') {
        const found = findNote((await loadShelf($, vault, 'ideas')).notes, query)
        if (found === undefined || found === 'ambiguous') {
          next = { layer: 'list', shelf: 'ideas' }
          text =
            found === undefined
              ? `no idea matches "${query}"; showing all ideas.`
              : `several ideas match "${query}"; pick one.`
        } else {
          next = { layer: 'detail', shelf: 'ideas', file: found.file }
        }
      }
      await update($, view, () => next)
      const opened = await $.ui.open({ id: PANE, title: 'Incubate', focus: true })

      return { text: opened.isPlaced ? text : `${text} The pane is waiting: ${opened.reason}` }
    } catch (error) {
      return { text: `cannot open incubate: ${describe(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: DRAFT_PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const current = await read($, summary)
    const close = async () => {
      await update($, summary, () => null)
      await $.ui.close({ id: DRAFT_PANE })
    }
    if (current === null || current.status === 'drafting') {
      return <Text dimColor>Summarizing the discussion…</Text>
    }
    if (current.status === 'failed') {
      return (
        <Box flexDirection="column">
          <Text color="red">{current.reason}</Text>
          <Button key="discard" hotkey="d" label="Close" onPress={close} />
        </Box>
      )
    }
    const { jot } = current
    const save = async () => {
      try {
        const name = await capture($, config, jot)
        await refresh($, config)
        $.ui.toast(`vault-jot: Jotted ${jot.kind} → inbox/${name}`.slice(0, TOAST_MAX))
        await close()
      } catch (error) {
        $.ui.toast(`vault-jot: not saved: ${describe(error)}`.slice(0, TOAST_MAX))
      }
    }
    const edit = async () => {
      const filled = await $.prompt.fill({ text: draftCommand(jot, 'summary') })
      if (filled.isFilled) {
        await close()
      } else {
        $.ui.toast(`vault-jot: could not fill the prompt (${filled.refusal ?? 'refused'})`)
      }
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{jot.kind}</Text>
        <Markdown text={`## ${jot.text}`} />
        <Box>
          <Button key="save" hotkey="s" label="Save" variant="primary" onPress={save} />
          <Text> </Text>
          <Button key="edit" hotkey="e" label="Edit in prompt" onPress={edit} />
          <Text> </Text>
          <Button key="discard" hotkey="d" label="Discard" onPress={close} />
        </Box>
      </Box>
    )
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
    // `cwd` defaults to the vault, where these requests read and write.
    const send = (text: string, what: string, cwd = vault) => async () => {
      try {
        await dispatch($, jobs, what, text, cwd)
      } catch (error) {
        $.ui.toast(`vault-jot: could not ${what}: ${describe(error)}`.slice(0, TOAST_MAX))
      }
    }

    if (current.layer === 'home') {
      const [ideas, reading] = await Promise.all([loadShelf($, vault, 'ideas'), loadShelf($, vault, 'reading')])
      const asked = await read($, recalls)

      return (
        <Box flexDirection="column">
          <Text dimColor>Pick a shelf.</Text>
          <Box>
            <Button key="ideas" hotkey="i" label={`${SHELVES.ideas.icon} Ideas ${ideas.notes.length}`} onPress={go({ layer: 'list', shelf: 'ideas' })} />
            <Text> </Text>
            <Button key="reading" hotkey="r" label={`${SHELVES.reading.icon} Reading ${reading.notes.length}`} onPress={go({ layer: 'list', shelf: 'reading' })} />
            <Text> </Text>
            <Button key="review" hotkey="v" label="Review" onPress={go({ layer: 'review' })} />
            <Text> </Text>
            <Button key="recalls" hotkey="c" label={`Recall ${asked.length}`} onPress={go({ layer: 'recalls' })} />
          </Box>
        </Box>
      )
    }

    if (current.layer === 'review') {
      const { notes: ideas } = await loadShelf($, vault, 'ideas')
      const review = reviewIdeas(ideas, await $.clock.now())

      return (
        <Box flexDirection="column">
          <Box>
            <Button key="back" hotkey="b" plain label="‹ Shelves" onPress={go(HOME)} />
            <Text bold> Review</Text>
          </Box>
          <Text bold>Open ideas by app</Text>
          {review.openByTarget.length === 0 && review.openUntargeted === 0 && <Text dimColor> none</Text>}
          {review.openByTarget.map(([target, count]) => (
            <Text key={`app:${target}`}>  • {target}: {count}</Text>
          ))}
          {review.openUntargeted > 0 && <Text>  • no target: {review.openUntargeted}</Text>}
          <Text bold>Seeds waiting {STALE_SEED_DAYS}+ days</Text>
          {review.staleSeeds.length === 0 && <Text dimColor> none</Text>}
          {review.staleSeeds.map(note => (
            <Button
              key={`stale:${note.file}`}
              plain
              label={`🌱 ${titleOf(note)}`}
              onPress={go({ layer: 'detail', shelf: 'ideas', file: note.file })}
            />
          ))}
        </Box>
      )
    }

    if (current.layer === 'recalls') {
      const asked = await read($, recalls)
      const { Input } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Box>
            <Button key="back" hotkey="b" plain label="‹ Shelves" onPress={go(HOME)} />
            <Text bold> Recall</Text>
          </Box>
          {e.surface !== 'mobile' && (
            <Input
              key="question"
              label="Ask"
              placeholder="ask the vault; Enter runs it in the background"
              onSubmit={value => {
                if (value.trim() !== '') {
                  void recall($, config, jobs, value.trim()).then(result => $.ui.toast(`vault-jot: ${result.text}`))
                }
              }}
            />
          )}
          {asked.length === 0 && <Text dimColor>Nothing asked yet. Type a question, or /recall &lt;question&gt;.</Text>}
          {asked.map(item => (
            <Button
              key={`recall:${item.id}`}
              plain
              label={`${RECALL_ICON[item.status]} ${firstLine(item.question)}`}
              onPress={go({ layer: 'recall', id: item.id })}
            />
          ))}
        </Box>
      )
    }

    if (current.layer === 'recall') {
      const item = (await read($, recalls)).find(candidate => candidate.id === current.id)
      const back = <Button key="back" hotkey="b" plain label="‹ Recall" onPress={go({ layer: 'recalls' })} />
      if (item === undefined) {
        return (
          <Box flexDirection="column">
            {back}
            <Text dimColor>That answer has dropped off the list.</Text>
          </Box>
        )
      }
      const lines = item.answer.split('\n')
      const addToChat = async () => {
        try {
          const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: chatContext(item) }] } })
          $.ui.toast(appended.deny === undefined ? 'vault-jot: added the answer to the conversation' : `vault-jot: not added: ${appended.deny}`)
        } catch (error) {
          $.ui.toast(`vault-jot: not added: ${describe(error)}`.slice(0, TOAST_MAX))
        }
      }

      return (
        <Box flexDirection="column">
          <Box>
            {back}
            <Text bold> {firstLine(item.question)}</Text>
          </Box>
          {item.status === 'running' && <Text dimColor>Still searching the vault…</Text>}
          {item.status === 'failed' && <Text color="red">{item.answer}</Text>}
          {item.status === 'done' && lines.slice(0, ANSWER_LINES).map((line, index) => <Text key={`line:${index}`}>{line}</Text>)}
          {item.status === 'done' && lines.length > ANSWER_LINES && (
            <Text dimColor>… {lines.length - ANSWER_LINES} more lines; Add to chat sends all of it.</Text>
          )}
          {item.status === 'done' && <Button key="add" hotkey="a" label="Add to chat" variant="primary" onPress={addToChat} />}
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
              label={`${shelf.icon} ${titleOf(note)}${targetOf(note) === undefined || current.shelf !== 'ideas' ? '' : ` @${targetOf(note)}`} · ${stateOf(current.shelf, note)}`}
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
        {current.shelf === 'ideas' && targetOf(note) !== undefined && <Text dimColor> · @{targetOf(note)}</Text>}
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
    const handoffRoot = repo !== null && repo.root !== vault ? repo.root : undefined
    const hasHarness = handoffRoot !== undefined && (await $.fs.exists(`${handoffRoot}/${HARNESS_INDEX}`))
    const decide = (decision: string) => send(decisionPrompt(vault, path, decision), 'record the decision')()
    // Mobile has no Input; there the options' Choose buttons still decide.
    let decisionInput = null
    if (e.surface !== 'mobile') {
      const { Input } = $.ui.resolve(e)
      decisionInput = (
        <Input
          key="decision"
          label="Decision"
          placeholder="type a decision, Enter records it in the background"
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
          {handoffRoot !== undefined && <Text> </Text>}
          {handoffRoot !== undefined && (
            <Button
              key="handoff"
              hotkey="x"
              label={`Hand off to ${handoffRoot.split('/').at(-1)}`}
              onPress={send(handoffPrompt(vault, path, handoffRoot, hasHarness), 'hand the idea off', handoffRoot)}
            />
          )}
        </Box>
      </Box>
    )
  })
}
