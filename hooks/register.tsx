import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Message, Running } from '../types'
import {
  DEFAULT_MODEL,
  MODES,
  SUGGESTIONS,
  clip,
  formatDuration,
  formatElapsed,
  mainContext,
  modelOptions,
  newest,
  parseTranscript,
  pulse,
  threadPrompt,
  transcriptPath,
  withoutTrailingErrors,
} from './lib'
import type { Exchange } from './lib'

const PANE = 'side-chat'
const STORE_MODEL = 'model'
const MAX_MAIN = 12
// Characters of the main session an answer reads, and a request's agent is handed.
const ASK_BUDGET = 150000
const TASK_BUDGET = 20000

const messages = atom({ plugin: 'side-chat', key: 'messages' } as const, [])
const model = atom({ plugin: 'side-chat', key: 'model' } as const, DEFAULT_MODEL)
const mode = atom({ plugin: 'side-chat', key: 'mode' } as const, 'ask')
const running = atom({ plugin: 'side-chat', key: 'running' } as const, null)
const ticks = atom({ plugin: 'side-chat', key: 'ticks' } as const, 0)

const ASK_SYSTEM =
  'You are a side chat inside a coding session, answering apart from the main conversation. ' +
  'You are given the main session so far as background: use it to answer. ' +
  'Be brief and direct. You have no tools here.'

// The main thread as far as this load has seen it, and the agents it spawned.
const main: Exchange[] = []
const agents = new Map<string, { model: string; startedAt: number }>()
let pending = ''
let count = 0
// The one-second clock of the request in flight.
let clock: Timer | undefined

function open($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Side chat', focus: true, columns: 60 })
}

function reveal($: EngineInterface) {
  void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}

function stopClock() {
  clock?.cancel()
  clock = undefined
}

// Counts the seconds a request has run. It ends itself once nothing runs, so
// a clock left over from before a reload stops at its next beat.
function startClock($: EngineInterface) {
  stopClock()
  void update($, ticks, () => 0)
  clock = $.clock.every(1000, () => {
    void read($, running)
      .then(async job => {
        if (job === null) {
          stopClock()

          return
        }
        await update($, ticks, n => n + 1)
      })
      .catch(stopClock)
  })
}

// Takes the one place a request has. False while another runs.
async function claim($: EngineInterface, job: Running) {
  let isClaimed = false
  await update($, running, was => {
    isClaimed = was === null

    return was ?? job
  })
  if (isClaimed) {
    startClock($)
  }

  return isClaimed
}

async function finish($: EngineInterface) {
  stopClock()
  await update($, running, () => null)
}

async function currentJob($: EngineInterface): Promise<Running> {
  return { model: await read($, model), mode: await read($, mode) }
}

async function push($: EngineInterface, message: Omit<Message, 'id'>) {
  count += 1
  const id = `${await $.clock.now()}-${count}`
  await update($, messages, list => [...list, { ...message, id }].slice(-100))
  reveal($)
}

async function sessionFile($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (home === undefined) {
    return undefined
  }
  const id = await $.session.id()
  for (const cwd of [await $.session.root(), await $.session.cwd()]) {
    const path = transcriptPath(home, cwd, id)
    if (await $.fs.exists(path)) {
      return path
    }
  }

  return undefined
}

// The main session as saved on disk; what this load saw of it when the file
// cannot be read (not found, or past what one read holds).
async function sessionContext($: EngineInterface, path: string | undefined, budget: number) {
  if (path !== undefined) {
    const lines = await $.fs
      .read(path)
      .then(parseTranscript)
      .catch(() => [])
    if (lines.length > 0) {
      return `The main session this side chat belongs to, newest last:\n\n${newest(lines, budget)}`
    }
  }

  return mainContext(main)
}

