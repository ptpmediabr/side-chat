import type { Message, Mode } from '../types'

export type Exchange = { q: string; a: string }

export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export const DEFAULT_MODEL = 'haiku'

const CLIP = 2000

export const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}…` : s)

// The picker's options: the aliases, plus a custom id while one is selected.
export const modelOptions = (current: string) =>
  (MODELS as readonly string[]).includes(current) ? [...MODELS] : [...MODELS, current]

export const mainContext = (main: readonly Exchange[]) =>
  main.length === 0
    ? ''
    : 'Recent main conversation (background only):\n' +
      main.map(x => `User: ${x.q}\nAssistant: ${x.a}`).join('\n\n')

// The side thread as one prompt; its last line is the message being answered.
export const threadPrompt = (thread: readonly Message[]) =>
  thread
    .filter(m => m.role !== 'error')
    .map(m => `${m.role === 'user' ? 'User' : 'You'}: ${clip(m.text)}`)
    .join('\n\n')

// Where Claude Code keeps a session's transcript: one JSONL per session id,
// under a folder named after the working directory.
export const transcriptPath = (home: string, cwd: string, id: string) =>
  `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`

type Row = {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: { content?: string | readonly { type?: string; text?: string; name?: string }[] }
}

// The main thread's rows as plain lines: what the person typed, what the
// assistant wrote, and one mark per tool it called. Tool output is left out.
export const parseTranscript = (jsonl: string): string[] => {
  const out: string[] = []
  for (const line of jsonl.split('\n')) {
    if (line === '') {
      continue
    }
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    const isTurn = row.type === 'user' || row.type === 'assistant'
    if (!isTurn || row.isMeta === true || row.isSidechain === true) {
      continue
    }
    const who = row.type === 'user' ? 'User' : 'Assistant'
    const content = row.message?.content
    if (typeof content === 'string') {
      out.push(`${who}: ${content}`)
      continue
    }
    for (const block of content ?? []) {
      if (block.type === 'text' && block.text !== undefined && block.text !== '') {
        out.push(`${who}: ${block.text}`)
      } else if (block.type === 'tool_use') {
        out.push(`Assistant: [used the ${block.name ?? 'unknown'} tool]`)
      }
    }
  }

  return out
}

// The newest lines that fit the budget, oldest first.
export const newest = (lines: readonly string[], budget: number): string => {
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''
    if (used + line.length > budget && kept.length > 0) {
      break
    }
    kept.unshift(line.length > budget ? `…${line.slice(-budget)}` : line)
    used += line.length
  }

  return kept.join('\n\n')
}

// How long an answer took, as the thread shows it: 340ms, 2.4s, 18s, 1m 05s.
export const formatDuration = (ms: number) => {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`
  }
  const seconds = ms / 1000
  if (seconds < 10) {
    return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`
  }
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`
  }

  return `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
}

// The clock of a request in flight, in whole seconds: 7s, 1m 05s.
export const formatElapsed = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`

// One frame of the waiting marker per second the request has run.
const FRAMES = ['●○○', '○●○', '○○●', '○●○'] as const
export const pulse = (ticks: number) => FRAMES[Math.max(0, ticks) % FRAMES.length]

// The thread without the errors that end it: what a retry runs again.
export const withoutTrailingErrors = (thread: readonly Message[]) => {
  let end = thread.length
  while (end > 0 && thread[end - 1]?.role === 'error') {
    end -= 1
  }

  return thread.slice(0, end)
}

// What each mode says about itself, where the pane draws it.
export const MODES: Record<
  Mode,
  { label: string; title: string; blurb: string; placeholder: string; hint: string; verb: string }
> = {
  ask: {
    label: 'Ask',
    title: 'Ask about this session',
    blurb: 'A model that has read the main conversation answers here, apart from it. No tools, nothing is changed.',
    placeholder: 'Ask a question…',
    hint: 'Answers from the main session as background · no tools',
    verb: 'thinking',
  },
  task: {
    label: 'Request',
    title: 'Hand a job to an agent',
    blurb: 'An agent with tools works on it in this session and reports back. The main thread keeps going.',
    placeholder: 'Describe the request…',
    hint: 'An agent with tools runs it · it may read and change files',
    verb: 'working',
  },
}

export const SUGGESTIONS: Record<Mode, readonly string[]> = {
  ask: [
    'Summarize what we have done so far',
    'What should I double-check before moving on?',
    'Explain the last error in plain words',
  ],
  task: ['Review the latest changes for bugs', 'List the TODOs left in the code', 'Check that the project still builds'],
}
