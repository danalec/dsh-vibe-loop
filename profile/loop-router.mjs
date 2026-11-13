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
 *         default: vibe
 *         pi:
 *           piPath: 'C:\\Users\\danalec\\.pi\\agent\\bin\\pi.cmd'
 *           model: 'minimax/MiniMax-M3.1-Flash-Preview'
 *         vibe:
 *           vibePath: 'C:\\Users\\danalec\\AppData\\Local\\Microsoft\\WinGet\\Links\\vibe-acp.exe'
 *           model: 'mistral-large-4'
 * ```
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAgentFactory, registerModelSelectionProjection as registerPiProjection } from 'dsh-pi-loop'
import { VibeAgentFactory, registerModelSelectionProjection as registerVibeProjection } from 'dsh-vibe-agent'

export const name = 'loop-router'

export const inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

/**
 * Resolve the engine of one session.
 *
 * @param preset - the session's agent preset, when it has one.
 * @param presets - the preset-to-engine map.
 * @param fallback - the engine for a session without a preset (or with an
 * unknown one).
 * @returns `'pi'` or `'vibe'`.
 */
export function resolveEngine(preset, presets, fallback) {
  if (preset === undefined || preset === null || preset === '') return fallback
  const engine = presets?.[preset]
  if (engine === undefined) return fallback
  return engine === 'pi' ? 'pi' : 'vibe'
}

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
      return handle.header?.agentPreset
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
export const DEBUG_LOG_FILE = 'dsh-vibe-agent.log'

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
  const pi = new PiAgentFactory({
    piPath: config?.pi?.piPath,
    cwd: config?.pi?.cwd,
    model: config?.pi?.model,
    pinModel: config?.pi?.pinModel === true,
    logger,
    trace,
  }, ctx)
  const vibe = new VibeAgentFactory({
    vibePath: config?.vibe?.vibePath,
    cwd: config?.vibe?.cwd,
    model: config?.vibe?.model,
    pinModel: config?.vibe?.pinModel === true,
    permission: config?.vibe?.permission,
    mode: config?.vibe?.mode,
    logger,
    trace,
  }, ctx)

  const factory = {
    async createAgent(ownerCtx, options) {
      const preset = options?.meta?.agentPreset
      const engine = resolveEngine(preset, presets, fallback)
      trace(`session "${String(options?.sessionId)}" uses the ${engine} engine (preset ${String(preset)})`)
      return engine === 'pi'
        ? pi.createAgent(ownerCtx, options)
        : vibe.createAgent(ownerCtx, options)
    },
    async resume(ownerCtx, options) {
      const preset = await readPreset(ctx, options?.resumeSessionId)
      const engine = resolveEngine(preset, presets, fallback)
      trace(`session "${String(options?.resumeSessionId)}" resumes on the ${engine} engine (preset ${String(preset)})`)
      return engine === 'pi'
        ? pi.resume(ownerCtx, options)
        : vibe.resume(ownerCtx, options)
    },
  }

  // The frontend reads a session's model from the standard model-selection
  // projection; the router owns the factory slot, so it registers it.
  void registerPiProjection(ctx)
  void registerVibeProjection(ctx)

  const dispose = ctx.agents.setFactory(factory)
  trace(`registered (presets ${Object.keys(presets).join(', ') || 'none'}; default ${fallback})`)
  return dispose
}