// Runs the thread as it stands on the job's model: an answer lands at once,
// a request lands when its agent's turn completes.
async function answer($: EngineInterface, job: Running) {
  try {
    const startedAt = await $.clock.now()
    const thread = await read($, messages)
    const path = await sessionFile($)
    const context = await sessionContext($, path, job.mode === 'ask' ? ASK_BUDGET : TASK_BUDGET)

    if (job.mode === 'ask') {
      const r = await $.model.complete({
        model: job.model,
        system: context === '' ? ASK_SYSTEM : [{ text: ASK_SYSTEM }, { text: context, cache: true }],
        prompt: threadPrompt(thread),
        maxTokens: 8192,
        timeoutMs: 180000,
      })
      const ms = (await $.clock.now()) - startedAt
      await push(
        $,
        r.isAnswered
          ? { role: 'assistant', text: r.text, model: job.model, ms }
          : { role: 'error', text: `${job.model} did not answer: ${r.reason}` },
      )
      await finish($)

      return
    }

    const r = await $.agent.spawn({
      description: 'Side chat request',
      model: job.model,
      prompt: [
        'This is a request from a side chat of the session. Do it, then reply with a short report.',
        context,
        path === undefined ? '' : `The full transcript of the main session is the JSONL file ${path}; read it if you need more.`,
        `Side chat so far:\n${threadPrompt(thread)}`,
      ]
        .filter(part => part !== '')
        .join('\n\n'),
    })
    if (r.deny !== undefined || r.agentId === undefined) {
      await push($, { role: 'error', text: `The request did not start: ${r.deny ?? 'no agent'}` })
      await finish($)

      return
    }
    agents.set(r.agentId, { model: job.model, startedAt })
  } catch (error) {
    await push($, { role: 'error', text: `The request failed: ${error instanceof Error ? error.message : String(error)}` })
    await finish($)
  }
}

async function send($: EngineInterface, raw: string) {
  const text = raw.trim()
  if (text === '') {
    return
  }
  const job = await currentJob($)
  if (!(await claim($, job))) {
    return
  }
  await push($, { role: 'user', text })
  await answer($, job)
}

