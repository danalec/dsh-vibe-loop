import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveEngine, resolvePreset } from '../profile/preset-routes.mjs'

const presets = {
  coding: { engine: 'pi', model: 'zai/glm-5.3-flash' },
  'coding-leve': { engine: 'vibe', model: 'mistral-large-4' },
  plain: 'pi',
  'plain-model': { engine: 'pi' },
}

test('a preset names its engine and its model', () => {
  assert.deepEqual(resolvePreset('coding', presets, 'pi'), { engine: 'pi', model: 'zai/glm-5.3-flash' })
  assert.deepEqual(resolvePreset('coding-leve', presets, 'pi'), { engine: 'vibe', model: 'mistral-large-4' })
})

test('a preset without a model leaves the engine default in place', () => {
  assert.deepEqual(resolvePreset('plain-model', presets, 'pi'), { engine: 'pi', model: undefined })
})

test('the short form names the engine only', () => {
  assert.deepEqual(resolvePreset('plain', presets, 'pi'), { engine: 'pi', model: undefined })
})

test('an unknown preset falls back to the default engine', () => {
  assert.deepEqual(resolvePreset('not-a-preset', presets, 'vibe'), { engine: 'vibe', model: undefined })
})

test('a session without a preset falls back to the default engine', () => {
  assert.deepEqual(resolvePreset(undefined, presets, 'vibe'), { engine: 'vibe', model: undefined })
  assert.deepEqual(resolvePreset('', presets, 'pi'), { engine: 'pi', model: undefined })
})

test('the engine of a preset is the one it names', () => {
  assert.equal(resolveEngine('coding', presets, 'vibe'), 'pi')
  assert.equal(resolveEngine('coding-leve', presets, 'pi'), 'vibe')
  assert.equal(resolveEngine('not-a-preset', presets, 'vibe'), 'vibe')
})

test('an empty model is no model', () => {
  const resolved = resolvePreset('x', { x: { engine: 'pi', model: '' } }, 'pi')
  assert.equal(resolved.model, undefined)
})
