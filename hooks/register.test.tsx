import { expect, mock, test } from 'claude-code/testing'

import {
  SUGGESTIONS,
  formatDuration,
  formatElapsed,
  modelOptions,
  newest,
  parseTranscript,
  pulse,
  threadPrompt,
  transcriptPath,
  withoutTrailingErrors,
} from './lib'

const PANE = {
  component: 'Pane',
  requestId: 'side-chat',
  props: {
    title: 'Side chat',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the picker keeps a custom model beside the aliases', () => {
  expect(modelOptions('haiku')).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
  expect(modelOptions('claude-x')).toEqual(['haiku', 'sonnet', 'opus', 'fable', 'claude-x'])
})

test('the thread prompt leaves errors out', () => {
  expect(
    threadPrompt([
      { id: '1', role: 'user', text: 'hi' },
      { id: '2', role: 'error', text: 'boom' },
      { id: '3', role: 'assistant', text: 'hello' },
    ]),
  ).toBe('User: hi\n\nYou: hello')
})

test('the transcript is read as the main thread alone', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    JSON.stringify({ type: 'user', isMeta: true, message: { content: 'hidden' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: 'aside' } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking' }, { type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }] },
    }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    'not json',
  ].join('\n')
  expect(parseTranscript(jsonl)).toEqual(['User: hello', 'Assistant: hi', 'Assistant: [used the Bash tool]'])
  expect(newest(['aaaa', 'bbbb', 'cc'], 6)).toBe('bbbb\n\ncc')
  expect(transcriptPath('/Users/me', '/Users/me/My Proj', 'abc')).toBe(
    '/Users/me/.claude/projects/-Users-me-My-Proj/abc.jsonl',
  )
})

test('a duration reads short, then in seconds, then in minutes', () => {
  expect(formatDuration(340)).toBe('340ms')
  expect(formatDuration(2450)).toBe('2.4s')
  expect(formatDuration(18999)).toBe('18s')
  expect(formatDuration(59999)).toBe('59s')
  expect(formatDuration(65000)).toBe('1m 05s')
})

test('the clock of a running request counts whole seconds', () => {
  expect([7, 59, 60, 65, 600].map(formatElapsed)).toEqual(['7s', '59s', '1m 00s', '1m 05s', '10m 00s'])
})

test('the waiting marker moves one step a second and wraps', () => {
  expect([0, 1, 2, 3, 4].map(pulse)).toEqual(['●○○', '○●○', '○○●', '○●○', '●○○'])
})

test('a retry drops only the errors that end the thread', () => {
  const thread = [
    { id: '1', role: 'user', text: 'a' },
    { id: '2', role: 'error', text: 'early' },
    { id: '3', role: 'user', text: 'b' },
    { id: '4', role: 'error', text: 'x' },
    { id: '5', role: 'error', text: 'y' },
  ] as const
  expect(withoutTrailingErrors(thread).map(m => m.id)).toEqual(['1', '2', '3'])
})

test('an empty pane offers suggestions for the mode, and a press sends one', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  on('session.id', () => ({ value: 'abc' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  let prompt = ''
  on('model.complete', (_, e) => {
    prompt = e.prompt

    return { value: { isAnswered: true, text: 'done', usage: {} as never } }
  })

  const ui = await $.ui.mount({ plugin: 'side-chat', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Ask about this session/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'try-0' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'clear' })).toBeUndefined()

  await ui.press({ key: 'mode-task' })
  expect(await ui.find({ type: 'Text', text: /Hand a job to an agent/ })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'try-0' }))?.text).toContain(SUGGESTIONS.task[0])
  await ui.press({ key: 'mode-ask' })

  await ui.press({ key: 'try-1' })
  expect(prompt).toContain(SUGGESTIONS.ask[1])
  expect(await ui.find({ type: 'Text', text: /Ask about this session/ })).toBeUndefined()
  await ui.unmount()
})

test('a question is answered by the selected model, with how long it took', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'abc' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', (_, e) => ({ value: e.path === '/home/me/.claude/projects/-work/abc.jsonl' }))
  on('fs.read', () => ({ value: JSON.stringify({ type: 'user', message: { content: 'the secret is 7' } }) }))
  const asked: string[] = []
  let system = ''
  on('model.complete', (_, e) => {
    asked.push(e.model)
    system = e.system ?? ''

    return { value: { isAnswered: true, text: 'forty-two', usage: {} as never } }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'side-chat', surface, ...PANE })
    await ui.select({ key: 'model', value: 'opus' })
    const field = await ui.find({ type: 'Input' })
    await ui.input({ key: field?.key ?? '', text: 'what is the answer?' })
    expect(await ui.find({ type: 'Markdown', text: /forty-two/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /what is the answer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^opus$/ })).toBeDefined()
    const copies = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('copy-'))
    expect(copies).toHaveLength(1)
    expect(await ui.find({ type: 'Input' })).toBeDefined()
    await ui.press({ key: 'clear' })
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
    await ui.unmount()
  }
  expect(asked).toEqual(['opus', 'opus'])
  expect(system).toContain('User: the secret is 7')
})

test('a failed answer shows its error, and a retry asks again without repeating the question', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  on('session.id', () => ({ value: 'abc' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  let calls = 0
  on('model.complete', () => {
    calls += 1

    return {
      value:
        calls === 1
          ? { isAnswered: false, reason: 'overloaded' }
          : { isAnswered: true, text: 'second time lucky', usage: {} as never },
    } as never
  })

  const ui = await $.ui.mount({ plugin: 'side-chat', surface: 'desktop', ...PANE })
  const field = await ui.find({ type: 'Input' })
  await ui.input({ key: field?.key ?? '', text: 'will it work?' })
  expect(await ui.find({ type: 'Text', text: /did not answer: overloaded/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'retry' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'clear' })).toBeDefined()

  await ui.press({ key: 'retry' })
  expect(calls).toBe(2)
  expect(await ui.find({ type: 'Markdown', text: /second time lucky/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'retry' })).toBeUndefined()
  expect(await ui.findAll({ type: 'Text', text: /will it work/ })).toHaveLength(1)
  await ui.unmount()
})

test('while a question runs the pane says what runs and for how long, and takes no new one', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  on('session.id', () => ({ value: 'abc' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  on('model.complete', async () => {
    await clock.sleep(2500)

    return { value: { isAnswered: true, text: 'late answer', usage: {} as never } }
  })

  const ui = await $.ui.mount({ plugin: 'side-chat', surface: 'desktop', ...PANE })
  await ui.select({ key: 'model', value: 'sonnet' })
  const field = await ui.find({ type: 'Input' })
  await ui.input({ key: field?.key ?? '', text: 'a slow one' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /sonnet is thinking/ })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'clear' })).toBeUndefined()

  // Moving the picker while it runs does not relabel the request.
  await ui.select({ key: 'model', value: 'opus' })
  expect(await ui.find({ type: 'Text', text: /sonnet is thinking/ })).toBeDefined()

  await clock.advance(2000)
  expect(await ui.find({ type: 'Text', text: /^2s$/ })).toBeDefined()
  await clock.advance(1000)
  expect(await ui.find({ type: 'Markdown', text: /late answer/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^sonnet$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^2\.5s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeDefined()
  await ui.unmount()
})
