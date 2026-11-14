/**
 * loop-router — one agent factory that picks the engine per session.
 *
 * DSH has a single agent-factory slot, so two engine plugins cannot both
 * drive sessions. This router owns the slot and delegates: the session's
 * agent preset decides which engine runs it.
 *
 * The preset is the DSH's own durable record of the choice: the frontend
 * writes it to the session (`agent-preset/selected` in the session log, the
 * `agentPreset` header and the `agentPreset` projection), and the router
 * reads it back when the session is created or resumed. A session that
 * resumes picks the same engine it was created with — the decision lives in
 * the session, not in the current configuration.
 *
 * A preset names the engine, and optionally the model:
 *
 * ```yaml
 * presets:
 *   coding:                      # the engine only
 *     engine: pi
 *   coding-leve:
 *     engine: vibe
 *   research:
 *     engine: pi
 *     model: 'anthropic/claude-sonnet-4-5' # the model this preset runs on
 *     thinking: 'high'           # the thinking level it runs on
 * ```
 *
 * The model belongs to the preset, so the route travels with the preset's
 * decision: a session created with a preset runs on that preset's model.
 * The engine names no model: the choice is the user's, and a preset that
 * names one decides for its own sessions.
 *
 * Install this file INTO the profile (for example
 * `~/.dsh/profiles/desktop/dsh/loop-router.mjs`): its imports of the two
 * engine packages resolve from the profile's `node_modules`, which is where
 * both plugins are linked.
 *
 * ```yaml
 * - insert:
 *     - id: loop-router
 *       name: 'file:///C:/Users/danalec/.dsh/profiles/desktop/dsh/loop-router.mjs'
 *       config:
 *         presets:
 *           coding: pi        # heavy coding runs on the Pi loop
 *           coding-leve: vibe # light coding runs on the Vibe loop
 *         default: pi
 *         pi:
 *           piPath: 'C:\\Users\\danalec\\.pi\\agent\\bin\\pi.cmd'
 *           # no model: the child runs on the model the user chose in pi
 *         vibe:
 *           vibePath: 'C:\\Users\\danalec\\AppData\\Local\\Microsoft\\WinGet\\Links\\vibe-acp.exe'
 *           # no model: the session runs on the model vibe starts with
 * ```
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAgentFactory, registerSessionProjections as registerPiProjections } from 'dsh-pi-loop'
import { VibeAgentFactory, registerSessionProjections as registerVibeProjections } from 'dsh-vibe-loop'
import { resolvePreset } from './preset-routes.mjs'

export const name = 'loop-router'

export const inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

/** The preset rules, re-exported so the router is the one import a profile needs. */
export { resolveEngine, resolvePreset } from './preset-routes.mjs'

/**
 * Read the preset a persisted session was created with.
 *
 * The header is durable: the preset travels with it, so a resumed session
 * keeps its engine even when the configuration changed in between.
 */
async function readPreset(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || sessionId === undefined) return undefined
  try {
    const handle = await persistence.open(sessionId, 'read')
    try {
      let preset = handle.header?.agentPreset
      try {
        const read = await handle.read(0, undefined)
        for (const event of read?.events ?? []) {
          if (event.type === 'agent-preset/selected' && event.data?.agentPreset) {
            preset = event.data.agentPreset
          }
        }
      } catch {}
      return preset
    } finally {
      await handle.close()
    }
  } catch {
    // An unreadable session falls back to the default engine; the resume
    // itself reports the real problem.
    return undefined
  }
}

/** Name of the diagnostics file inside the platform temp directory. */
export const DEBUG_LOG_FILE = 'dsh-vibe-loop.log'

export function apply(ctx, config) {
  const presets = config?.presets ?? {}
  // The router is the only part of the stack that knows which engine a
  // session runs on, so its decisions are the ones worth reading. With
  // `debug` on they land in the same diagnostics file the engines use.
  const debug = config?.debug === true
  const logFile = join(tmpdir(), DEBUG_LOG_FILE)
  const trace = (line) => {
    if (!debug) return
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [router] ${line}
`)
    } catch { /* diagnostics must never break the plugin */ }
  }
  const logger = debug ? (line) => trace(line) : undefined
  const fallback = config?.default === 'pi' ? 'pi' : 'vibe'

  const piOptions = {
    piPath: config?.pi?.piPath,
    cwd: config?.pi?.cwd,
    model: config?.pi?.model,
    // The Pi agent has a model of its own: the route named here, not the
    // session's own model selection. An explicit false opts out.
    pinModel: config?.pi?.pinModel !== false,
    logger,
    trace,
  }
  const vibeOptions = {
    vibePath: config?.vibe?.vibePath,
    cwd: config?.vibe?.cwd,
    model: config?.vibe?.model,
    pinModel: config?.vibe?.pinModel !== false,
    permission: config?.vibe?.permission,
    mode: config?.vibe?.mode,
    logger,
    trace,
  }

  // One factory per engine, model and thinking level: a factory carries
  // the route its engine runs on, and a preset may name its own.
  const delegates = new Map()
  const delegateFor = (engine, model, thinking) => {
    const key = `${engine}|${model ?? ''}|${thinking ?? ''}`
    const cached = delegates.get(key)
    if (cached !== undefined) return cached
    const created = engine === 'pi'
      ? new PiAgentFactory({
        ...piOptions,
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
      }, ctx)
      : new VibeAgentFactory({ ...vibeOptions, ...(model === undefined ? {} : { model }) }, ctx)
    delegates.set(key, created)
    return created
  }

  const factory = {
    async createAgent(ownerCtx, options) {
      const preset = options?.meta?.agentPreset
      const { engine, model, thinking } = resolvePreset(preset, presets, fallback)
      const delegate = delegateFor(engine, model, thinking)
      trace(`session "${String(options?.sessionId)}" uses the ${engine} engine (preset ${String(preset)}${model === undefined ? '' : `, model ${model}`}${thinking === undefined ? '' : `, thinking ${thinking}`})`)
      return delegate.createAgent(ownerCtx, options)
    },
    async resume(ownerCtx, options) {
      const preset = await readPreset(ctx, options?.resumeSessionId)
      const { engine, model, thinking } = resolvePreset(preset, presets, fallback)
      const delegate = delegateFor(engine, model, thinking)
      trace(`session "${String(options?.resumeSessionId)}" resumes on the ${engine} engine (preset ${String(preset)}${model === undefined ? '' : `, model ${model}`}${thinking === undefined ? '' : `, thinking ${thinking}`})`)
      return delegate.resume(ownerCtx, options)
    },
  }

  // The frontend reads a session's model from the standard model-selection
  // projection and its pending queue from the inbox projection. The native
  // loop (`dsh-agent-loop`) owns both, and the router replaces that plugin:
  // the router owns the factory slot, so it registers them.
  void registerPiProjections(ctx)
  void registerVibeProjections(ctx)

  const dispose = ctx.agents.setFactory(factory)
  trace(`registered (presets ${Object.keys(presets).join(', ') || 'none'}; default ${fallback})`)
  return dispose
}
