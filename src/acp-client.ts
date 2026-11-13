/**
 * VibeAcpClient — spawns `vibe-acp` (the Mistral Vibe agent) and speaks the
 * Agent Client Protocol on stdin/stdout.
 *
 * ACP is JSON-RPC 2.0 over stdio: one JSON object per line, requests carry
 * an `id`, responses carry the same `id`, and everything else is a
 * notification. The agent streams its work as `session/update`
 * notifications while `session/prompt` is still pending — that stream is the
 * only way to see the answer as it is written, so the client keeps it.
 *
 * Protocol rules this client honours:
 * - one JSON object per line, terminated by LF;
 * - `initialize` comes first, then `notifications/initialized`;
 * - a session is created with `session/new` and can be reloaded with
 *   `session/load` when the agent advertises `loadSession`;
 * - `session/prompt` resolves when the turn ends, not when it starts; the
 *   answer arrives through the update stream;
 * - `session/cancel` stops the in-flight prompt;
 * - `session/request_permission` is an agent request: the client answers it.
 */

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { spawnVibe } from './spawn.ts'

/** One JSON-RPC message. */
export interface AcpMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number, message?: string, data?: unknown }
}

/** The update kinds this client understands. */
export type AcpSessionUpdate =
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'user_message_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'usage_update'
  | 'session_info_update'
  | 'available_commands_update'
  | (string & {})

/** One `session/update` notification, flattened for the driver's use. */
export interface AcpUpdate {
  kind: AcpSessionUpdate
  sessionId: string
  raw: Record<string, unknown>
}

/** One config option the agent offers for a session. */
export interface AcpConfigOption {
  id: string
  currentValue?: string
  options?: { value?: string, name?: string, description?: string }[]
}

/** The agent's advertised capabilities. */
export interface AcpCapabilities {
  loadSession?: boolean
  promptCapabilities?: { image?: boolean, audio?: boolean, embeddedContext?: boolean }
  sessionCapabilities?: { list?: unknown, fork?: unknown, close?: unknown }
}

export interface VibeAcpClientOptions {
  /** `vibe-acp` executable; defaults to `vibe-acp` resolved from PATH. */
  vibePath?: string
  /** Extra arguments passed to the executable. */
  args?: string[]
  /** Working directory for the Vibe session. */
  cwd: string
  /** Vibe model id (`mistral-large-4-0-3`), applied when the session offers it. */
  model?: string
  /** Abort signal that kills the child process. */
  signal?: AbortSignal
  /** Log sink for protocol diagnostics. */
  logger?: (line: string) => void
  /** Per-request timeout in ms. `0` disables the timeout. Default 600000. */
  requestTimeoutMs?: number
  /** Grace period before a still-running child is killed after `close()`. */
  closeGraceMs?: number
  /**
   * How a `session/request_permission` request is answered.
   *
   * `allow-once` (the default) approves the single call the agent asked
   * for; `deny` refuses it. A standing grant is never given.
   */
  permission?: 'allow-once' | 'deny'
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
  method: string
}

export class VibeAcpClient {
  readonly cwd: string
  /** The ACP session id of the live session, once it exists. */
  sessionId: string | undefined
  /** The agent's capabilities, as answered by `initialize`. */
  capabilities: AcpCapabilities = {}
  /** The config options the live session offers (model, thinking, mode). */
  configOptions: AcpConfigOption[] = []

  private readonly proc: ChildProcess
  private readonly updates = new EventEmitter()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly logger?: (line: string) => void
  private readonly requestTimeoutMs: number
  private readonly closeGraceMs: number
  private readonly permission: 'allow-once' | 'deny'
  private buffer = ''
  private closed = false
  private exited = false
  private nextId = 0
  private killTimer: NodeJS.Timeout | undefined
  private readonly exitPromise: Promise<{ code: number | null, signal: NodeJS.Signals | null }>
  private resolveExit!: (info: { code: number | null, signal: NodeJS.Signals | null }) => void
  private initialized = false

