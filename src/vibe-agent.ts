/**
 * VibeAgent — a DSH `Agent` implementation whose driver is the Mistral Vibe
 * agent running headless in a child process (`vibe-acp`, over the Agent
 * Client Protocol).
 *
 * DSH's frontend, session log and hooks program against the `Agent`
 * interface (`@deepseek-ai/dsh-agent`); this class satisfies that contract
 * and translates Vibe's ACP update stream into DSH's durable session events
 * (`turn/*`, `step/*`, `user/message`, `assistant/message`, `tool/call`,
 * `tool/result`).
 *
 * ## Boundary mapping
 *
 * | DSH | Vibe (ACP) |
 * | --- | --- |
 * | one turn | one `session/prompt` (one Vibe run) |
 * | one step | one assistant turn (one model call plus the tools it ran) |
 * | step boundary | the `session/prompt` response (the turn ended) |
 * | next-step input | queued: ACP has no mid-run steering, so it rides the next prompt |
 *
 * The driver follows `@deepseek-ai/dsh-agent-loop`'s phase model: a single
 * `idle | running | maintenance` phase owns the abort controller, the wake
 * latch and the activity promise that `whenIdle()` follows.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import {
  agentEvents,
  type Agent,
  type AgentEventDispatch,
  type AgentOptions,
  type AgentStatus,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  createAssistantMessage,
  createToolResultMessage,
  LlmAttemptId,
  ToolCallId,
  type AssistantStreamRecord,
  type ContentBlock,
  type StreamChunk,
  type TokenUsage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  AgentCancelCause,
  Session,
  SessionId,
  SessionSeq,
  TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { VibeInbox, type VibeInboxNotifications } from './inbox.ts'
import { VibeModel } from './model.ts'
import type { AcpUpdate, VibeAcpClient } from './acp-client.ts'

export interface VibeAgentOptions {
  /** Base context whose dependency API the agent's own scope inherits. */
  ctx: Context
  session: Session
  agentOptions: AgentOptions
  acp: VibeAcpClient
  /**
   * The session's last turn number.
   *
   * A resumed agent continues the session's turn sequence: the next turn is
   * `lastTurn + 1`. Restarting at 1 would open a turn the session never
   * opened, and the durable log would reject the boundary.
   */
  lastTurn?: number
  /** Diagnostics sink. */
  logger?: (line: string) => void
}

/**
 * The agent's lifecycle phase.
 *
 * - `idle`: no driver and no maintenance task owns the agent;
 * - `running`: a driver owns the agent and drains turns;
 * - `maintenance`: a non-turn task owns the agent (public status stays idle).
 */
type Phase =
  | { kind: 'idle', lastTurn: number }
  | { kind: 'running', abort: AbortController, turn: number, step: number, wakeRequested: boolean }
  | { kind: 'maintenance', abort: AbortController, lastTurn: number, wakeRequested: boolean }

/** Minimal deferred, kept local so the package still runs on Node 20. */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Extract the text of an ACP content block. */
function acpText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object') return ''
  const record = content as { type?: string, text?: unknown }
  if (record.type === 'text' && typeof record.text === 'string') return record.text
  if (typeof record.text === 'string') return record.text
  return ''
}

/** Map Vibe's token report onto DSH's token accounting. */
function convertUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as {
    inputTokens?: unknown
    outputTokens?: unknown
    cachedReadTokens?: unknown
    totalTokens?: unknown
    promptTokens?: unknown
    completionTokens?: unknown
    cachedTokens?: unknown
  }
  const input = typeof record.inputTokens === 'number'
    ? record.inputTokens
    : typeof record.promptTokens === 'number' ? record.promptTokens : undefined
  const output = typeof record.outputTokens === 'number'
    ? record.outputTokens
    : typeof record.completionTokens === 'number' ? record.completionTokens : undefined
  if (input === undefined || output === undefined) return undefined
  const cached = typeof record.cachedReadTokens === 'number'
    ? record.cachedReadTokens
    : typeof record.cachedTokens === 'number' ? record.cachedTokens : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
  }
}

/**
 * Convert a Vibe tool outcome into DSH content blocks.
 *
 * ACP reports a tool result as a list of content items (`{type:'content',
 * content:{type:'text', text}}`). The DSH `tool/result` message carries the
 * *content*, so the envelope must be unwrapped.
 */