// Runs the last question again, the error that ended the thread dropped.
async function retry($: EngineInterface) {
  const thread = withoutTrailingErrors(await read($, messages))
  if (thread[thread.length - 1]?.role !== 'user') {
    return
  }
  const job = await currentJob($)
  if (!(await claim($, job))) {
    return
  }
  await update($, messages, () => [...thread])
  reveal($)
  await answer($, job)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'side',
      description: 'Open the side chat; with text, send it there',
      argumentHint: '[message]',
    })
    await $.command.register({
      name: 'side-model',
      description: 'Set the side chat model (alias or full id)',
      argumentHint: '<model>',
    })
    const saved = await $.store.get(STORE_MODEL)
    if (typeof saved === 'string' && saved !== '') {
      await update($, model, () => saved)
    }
    // A reload drops the agents this module was waiting on.
    await finish($)

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.text.startsWith('/')) {
      pending = clip(e.text)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (!e.isAborted && pending !== '') {
        main.push({ q: pending, a: clip(e.answer) })
        if (main.length > MAX_MAIN) {
          main.shift()
        }
        pending = ''
      }

      return next(e)
    }
    const job = agents.get(e.agentId)
    if (job !== undefined) {
      agents.delete(e.agentId)
      const ms = (await $.clock.now()) - job.startedAt
      await push(
        $,
        e.isAborted
          ? { role: 'error', text: 'The request was interrupted.' }
          : { role: 'assistant', text: e.answer, model: job.model, ms },
      )
      await finish($)
    }

    return next(e)
  })

  on('command.run', { command: 'side' }, async ($, e) => {
    await open($)
    if (e.args.trim() !== '') {
      void send($, e.args)
    }

    return { text: 'Side chat opened.' }
  })

  on('command.run', { command: 'side-model' }, async ($, e) => {
    const wanted = e.args.trim()
    if (wanted === '') {
      return { text: `Side chat model: ${await read($, model)}. Set it with /side-model <model>.` }
    }
    await update($, model, () => wanted)
    await $.store.set(STORE_MODEL, wanted)

    return { text: `Side chat now uses ${wanted}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    if (!('Input' in ui)) {
      return (
        <ui.Box>
          <ui.Text dimColor>The side chat needs a terminal, desktop or VS Code surface.</ui.Text>
        </ui.Box>
      )
    }
    const { Box, Text, Button, Input, Select, Markdown } = ui
    const list = await read($, messages)
    const using = await read($, model)
    const how = await read($, mode)
    const job = await read($, running)
    const seconds = job === null ? 0 : await read($, ticks)
    const info = MODES[how]
    const last = list[list.length - 1]

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold color="claude">
            Side chat
          </Text>
          {list.length > 0 && job === null && (
            <Button key="clear" plain dimColor label="Clear" onPress={() => void update($, messages, () => [])} />
          )}
        </Box>

        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
          <Box flexDirection="row" gap={1}>
            {(['ask', 'task'] as const).map(value => (
              <Button
                key={`mode-${value}`}
                label={`${how === value ? '● ' : ''}${MODES[value].label}`}
                variant={how === value ? 'primary' : 'secondary'}
                onPress={() => void update($, mode, () => value)}
              />
            ))}
          </Box>
          <Select
            key="model"
            label="Model"
            value={using}
            options={modelOptions(using).map(value => ({ value }))}
            onSelect={value => {
              void update($, model, () => value)
              void $.store.set(STORE_MODEL, value)
            }}
          />
        </Box>

        {list.length === 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} gap={1}>
            <Text bold>{info.title}</Text>
            <Text dimColor>{info.blurb}</Text>
            <Box flexDirection="column">
              <Text dimColor>Try one:</Text>
              {SUGGESTIONS[how].map((text, i) => (
                <Box flexDirection="row">
                  <Button key={`try-${i}`} label={text} onPress={() => void send($, text)} />
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {list.length > 0 && (
          <Box flexDirection="column" gap={1}>
            {list.map(m =>
              m.role === 'user' ? (
                <Box alignSelf="flex-end" borderStyle="round" borderColor="subtle" paddingX={1}>
                  <Text>{m.text}</Text>
                </Box>
              ) : m.role === 'error' ? (
                <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
                  <Text color="error">{m.text}</Text>
                  {m.id === last?.id && job === null && (
                    <Box flexDirection="row">
                      <Button key="retry" label="Retry" onPress={() => void retry($)} />
                    </Box>
                  )}
                </Box>
              ) : (
                <Box flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text bold color="claude">
                      ●
                    </Text>
                    <Text bold>{m.model ?? 'assistant'}</Text>
                    {m.ms !== undefined && <Text dimColor>{formatDuration(m.ms)}</Text>}
                  </Box>
                  <Box flexDirection="column" paddingLeft={2}>
                    <Markdown text={m.text} />
                    <Box flexDirection="row">
                      <Button
                        key={`copy-${m.id}`}
                        plain
                        dimColor
                        label="Copy"
                        onPress={press =>
                          void $.ui
                            .copy({ text: m.text, surface: press.surface })
                            .then(r => $.ui.toast(r.isCopied ? 'Copied to the clipboard' : 'Could not copy'))
                        }
                      />
                    </Box>
                  </Box>
                </Box>
              ),
            )}
          </Box>
        )}

        {job !== null ? (
          <Box flexDirection="row" gap={1} borderStyle="round" borderColor="claude" paddingX={1}>
            <Text color="claude">{pulse(seconds)}</Text>
            <Text>{`${job.model} is ${MODES[job.mode].verb}`}</Text>
            {seconds > 0 && <Text dimColor>{formatElapsed(seconds)}</Text>}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Input
              key={`ask-${list.length}`}
              placeholder={info.placeholder}
              submitLabel="send"
              autoFocus
              onSubmit={value => void send($, value)}
            />
            <Text dimColor>{info.hint}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
