/**
 * Test doubles for the DSH session and the Vibe ACP client.
 *
 * The session double records the durable log exactly like `dsh-session` does
 * (seq/time/data plus the surface metadata), so the agent's translation can
 * be asserted on the real event vocabulary.
 */

/** A minimal `Session` stand-in that records every appended event. */
export class FakeSession {
  constructor(id = 'session-1', header = {}) {
    this.id = id
    this.header = { version: 1, id, createdAt: Date.now(), seedLength: 0, cwd: '/tmp/project', ...header }
    this.events = []
    this.inheritedEventCount = 0
  }

  append(type, data, opts) {
    const seq = this.events.length
    const time = Date.now()
    const event = { type, seq, time, data }
    if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp
    if (opts?.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs
    this.events.push(event)
    return event
  }

  /** The session log after the fork-inherited prefix. */
  snapshotEvents(from = 0) {
    return this.events.slice(from)
  }

  get seq() {
    return this.events.length
  }

  /** Every event of one type. */
  ofType(type) {
    return this.events.filter((event) => event.type === type)
  }

  /** The last event of one type. */
  last(type) {
    const matching = this.ofType(type)
    return matching[matching.length - 1]
  }
}

/**
 * A `VibeAcpClient` stand-in that records the prompts and lets the test push
 * ACP updates back into the agent.
 */
export class FakeAcp {
  constructor(options = {}) {
    this.updateListeners = new Set()
    this.exitListeners = new Set()
    this.prompts = []
    this.cancelled = false
    this.closed = false
    this.sessionId = options.sessionId ?? 'vibe-session-1'
    this.capabilities = options.capabilities ?? { loadSession: true }
    this.configOptions = options.configOptions ?? [
      { id: 'model', currentValue: 'mistral-large-4-0-3', options: [{ value: 'mistral-large-4-0-3' }] },
    ]
    this.usage = options.usage ?? { inputTokens: 120, outputTokens: 8, cachedReadTokens: 4 }
    /** The updates emitted for each prompt, in order. */
    this.replies = options.replies ?? []
    /** When true, a prompt stays pending until `release()` is called. */
    this.hold = options.hold ?? false
    this.releasePrompt = undefined
  }

  onUpdate(listener) {
    this.updateListeners.add(listener)
    return () => this.updateListeners.delete(listener)
  }

  onExit(listener) {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Push one ACP update into the agent. */
  emit(update) {
    for (const listener of [...this.updateListeners]) {
      listener({ kind: update.kind, sessionId: this.sessionId, raw: update.raw ?? {} })
    }
  }

  /** Push the child-process exit into the agent. */
  exit(info = { code: 0, signal: null }) {
    for (const listener of [...this.exitListeners]) listener(info)
  }

  optionValues(configId) {
    const option = this.configOptions.find((entry) => entry.id === configId)
    return (option?.options ?? []).map((entry) => entry.value)
  }

  optionCurrent(configId) {
    return this.configOptions.find((entry) => entry.id === configId)?.currentValue
  }

  async setOption(configId, value) {
    const option = this.configOptions.find((entry) => entry.id === configId)
    if (option) option.currentValue = value
  }

  async newSession() {
    return this.sessionId
  }

  async loadSession(sessionId) {
    this.sessionId = sessionId
    return sessionId
  }

  async prompt(text) {
    this.prompts.push(text)
    const reply = this.replies.shift()
    if (reply !== undefined) {
      for (const update of reply) this.emit(update)
    }
    if (this.hold) {
      await new Promise((resolve) => {
        this.releasePrompt = resolve
      })
    }
    return { stopReason: 'end_turn', usage: this.usage }
  }

  /** Let a held prompt finish. */
  release() {
    this.releasePrompt?.()
    this.releasePrompt = undefined
  }

  async cancel() {
    this.cancelled = true
  }

  close() {
    this.closed = true
  }
}

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
export async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Let the microtask queue drain. */
export function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
