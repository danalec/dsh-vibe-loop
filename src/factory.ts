/**
 * VibeAgentFactory — the `AgentFactory` (`ctx.agents.setFactory`) that turns
 * DSH's frontend into a client for the Mistral Vibe agent.
 *
 * When this plugin is loaded, every new session the frontend creates is
 * driven by a Vibe child process (`vibe-acp`, over the Agent Client
 * Protocol) instead of DSH's own `dsh-agent-loop`. The factory mints the
 * session, the scoped VibeAgent and the ACP child, then publishes both
 * through the same ordered boundary the default loop uses
 * (`session/created`, `agent/created`, `agent/session-start`), so DSH's
 * frontend, hooks and session log work unchanged.
 *
 * To fall back to DSH's own loop, disable this plugin's entry (or the
 * profile patch inserting it) — the default `agent-loop` factory remains
 * registered underneath and becomes active again.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  type AgentFactory,
  type AgentHandle,
  type AgentOptions,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import {
  interruptedTurnClosers,
  SessionLogOffset,
  SessionPreparation,
  type Session,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { VibeAcpClient } from './acp-client.ts'
import { VibeAgent } from './vibe-agent.ts'
import { readVibeSessionId, writeVibeSessionId } from './vibe-session.ts'

/** Why the session lifecycle began. */
export type VibeSessionStartSource = 'startup' | 'resume'

export interface VibeFactoryOptions {
  /** Absolute path to the `vibe-acp` executable (defaults to `vibe-acp` on PATH). */
  vibePath?: string
  /** Extra arguments passed to the `vibe-acp` executable. */
  vibeArgs?: string[]
  /** Working directory for Vibe sessions (defaults to process.cwd()). */
  cwd: string
  /** Vibe model id (for example `mistral-large-4-0-3`). */
  model?: string
  /**
   * Ignore the route DSH requests for a session and always use `model`.
   *
   * DSH's own providers are not Vibe models: without this, a session created
   * with the frontend's model picker would hand Vibe a route it refuses.
   */
  pinModel?: boolean
  /**
   * How Vibe's tool permission requests are answered.
   *
   * `allow-once` (the default) approves the single call the agent asked
   * for; `deny` refuses it. A standing grant is never given.
   */
  permission?: 'allow-once' | 'deny'
  /** Diagnostics sink; omit to keep quiet. */
  logger?: (line: string) => void
  /** Lifecycle trace sink (apply/createAgent/resume); omit to keep quiet. */
  trace?: (line: string) => void
}

/** One resolved model route. */
export interface ResolvedRoute {
  /** `provider/model`, or empty when no route could be resolved. */
  route: string
  provider: string
  model: string
}

/**
 * Resolve the model route for one agent.
 *
 * The requested per-agent route wins over the factory default: this is what
 * lets a delegated child run on a fixed model while the top-level session
 * keeps the factory default. A model without a provider borrows the default's
 * provider — never the other way round, so `provider` can never end up
 * holding a model id.
 */
export function resolveVibeRoute(factoryModel: string | undefined, requested: AgentOptions | undefined): ResolvedRoute {
  const fallback = factoryModel ?? ''
  const slash = fallback.indexOf('/')
  const fallbackProvider = slash > 0 ? fallback.slice(0, slash) : ''
  const fallbackModel = slash > 0 ? fallback.slice(slash + 1) : fallback

  const requestedProvider = requested?.provider !== undefined && requested.provider !== ''
    ? requested.provider
    : undefined
  const requestedModel = requested?.model !== undefined && requested.model !== ''
    ? requested.model
    : undefined

  let provider: string
  let model: string
  if (requestedModel !== undefined) {
    model = requestedModel
    provider = requestedProvider ?? fallbackProvider
  } else if (requestedProvider !== undefined) {
    provider = requestedProvider
    model = fallbackModel
  } else {
    provider = fallbackProvider
    model = fallbackModel
  }

  if (provider === '' || model === '') return { route: '', provider: '', model: '' }
  return { route: `${provider}/${model}`, provider, model }
}

export class VibeAgentFactory implements AgentFactory {
  private readonly registryCtx: Context

