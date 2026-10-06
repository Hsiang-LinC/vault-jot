import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import {
  KINDS,
  expandHome,
  fileName,
  isOverdue,
  localStamp,
  parseJot,
  renderNote,
  statusText,
  summarizeInbox,
} from './core'
import type { Jot, Thresholds } from './core'

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

async function refresh($: EngineInterface, config: Config) {
  try {
    const { inbox } = await resolveVault($, config)
    const files = (await $.fs.list(inbox)).filter(entry => entry.kind === 'file')
    const next = summarizeInbox(files, await $.clock.now())
    $.ui.status(statusText(next))
    await update($, backlog, () => next)
  } catch (error) {
    $.ui.status(`vault-jot: ${describe(error)}`.slice(0, STATUS_MAX))
    await update($, backlog, () => null)
  }
}

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'jot',
      description: 'Capture a thought into the vault inbox',
      argumentHint: `[${KINDS.join('|')}:] <text>`,
      immediate: true,
    })
    await refresh($, config)

    return next(e)
  })

  on('command.run', { command: 'jot' }, async ($, e) => {
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

  // Ingest may run in any session, so recount after each main-agent turn.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await refresh($, config)
    }

    return next(e)
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
}