  constructor(options: VibeAcpClientOptions) {
    this.cwd = resolve(options.cwd)
    this.logger = options.logger
    this.requestTimeoutMs = options.requestTimeoutMs ?? 600_000
    this.closeGraceMs = options.closeGraceMs ?? 5_000
    this.permission = options.permission ?? 'allow-once'
    this.exitPromise = new Promise((resolvePromise) => {
      this.resolveExit = resolvePromise
    })
    this.proc = spawnVibe(options.vibePath ?? 'vibe-acp', options.args ?? [], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
      windowsHide: true,
    })
    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr!.setEncoding('utf8')
    this.proc.stderr!.on('data', (chunk: string) => this.logger?.(`[vibe:stderr] ${chunk.trimEnd()}`))
    this.proc.on('error', (error) => {
      this.logger?.(`[vibe:error] ${String(error)}`)
      this.failAll(new Error(`vibe-acp process failed to start: ${String(error)}`))
    })
    this.proc.on('exit', (code, signal) => {
      this.closed = true
      this.exited = true
      if (this.killTimer !== undefined) {
        clearTimeout(this.killTimer)
        this.killTimer = undefined
      }
      this.logger?.(`[vibe:exit] code=${String(code)} signal=${String(signal)}`)
      this.failAll(new Error(`vibe-acp process exited (code=${String(code)} signal=${String(signal)})`))
      this.updates.emit('exit', { code, signal })
      this.resolveExit({ code, signal })
    })
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', () => {
        this.close()
      }, { once: true })
    }
  }

  /** Whether the child process is still alive. */
  get running(): boolean {
    return !this.closed && !this.exited
  }

  /** Resolves when the child process exits. */
  whenExit(): Promise<{ code: number | null, signal: NodeJS.Signals | null }> {
    return this.exitPromise
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.logger?.(`[vibe:bad-json] ${line.slice(0, 200)}`)
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const record = message as AcpMessage
    if (record.method !== undefined) {
      this.onNotification(record)
      return
    }
    if (record.id === undefined) return
    const entry = this.pending.get(Number(record.id))
    if (!entry) return
    this.pending.delete(Number(record.id))
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (record.error !== undefined) {
      entry.reject(new Error(`${entry.method} failed: ${record.error.message ?? JSON.stringify(record.error)}`))
      return
    }
    entry.resolve(record.result)
  }

  /** Route an agent request or notification. */
  private onNotification(message: AcpMessage): void {
    const method = message.method ?? ''
    if (method === 'session/update') {
      const params = (message.params ?? {}) as { sessionId?: string, update?: Record<string, unknown> }
      const update = params.update ?? {}
      const kind = (update.sessionUpdate as string | undefined) ?? 'unknown'
      this.updates.emit('update', {
        kind,
        sessionId: params.sessionId ?? this.sessionId ?? '',
        raw: update,
      } satisfies AcpUpdate)
      return
    }
    if (method === 'session/request_permission') {
      this.answerPermission(message)
      return
    }
    this.logger?.(`[vibe:notification] ${method}`)
  }

  /**
   * Answer the agent's permission request.
   *
   * The agent asks before a tool runs; the client answers for one call only
   * (`allow_once`) or refuses it. A standing grant is never given, so the
   * agent asks again for the next call.
   */
  private answerPermission(message: AcpMessage): void {
    const params = (message.params ?? {}) as {
      options?: { kind?: string, optionId?: string, id?: string, name?: string }[]
    }
    const options = params.options ?? []
    const allowOnce = options.find(option => {
      const kind = String(option.kind ?? '')
      const id = String(option.optionId ?? option.id ?? '')
      return kind === 'allow_once' || id.toLowerCase().startsWith('allow_once')
    })
    const deny = options.find(option => {
      const kind = String(option.kind ?? '')
      const id = String(option.optionId ?? option.id ?? '')
      return kind === 'reject' || kind === 'deny' || id.toLowerCase().startsWith('reject')
    })
    const chosen = this.permission === 'deny' ? deny : allowOnce ?? deny
    const optionId = chosen?.optionId ?? chosen?.id
    this.logger?.(`[vibe:permission] answered ${this.permission} (${String(optionId ?? 'none')})`)
    if (message.id === undefined) return
    const outcome = optionId === undefined
      ? { outcome: 'cancelled' }
      : { outcome: 'selected', optionId }
    this.send({ jsonrpc: '2.0', id: message.id, result: { outcome } })
  }

  /**
   * Send one JSON-RPC request and await its response.
   *
   * @param method - the RPC method.
   * @param params - the request parameters.
   * @param timeoutMs - timeout override; `0` disables it.
   */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.running) return Promise.reject(new Error('vibe-acp process is not running'))
    const id = ++this.nextId
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs
    return new Promise<unknown>((resolvePromise, reject) => {
      const timer = effectiveTimeout > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`vibe-acp request "${method}" timed out after ${effectiveTimeout}ms`))
          }, effectiveTimeout)
        : undefined
      timer?.unref?.()
      this.pending.set(id, { resolve: resolvePromise, reject, timer, method })
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      this.logger?.(`[vibe:cmd] ${line.slice(0, 200)}`)
      this.proc.stdin!.write(`${line}\n`, (error) => {
        if (!error) return
        const entry = this.pending.get(id)
        this.pending.delete(id)
        if (entry?.timer !== undefined) clearTimeout(entry.timer)
        reject(error)
      })
    })
  }

  /** Send one notification (a message without an id). */
  notify(method: string, params: unknown): void {
    if (!this.running) return
    const line = JSON.stringify({ jsonrpc: '2.0', method, params })
    this.logger?.(`[vibe:notify] ${line.slice(0, 200)}`)
    this.proc.stdin!.write(`${line}\n`)
  }

  /** Answer an agent request with a result. */
  private send(message: AcpMessage): void {
    if (!this.running) return
    this.proc.stdin!.write(`${JSON.stringify(message)}\n`)
  }

  /** Perform the ACP handshake. Safe to call once per process. */
  async initialize(): Promise<void> {
    if (this.initialized) return
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 60_000)
    this.initialized = true
    this.capabilities = ((result as { agentCapabilities?: AcpCapabilities } | undefined)?.agentCapabilities ?? {})
    this.logger?.(`[vibe:init] ${JSON.stringify(this.capabilities)}`)
    this.notify('notifications/initialized', {})
  }

  /** Create a fresh Vibe session and remember its id and options. */
  async newSession(): Promise<string> {
    await this.initialize()
    const result = await this.request('session/new', {
      cwd: this.cwd,
      mcpServers: [],
    }, 120_000)
    const payload = (result ?? {}) as { sessionId?: string, configOptions?: AcpConfigOption[] }
    this.sessionId = payload.sessionId ?? ''
    this.configOptions = payload.configOptions ?? []
    if (this.sessionId === '') throw new Error('vibe-acp session/new returned no sessionId')
    this.logger?.(`[vibe:session] new ${this.sessionId}`)
    return this.sessionId
  }

  /**
   * Reload an existing Vibe session.
   *
   * @throws when the agent does not advertise `loadSession` or the session is gone.
   */
  async loadSession(sessionId: string): Promise<string> {
    await this.initialize()
    if (this.capabilities.loadSession !== true) {
      throw new Error('vibe-acp does not advertise loadSession')
    }
    const result = await this.request('session/load', {
      sessionId,
      cwd: this.cwd,
      mcpServers: [],
    }, 120_000)
    const payload = (result ?? {}) as { sessionId?: string, configOptions?: AcpConfigOption[] }
    this.sessionId = payload.sessionId ?? sessionId
    this.configOptions = payload.configOptions ?? this.configOptions
    this.logger?.(`[vibe:session] loaded ${this.sessionId}`)
    return this.sessionId
  }

  /** The values a config option offers. */
  optionValues(configId: string): string[] {
    const option = this.configOptions.find(entry => entry.id === configId)
    return (option?.options ?? []).map(entry => String(entry.value ?? '')).filter(value => value !== '')
  }

  /** The value a config option currently holds. */
  optionCurrent(configId: string): string | undefined {
    const option = this.configOptions.find(entry => entry.id === configId)
    return option?.currentValue
  }

  /** Set one config option (for example `model`). */
  async setOption(configId: string, value: string): Promise<void> {
    if (this.sessionId === undefined) throw new Error('no vibe-acp session')
    const result = await this.request('session/set_config_option', {
      sessionId: this.sessionId,
      configId,
      value,
    }, 60_000)
    const payload = (result ?? {}) as { configOptions?: AcpConfigOption[] }
    if (Array.isArray(payload.configOptions)) this.configOptions = payload.configOptions
  }

  /**
   * Send one prompt and wait until the turn ends.
   *
   * The answer arrives through the update stream while this promise is
   * pending; the result only carries the stop reason and the token usage.
   */
  async prompt(text: string, timeoutMs?: number): Promise<{ stopReason?: string, usage?: unknown }> {
    if (this.sessionId === undefined) throw new Error('no vibe-acp session')
    const result = await this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    }, timeoutMs)
    return (result ?? {}) as { stopReason?: string, usage?: unknown }
  }

  /** Stop the in-flight prompt. */
  async cancel(): Promise<void> {
    if (this.sessionId === undefined) return
    try {
      await this.request('session/cancel', { sessionId: this.sessionId }, 30_000)
    } catch {
      // The prompt may already be over, or the process gone.
    }
  }

  /** Subscribe to session updates. Returns an unsubscribe function. */
  onUpdate(listener: (update: AcpUpdate) => void): () => void {
    this.updates.on('update', listener)
    return () => this.updates.off('update', listener)
  }

  /** Subscribe to the child exit. Returns an unsubscribe function. */
  onExit(listener: (info: { code: number | null, signal: NodeJS.Signals | null }) => void): () => void {
    this.updates.on('exit', listener)
    return () => this.updates.off('exit', listener)
  }

  /**
   * Stop the child.
   *
   * The pipe is closed first and the process is killed only if it lingers.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.proc.stdin?.end()
    } catch {
      // already gone
    }
    if (this.exited) return
    this.killTimer = setTimeout(() => {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, this.closeGraceMs)
    this.killTimer.unref?.()
  }
}