  constructor(
    private readonly options: VibeFactoryOptions,
    registryCtx: Context,
  ) {
    this.registryCtx = registryCtx
  }

  /**
   * The stored side of one session: the write handle the persistence backend
   * owns and the number of events already written to it.
   */
  private static stored(handle: SessionHandle, storedCount: number): { handle: SessionHandle, storedCount: number } {
    return { handle, storedCount }
  }

  /**
   * Take the write ownership of a fresh session's stored log.
   */
  private async createStoredSession(session: Session, signal: AbortSignal | undefined): Promise<{ handle: SessionHandle, storedCount: number } | undefined> {
    const persistence = this.registryCtx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    return VibeAgentFactory.stored(handle, 0)
  }

  /**
   * Write the events a session holds but never published (its constructor
   * seed) to the stored log.
   */
  private async appendUnstoredSuffix(
    stored: { handle: SessionHandle, storedCount: number } | undefined,
    session: Session,
  ): Promise<void> {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const id = options.sessionId
    this.options.trace?.(`createAgent id=${String(id)} meta=${JSON.stringify(options.meta)}`)
    const cwd = options.meta?.cwd ?? this.options.cwd
    let stored: { handle: SessionHandle, storedCount: number } | undefined
    try {
      const preparation = SessionPreparation.create(this.registryCtx.sessions.prepare(id, {
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.seed === undefined ? {} : { seed: options.seed },
      }))
      try {
        const session = preparation.session
        stored = await this.createStoredSession(session, options.signal)
        await this.appendUnstoredSuffix(stored, session)
        const handle = await this.assembleAndPublish(
          ownerCtx,
          id,
          session,
          cwd,
          options.agentOptions,
          options.signal,
          options.setup,
          'startup',
          stored,
          undefined,
        )
        this.options.trace?.(`createAgent OK id=${String(id)}`)
        return handle
      } finally {
        preparation[Symbol.dispose]()
      }
    } catch (error: unknown) {
      await stored?.handle.close().catch(() => undefined)
      this.options.trace?.(`createAgent FAILED id=${String(id)}: ${String(error)}`)
      throw error
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.registryCtx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const id = options.resumeSessionId
    this.options.trace?.(`resume id=${String(id)}`)
    const signal = options.signal
    const handle = await persistence.open(id, 'write', signal === undefined ? {} : { signal })
    try {
      const coldRead = await handle.read(SessionLogOffset(0), undefined, signal === undefined ? {} : { signal })
      const persisted = coldRead.events
      // A turn that was interrupted by the crash left an open boundary: close
      // it durably before the session replays the log.
      const closers = interruptedTurnClosers(persisted)
      if (closers.length > 0) await handle.append(closers)
      const preparation = SessionPreparation.create(this.registryCtx.sessions.prepare(id, {
        seed: [...persisted, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      }))
      try {
        const session = preparation.session
        const cwd = session.header.cwd ?? this.options.cwd
        const stored = VibeAgentFactory.stored(handle, persisted.length + closers.length)
        const agentHandle = await this.assembleAndPublish(
          ownerCtx,
          id,
          session,
          cwd,
          options.agentOptions,
          signal,
          options.setup,
          'resume',
          stored,
          readVibeSessionId(String(id)),
        )
        this.options.trace?.(`resume OK id=${String(id)}`)
        return agentHandle
      } finally {
        preparation[Symbol.dispose]()
      }
    } catch (error: unknown) {
      await handle.close().catch(() => undefined)
      this.options.trace?.(`resume FAILED id=${String(id)}: ${String(error)}`)
      throw error
    }
  }

  /**
   * Resolve the model route for one agent.
   */
  private resolveRoute(requested: AgentOptions | undefined): ResolvedRoute {
    return resolveVibeRoute(this.options.model, this.options.pinModel === true ? undefined : requested)
  }

  /** Mint the ACP child, build the scoped VibeAgent, and publish the pair. */
  private async assembleAndPublish(
    ownerCtx: Context,
    id: SessionId,
    session: Session,
    cwd: string,
    agentOptions: AgentOptions | undefined,
    signal: AbortSignal | undefined,
    setup: CreateAgentOptions['setup'],
    source: VibeSessionStartSource,
    stored: { handle: SessionHandle, storedCount: number } | undefined,
    previousVibeSessionId: string | undefined,
  ): Promise<AgentHandle> {
    ownerCtx.fiber.assertActive()
    if (signal?.aborted) throw new Error(`agent "${id}" creation aborted`)

    const requested = agentOptions
    const { route, provider, model } = this.resolveRoute(requested)

    const acp = new VibeAcpClient({
      cwd,
      model: route === '' ? undefined : model,
      vibePath: this.options.vibePath,
      ...(this.options.vibeArgs === undefined ? {} : { args: this.options.vibeArgs }),
      signal,
      logger: this.options.logger,
      ...(this.options.permission === undefined ? {} : { permission: this.options.permission }),
    })

    // The Vibe session carries the model's own context window. A resumed DSH
    // session reuses the Vibe session it used before, so the conversation
    // continues exactly where it stopped; a fresh session starts empty.
    let vibeSessionId: string | undefined
    if (previousVibeSessionId !== undefined) {
      try {
        vibeSessionId = await acp.loadSession(previousVibeSessionId)
      } catch (error: unknown) {
        this.options.trace?.(`vibe session "${previousVibeSessionId}" could not be loaded: ${String(error)}`)
        vibeSessionId = undefined
      }
    }
    if (vibeSessionId === undefined) {
      vibeSessionId = await acp.newSession()
    }
    writeVibeSessionId(String(id), vibeSessionId, cwd)

    // The model is a session option on Vibe's side: apply it when the
    // session offers it, and fail loudly when it does not (a route Vibe
    // refuses would silently run another model).
    if (model !== '') {
      const allowed = acp.optionValues('model')
      if (allowed.length > 0 && !allowed.includes(model)) {
        throw new Error(`vibe session does not offer the model "${model}"; it offers ${allowed.join(', ')}`)
      }
      if (acp.optionCurrent('model') !== model) {
        await acp.setOption('model', model)
      }
    }

    const agent = new VibeAgent({
      ctx: this.registryCtx,
      session,
      agentOptions: {
        ...agentOptions,
        // Only fill route fields the caller did not provide.
        ...(provider !== '' && requested?.provider === undefined ? { provider } : {}),
        ...(model !== '' && requested?.model === undefined ? { model } : {}),
      },
      acp,
      // Continue the session's turn sequence: a resumed session must not
      // reopen turn 1.
      lastTurn: this.registryCtx.agents.turnBoundaryOf(session).lastTurn,
      logger: this.options.logger,
    })

    // Creation-window composition (the AgentFactory contract): await the
    // caller's setup on the agent's scoped context, invoke its synchronous
    // commit if any, and only then insert/announce — so no observer can see a
    // partially configured child world. Setup composes, it never drives. It
    // runs inside the try below so a rejection rolls the child back through
    // the same dispose path (agent, ACP child, scope).
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      try {
        agent.dispose()
        acp.close()
      } finally {
        try {
          detachAgent?.()
          detachSession?.()
        } finally {
          // VibeAgent.dispose() already unwinds its own scope.
          await stored?.handle.close().catch(() => undefined)
        }
      }
    })())
    const unfollowOwner = ownerCtx.effect(() => () => {
      if (disposing !== undefined) return
      void dispose()
    })

    try {
      if (setup !== undefined) {
        try {
          const setupCommit = await setup(agent.ctx, agent)
          setupCommit?.commit()
        } catch (error: unknown) {
          this.options.trace?.(`setup FAILED id=${String(id)}: ${String(error)}`)
          throw error
        }
      }
      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.registryCtx.agents.enter(agent)
      agent.ctx.sessions.announce(session)
      // The registry announces the agent and runs the `agent/created`
      // listeners with the creation source (fresh session or resume).
      await this.registryCtx.agents.announce(agent, source)
      return { agent, dispose: () => dispose().then(() => undefined) }
    } catch (error: unknown) {
      await unfollowOwner?.()
      await dispose()
      throw error
    }
  }
}
