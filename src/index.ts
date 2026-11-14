/**
 * dsh-vibe-loop — DeepSeek Harness plugin that runs the Mistral Vibe agent
 * inside DSH's frontend.
 *
 * The plugin registers an `AgentFactory` through `ctx.agents.setFactory`, so
 * every new session the frontend creates is driven by a headless `vibe-acp`
 * child process (Agent Client Protocol over stdio) instead of DSH's own
 * `dsh-agent-loop`.
 *
 * Pluggable by configuration: the default loop stays registered underneath;
 * disable this plugin's entry (or remove the profile patch that inserts it)
 * and DSH's own loop is active again immediately.
 *
 * Mount in the profile patch layer (cordis.patch.yml):
 *
 * ```yaml
 * # Use the Vibe loop for all new sessions.
 * - insert:
 *     - id: vibe-loop
 *       name: 'dsh-vibe-loop'
 *       config:
 *         vibePath: 'vibe-acp'             # or an absolute path
 *         cwd: '/path/to/your/project'
 *         # no model: the session runs on the model vibe starts with
 *         pinModel: true
 *         debug: false
 * # Fall back to DSH's own loop: disable this entry and re-enable agent-loop.
 * # - id: vibe-loop
 * #   disabled: true
 * ```
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { VibeAgentFactory } from './factory.ts'
import { inboxProjectionDefinition } from './inbox-projection.ts'

export { VibeAcpClient } from './acp-client.ts'
export type {
  AcpCapabilities,
  AcpConfigOption,
  AcpContentBlock,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpSessionUpdate,
  AcpUpdate,
  VibeAcpClientOptions,
} from './acp-client.ts'
export { VibeAgentFactory, resolveVibeRoute } from './factory.ts'
export type { ResolvedRoute, VibeFactoryOptions, VibeSessionStartSource } from './factory.ts'
export { VibeAgent } from './vibe-agent.ts'
export type { VibeAgentOptions } from './vibe-agent.ts'
export { buildVibeHistory, buildVibeHistoryPrompt, renderVibeHistory } from './history.ts'
export type { BuildVibeHistoryOptions, VibeHistoryEntry } from './history.ts'
export { VibeInbox, applyInboxSplice, foldInboxState } from './inbox.ts'
export { inboxProjectionDefinition, inboxProjectionSchema } from './inbox-projection.ts'
export type { VibeInboxNotifications, VibeInboxState } from './inbox.ts'
export { VibeModel, foldModelState, sameModelSelection } from './model.ts'
export type { ModelState } from './model.ts'
export {
  forgetVibeSessionId,
  readVibeSessionId,
  vibeSessionPath,
  vibeSessionsDir,
  writeVibeSessionId,
} from './vibe-session.ts'
export type { VibeSessionRecord } from './vibe-session.ts'

export const name = 'vibe-loop'

/**
 * Register the standard `modelSelection` projection.
 *
 * The frontend reads a session's model from that projection. A driver that
 * owns the factory slot but does not own the plugin's `apply` (a router that
 * delegates to this driver) registers it through this helper.
 *
 * @returns a promise that settles when the projection is registered.
 */
export function registerModelSelectionProjection(ctx: Context): Promise<unknown> {
  try {
    return ctx.sessionProjections.register(modelSelectionProjectionDefinition).catch((error: unknown) => {
      ctx.logger.warn(`vibe-loop: could not register the model selection projection: ${String(error)}`)
    })
  } catch (error: unknown) {
    ctx.logger.warn(`vibe-loop: could not register the model selection projection: ${String(error)}`)
    return Promise.resolve()
  }
}

/**
 * Register the `inbox` projection — the session's pending input.
 *
 * The native loop (`@deepseek-ai/dsh-agent-loop`) owns this projection, and
 * this plugin replaces that plugin: with the native loop disabled, nothing
 * else registers the key, and the frontend's queue dock — which reads
 * `projections.faceOf('inbox')` — has nothing to render.
 *
 * @returns a promise that settles when the projection is registered.
 */
export function registerInboxProjection(ctx: Context): Promise<unknown> {
  try {
    return ctx.sessionProjections.register(inboxProjectionDefinition).catch((error: unknown) => {
      ctx.logger.warn(`vibe-loop: could not register the inbox projection: ${String(error)}`)
    })
  } catch (error: unknown) {
    ctx.logger.warn(`vibe-loop: could not register the inbox projection: ${String(error)}`)
    return Promise.resolve()
  }
}

/**
 * Register every session projection this loop owns.
 *
 * A router that owns the agent-factory slot registers both through this
 * helper: the model route and the pending queue are the same for every
 * engine, so one registration covers them all.
 *
 * @returns a promise that settles when the projections are registered.
 */
export async function registerSessionProjections(ctx: Context): Promise<void> {
  try {
    await Promise.all([
      registerModelSelectionProjection(ctx),
      registerInboxProjection(ctx),
    ])
  } catch (error: unknown) {
    // A rejected registration must never escape: the caller fires and
    // forgets, and an unhandled rejection ends the host process.
    ctx.logger.warn(`vibe-loop: could not register the session projections: ${String(error)}`)
  }
}

