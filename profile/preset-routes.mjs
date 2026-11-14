/**
 * preset-routes — which engine and which model a session's preset names.
 *
 * The logic is pure and free of imports: the router builds its factories
 * from what it resolves here, and the rule is worth testing on its own.
 *
 * A preset entry is either the engine name (the short form) or an object
 * naming the engine and, optionally, the model:
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
 *     thinking: 'high'            # the thinking level it runs on
 * ```
 */

/**
 * Resolve the engine and the model of one preset.
 *
 * @param preset - the session's agent preset, when it has one.
 * @param presets - the preset-to-entry map.
 * @param fallback - the engine for a session without a preset (or with an
 * unknown one).
 * @returns the engine, and the model when the preset names one.
 */
export function resolvePreset(preset, presets, fallback) {
  const entry = preset === undefined || preset === null || preset === ''
    ? undefined
    : presets?.[preset]
  if (entry === undefined || entry === null) {
    return { engine: fallback, model: undefined, thinking: undefined }
  }
  if (typeof entry === 'string') {
    return { engine: entry === 'pi' ? 'pi' : 'vibe', model: undefined, thinking: undefined }
  }
  const engine = entry.engine === 'pi' ? 'pi' : entry.engine === 'vibe' ? 'vibe' : fallback
  const model = typeof entry.model === 'string' && entry.model !== '' ? entry.model : undefined
  // The thinking level is Pi's: a Vibe session has no such setting.
  const thinking = engine === 'pi' && typeof entry.thinking === 'string' && entry.thinking !== ''
    ? entry.thinking
    : undefined
  return { engine, model, thinking }
}

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
  return resolvePreset(preset, presets, fallback).engine
}