function convertToolResult(content: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const items = Array.isArray(content) ? content : content === undefined ? [] : [content]
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as { type?: string, content?: unknown, text?: unknown }
    if (record.type === 'content') {
      const text = acpText(record.content)
      blocks.push({ type: 'text', text })
      continue
    }
    if (typeof record.text === 'string') {
      blocks.push({ type: 'text', text: record.text })
      continue
    }
    blocks.push({ type: 'text', text: JSON.stringify(item) })
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

/** Extract the text payload of a DSH UserMessage for the Vibe prompt. */
function extractDshText(message: UserMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

export class VibeAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: VibeInbox
  readonly model: VibeModel
  readonly ctx: Context

  private readonly acp: VibeAcpClient
  private readonly scope: Scope
  private readonly dispatch: AgentEventDispatch
  private readonly disposeScope: () => void
  private readonly unwatch: () => void
  private readonly unwatchExit: () => void
  private readonly logger?: (line: string) => void

  private phase: Phase = { kind: 'idle', lastTurn: 0 }
  private activityDone: Promise<void> = Promise.resolve()
  private cancelCause: AgentCancelCause | undefined

  /** Step bookkeeping. */
  private turn = 0
  private step = 0
  private stepOpen = false
  /** Compact provider stream of the assistant message currently being built. */
  private stream = new AssistantStreamAccumulator()
  /** Identity of the assistant attempt currently streaming. */
  private attemptId: LlmAttemptId | undefined
  /** Monotone revision of the assistant attempts of this agent. */
  private attemptRevision = 0
  /** Number of chunk frames published for the current attempt. */
  private chunkIndex = 0
  /** Whether the current attempt already published its `start` frame. */
  private attemptStarted = false
  /** The text the assistant produced during the current attempt. */
  private assistantText = ''
  /** The reasoning the assistant produced during the current attempt. */
  private assistantReasoning = ''
  /** The tool calls announced by the current attempt, in order. */
  private readonly toolCallSeqs = new Map<string, SessionSeq>()
  private readonly toolCallNames = new Map<string, string>()
  /** Tool calls announced but not yet finished. */
  private readonly pendingToolCalls = new Map<string, { name: string, arguments: string }>()

  /**
   * Messages already delivered to Vibe whose `user/message` event still has
   * to be written. They are flushed when the next step opens.
   */
  private pendingSurface: UserMessage[] = []
  /**
   * Messages Vibe could not take as steering (ACP has no mid-run steering).
   * They ride along with the next prompt so nothing is lost.
   */
  private pendingPrompt: UserMessage[] = []

  constructor(options: VibeAgentOptions) {
    this.acp = options.acp
    this.logger = options.logger
    this.id = options.session.id
    this.options = options.agentOptions
    this.session = options.session
    // A resumed session continues its turn sequence; the next turn is the
    // next number, never 1 again.
    this.turn = options.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn: this.turn }
    // DSH contract: each Agent owns a scope keyed by ITSELF (an object — the
    // scope key feeds WeakMaps downstream), and its ctx shadows `agent` with
    // an own property, so creation-window setup (`childCtx.agent`), prompt
    // assembly, and tools all resolve the live agent from its scoped context.
    this.scope = createScope(options.ctx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.disposeScope = () => void this.scope.dispose()
    this.inbox = new VibeInbox(this.session, {
      inserted: (message) => this.dispatch.emit('agent/inbox/inserted', { message }),
      discarded: (message) => this.dispatch.emit('agent/inbox/discarded', { message }),
      claimed: (message, turn) => this.dispatch.emit('agent/inbox/claimed', { message, turn }),
    } satisfies VibeInboxNotifications)
    // The model facade is driver-owned: it records a durable `model/selection`
    // and reads the recorded choice back, so the frontend's model switcher and
    // the session log agree on the route the next step will use.
    this.model = new VibeModel(this.session, this.options)
    this.dispatch = agentEvents(options.ctx, this)
    this.unwatch = this.acp.onUpdate((update) => this.onAcpUpdate(update))
    // A dead child must not leave the driver waiting forever: settle the
    // pending run with the exit reason so the turn can close.
    this.unwatchExit = this.acp.onExit((info) => {
      this.logger?.(`[vibe-loop] agent exited (code=${String(info.code)})`)
    })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previous = this.status
    this.phase = next
    const status = this.status
    if (status !== previous) this.dispatch.emit('agent/status', { status })
  }

  // ---- Agent interface: message intake ----

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // A wake submitted after an active cancellation is queued for the next
    // turn instead of the aborted one.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget: InboxTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.append(resolvedTarget, message)
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    // ACP has no mid-run steering: the input is queued and delivered with
    // the next prompt, which is the closest the protocol allows.
    this.inbox.append('next-step', message)
    this.wakeDriver()
  }

  inject(message: UserMessage): void {
    // Queued for the next pre-step; it never wakes the driver on its own.
    this.inbox.append('next-step', message)
  }

  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void {
    if (!options?.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind === 'idle') {
      // No active activity: cancellation is a no-op and must not arm later
      // work (DSH contract).
      return
    }
    this.cancelCause = cause
    this.phase.abort.abort(cause)
    void this.acp.cancel()
  }

  whenIdle(): Promise<void> {
    return this.followActivity()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') {
      throw new Error(`agent "${this.id}" already has active work`)
    }
    const controller = new AbortController()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: controller,
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    const done = deferred<void>()
    this.activityDone = done.promise
    return (async () => {
      try {
        return await task(controller.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /** Resolve once no driver or maintenance task remains active. */
  private async followActivity(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  // ---- Driver ----

  /**
   * Start one driver, or latch the wake behind maintenance or an aborted
   * activity.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = this.phase.abort.signal.reason as { kind?: string } | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = deferred<void>()
    this.activityDone = driver.promise
    // A fresh driver starts a fresh step sequence; the turn counter keeps
    // running across drivers.
    this.step = 0
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    void this.kick().then(driver.resolve, driver.reject)
  }

  /** Drain turns until the queue is empty. */
  private async kick(): Promise<void> {
    try {
      while (await this.runTurn()) {
        // keep draining queued turns in the same driver run
      }
    } catch {
      // Failures are reported at their live boundary (agent/error) and the
      // turn is closed with an error reason; the driver must not die here.
    } finally {
      if (this.phase.kind === 'running') {
        const { wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: this.turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /**
   * Run one DSH turn: claim the pending input, propose the step, drive Vibe,
   * and close the turn.
   *
   * @returns whether another turn should follow in the same driver run.
   */
  private async runTurn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      throw new Error(`agent "${this.id}": turn without driver reservation`)
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    this.turn = turn
    let turnEnds: TurnEndReason = { kind: 'completed' }
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = this.step + 1
        const claimed = this.inbox.claim(target, turn)
        const carried = this.pendingPrompt.splice(0)
        const proposal = [...carried, ...claimed]
        const decision = await this.dispatch.waterfall(
          'agent/pre-step',
          {
            messages: proposal,
            turn,
            step,
            signal,
            modelSelection: this.model.current() ?? { provider: '', model: '' },
          },
          () => Promise.resolve({ kind: 'enter' as const, messages: proposal }),
        )
        signal.throwIfAborted()
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          break
        }
        const messages = decision.messages
        if (messages.length === 0) {
          turnEnds = { kind: 'completed' }
          break
        }

        this.openStep()
        for (const message of messages) {
          this.session.append('user/message', message, { surfaceOp: 'append' })
        }
        const promptText = messages.map(extractDshText).filter((text) => text !== '').join('\n')
        if (promptText !== '') {
          await this.runVibe(promptText, turn, step)
        }
        this.closeStep()

        signal.throwIfAborted()
        if (this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: this.cancelCause ?? { kind: 'user' } }
        throw error
      }
      turnEnds = {
        kind: 'error',
        error: { message: error instanceof Error ? error.message : String(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      this.flushPendingSurface()
      try {
        this.session.append('turn/end', { turn, reason: turnEnds })
      } catch (error: unknown) {
        this.dispatch.emit('agent/error', { turn, step: this.step, error })
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    this.step = 0
    return true
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.turn
    const step = this.phase.kind === 'running' ? this.phase.step : this.step
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  // ---- Vibe run ----

  /**
   * Send one prompt to Vibe and wait until the turn ends.
   *
   * The answer arrives through the update stream while this call is pending;
   * the response only carries the stop reason and the token usage.
   */
  private async runVibe(promptText: string, turn: number, step: number): Promise<void> {
    this.resetAttempt()
    const result = await this.acp.prompt(promptText)
    // The prompt may have produced nothing at all (a cancelled turn): the
    // assistant message is then absent, and DSH records the attempt instead.
    if (this.assistantText === '' && this.assistantReasoning === '') {
      const stream: AssistantStreamRecord[] = [...this.stream.snapshot()]
      if (stream.length > 0) {
        this.session.append('assistant/attempt', { turn, step, stream })
      }
      return
    }
    const usage = convertUsage(result.usage)
    const blocks: ContentBlock[] = []
    if (this.assistantReasoning !== '') {
      blocks.push({ type: 'reasoning', text: this.assistantReasoning })
    }
    blocks.push({ type: 'text', text: this.assistantText })
    const sourceProvider = this.options.provider ?? 'mistral'
    const sourceModel = this.options.model ?? ''
    const stream: AssistantStreamRecord[] = [...this.stream.snapshot()]
    const committed = this.session.append(
      'assistant/message',
      {
        turn,
        step,
        message: createAssistantMessage({
          content: blocks,
          source: { provider: sourceProvider, model: sourceModel },
        }),
        stream,
        ...(usage === undefined ? {} : { usage }),
      },
      { surfaceOp: 'append' },
    )
    const attemptId = this.attemptId
    if (attemptId !== undefined) {
      this.dispatch.emit('agent/assistant-stream', {
        frame: {
          type: 'end',
          attemptId,
          revision: this.attemptRevision,
          index: this.chunkIndex,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: committed.seq },
        },
      })
    }
  }

  /** Start a fresh assistant attempt (one Vibe turn). */
  private resetAttempt(): void {
    this.stream = new AssistantStreamAccumulator()
    this.attemptRevision += 1
    this.attemptId = LlmAttemptId(`${this.id}:${this.attemptRevision}`)
    this.chunkIndex = 0
    this.attemptStarted = false
    this.assistantText = ''
    this.assistantReasoning = ''
    this.pendingToolCalls.clear()
  }

  // ---- Step boundaries ----

  private openStep(): void {
    if (this.stepOpen) return
    this.step += 1
    this.stepOpen = true
    this.session.append('step/start', { turn: this.turn, step: this.step })
    this.flushPendingSurface()
  }

  private closeStep(): void {
    if (!this.stepOpen) return
    this.stepOpen = false
    this.session.append('step/end', { turn: this.turn, step: this.step })
  }

  /** Write the `user/message` events of already-delivered messages. */
  private flushPendingSurface(): void {
    if (this.pendingSurface.length === 0) return
    const messages = this.pendingSurface.splice(0)
    for (const message of messages) {
      this.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }

  // ---- ACP event translation ----

  private onAcpUpdate(update: AcpUpdate): void {
    switch (update.kind) {
      case 'agent_message_chunk': {
        const text = acpText(update.raw.content)
        if (text === '') return
        this.assistantText += text
        this.startAttempt()
        this.appendChunk({ type: 'text-delta', index: 0, text })
        return
      }
      case 'agent_thought_chunk': {
        const text = acpText(update.raw.content)
        if (text === '') return
        this.assistantReasoning += text
        this.startAttempt()
        this.appendChunk({ type: 'reasoning-delta', index: 0, text })
        return
      }
      case 'tool_call': {
        const raw = update.raw as {
          toolCallId?: unknown
          title?: unknown
          rawInput?: unknown
          rawOutput?: unknown
        }
        const id = String(raw.toolCallId ?? '')
        if (id === '') return
        const name = String(raw.title ?? 'tool')
        const args = raw.rawInput ?? raw.rawOutput ?? {}
        const argumentsText = typeof args === 'string' ? args : JSON.stringify(args)
        this.openStep()
        const callEvent = this.session.append('tool/call', {
          turn: this.turn,
          step: this.step,
          callId: ToolCallId(id),
          name,
          arguments: argumentsText,
        })
        this.toolCallSeqs.set(id, callEvent.seq)
        this.toolCallNames.set(id, name)
        this.pendingToolCalls.set(id, { name, arguments: argumentsText })
        return
      }
      case 'tool_call_update': {
        const raw = update.raw as {
          toolCallId?: unknown
          status?: unknown
          content?: unknown
          rawOutput?: unknown
        }
        const id = String(raw.toolCallId ?? '')
        if (id === '') return
        const status = String(raw.status ?? '')
        if (status !== 'completed' && status !== 'failed') return
        const blocks = convertToolResult(raw.content ?? raw.rawOutput)
        const callId = ToolCallId(id)
        const message = createToolResultMessage({
          callId,
          content: blocks,
          isError: status === 'failed',
        })
        const callSeq = this.toolCallSeqs.get(id)
        this.session.append(
          'tool/result',
          { turn: this.turn, step: this.step, message },
          { surfaceOp: 'append', ...(callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] }) },
        )
        this.pendingToolCalls.delete(id)
        return
      }
      default:
        return
    }
  }

  /** Publish the `start` frame of the current assistant attempt, once. */
  private startAttempt(): void {
    if (this.attemptStarted) return
    this.attemptStarted = true
    const attemptId = this.attemptId
    if (attemptId === undefined) return
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'start',
        attemptId,
        revision: this.attemptRevision,
        turn: this.turn,
        step: this.step,
      },
    })
  }

  private appendChunk(chunk: StreamChunk): void {
    const time = Date.now()
    this.stream.push({ time, chunk })
    const attemptId = this.attemptId
    if (attemptId === undefined) return
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'chunk',
        attemptId,
        revision: this.attemptRevision,
        index: this.chunkIndex,
        time,
        chunk,
      },
    })
    this.chunkIndex += 1
  }

  /** Tear down: stop Vibe and unwind the scoped context. */
  dispose(): void {
    this.unwatch()
    this.unwatchExit()
    if (this.phase.kind !== 'idle') {
      this.cancelCause = this.cancelCause ?? { kind: 'disposed' }
      this.phase.abort.abort(this.cancelCause)
    }
    this.acp.close()
    void this.disposeScope()
  }
}