/**
 * Services the agent scope must be able to resolve.
 *
 * The agent's scoped context inherits this plugin's dependency API, and the
 * frontend's composition (agent presets, prompt sections, tools) reads those
 * services from the agent context during setup. A missing one fails the
 * session creation with `cannot get property "<service>" without inject`.
 */
export const inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

export interface Config {
  /** `vibe-acp` executable; defaults to `vibe-acp` on PATH. */
  vibePath?: string
  /** Extra arguments passed to the `vibe-acp` executable. */
  vibeArgs?: string[]
  /** Working directory for Vibe sessions. Defaults to process.cwd(). */
  cwd?: string
  /**
   * The Vibe session's model (for example `mistral-large-4`).
   *
   * Omit it and the session runs on the model Vibe itself starts with:
   * the plugin stipulates no model of its own.
   */
  model?: string
  /**
   * Always use `model`, ignoring the route DSH requests for a session.
   *
   * DSH's own providers are not Vibe models: without this, a session created
   * with the frontend's model picker would hand Vibe a route it refuses.
   */
  pinModel?: boolean
  /**
   * How Vibe's tool permission requests are answered.
   *
   * `dsh` (the default) routes the request through DSH's own approval chain
   * — the session's policy and the UI answerer decide. `allow-once` approves
   * the single call the agent asked for; `deny` refuses it. A standing grant
   * is never given.
   */
  permission?: 'dsh' | 'allow-once' | 'deny'
  /**
   * The Vibe session mode.
   *
   * `ask` (the default) makes Vibe ask before every tool run, which is what
   * lets the DSH approval chain decide. `accept-edits` auto-approves file
   * edits, `smart-approve` classifies each call, `auto-approve` approves
   * everything.
   */
  mode?: 'ask' | 'accept-edits' | 'smart-approve' | 'auto-approve'
  /**
   * Byte budget for the history transcript handed to a fresh session.
   *
   * The transcript is the model's context: a session whose log grew past
   * the budget is handed over with its oldest messages dropped, the way
   * the native loop compacts — without it the provider refuses the
   * request and every answer comes back empty.
   */
  historyBudgetBytes?: number
  /** Protocol diagnostics; appended to `<tmpdir>/dsh-vibe-loop.log`. */
  debug?: boolean
}

export const Config = z.object({
  vibePath: z.string(),
  vibeArgs: z.array(z.string()),
  cwd: z.string(),
  model: z.string(),
  pinModel: z.boolean(),
  permission: z.union(['dsh', 'allow-once', 'deny']),
  mode: z.union(['ask', 'accept-edits', 'smart-approve', 'auto-approve']),
  historyBudgetBytes: z.number(),
  debug: z.boolean(),
}) as unknown as z<Config>

/** Name of the diagnostics file inside the platform temp directory. */
export const DEBUG_LOG_FILE = 'dsh-vibe-loop.log'

/**
 * Register the Vibe agent factory.
 *
 * The registration is synchronous: the factory slot is taken before this
 * function returns, so a session created right after the plugin mounts finds
 * the Vibe factory already in place.
 *
 * @returns the disposer that unregisters the factory.
 */
export function apply(ctx: Context, config: Config): () => void {
  const debug = config.debug === true
  const logFile = join(tmpdir(), DEBUG_LOG_FILE)
  const trace = (line: string): void => {
    if (!debug) return
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    } catch { /* diagnostics must never break the plugin */ }
  }
  trace(`apply entered config=${JSON.stringify(config)}`)
  try {
    const cwd = config.cwd ?? process.cwd()
    // Without `debug`, no sink is installed at all: the protocol layer then
    // formats no diagnostics and touches no disk.
    const logger = debug
      ? (line: string): void => {
          trace(`[vibe] ${line}`)
        }
      : undefined
    const factory = new VibeAgentFactory(
      {
        vibePath: config.vibePath,
        ...(config.vibeArgs === undefined ? {} : { vibeArgs: config.vibeArgs }),
        cwd,
        model: config.model,
        pinModel: config.pinModel,
        ...(config.permission === undefined ? {} : { permission: config.permission }),
        ...(config.mode === undefined ? {} : { mode: config.mode }),
        ...(config.historyBudgetBytes === undefined
          ? {}
          : { historyBudgetBytes: config.historyBudgetBytes }),
        logger,
        trace: debug ? trace : undefined,
      },
      ctx,
    )
    const dispose = ctx.agents.setFactory(factory)
    trace('factory registered (vibe loop active)')
    // The frontend reads a session's model from the standard `modelSelection`
    // projection and its pending queue from the `inbox` projection. The
    // native loop owns both, and this plugin replaces it, so it registers
    // them itself. Registration is asynchronous and the factory does not
    // depend on it (the agent owns its own durable selection), so it runs in
    // the background.
    void registerSessionProjections(ctx)
    return dispose
  } catch (error: unknown) {
    trace(`apply failed: ${String(error)}`)
    throw error
  }
}
