export type Mode = 'ask' | 'task'

export type Message = {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  model?: string
  // How long the answer took, in milliseconds.
  ms?: number
}

// The request in flight: what it runs on and how, kept apart from the pickers
// so a change of either while it runs does not relabel it.
export type Running = { model: string; mode: Mode }

declare module 'claude-code' {
  interface PluginState {
    'side-chat': {
      messages: Message[]
      model: string
      mode: Mode
      running: Running | null
      // Seconds the request in flight has run; drives its clock.
      ticks: number
    }
  }
}
