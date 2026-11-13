import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveVibeRoute } from '../dist/factory.js'

test('the factory default is the route when the caller asks for none', () => {
  const route = resolveVibeRoute('mistral/mistral-large-4-0-3', undefined)
  assert.deepEqual(route, {
    route: 'mistral/mistral-large-4-0-3',
    provider: 'mistral',
    model: 'mistral-large-4-0-3',
  })
})

test('the requested route wins over the factory default', () => {
  const route = resolveVibeRoute('mistral/mistral-large-4-0-3', { provider: 'mistral', model: 'mistral-medium-3-5' })
  assert.equal(route.model, 'mistral-medium-3-5')
  assert.equal(route.provider, 'mistral')
})

test('a requested model without a provider borrows the default provider', () => {
  const route = resolveVibeRoute('mistral/mistral-large-4-0-3', { model: 'mistral-medium-3-5' })
  assert.equal(route.provider, 'mistral')
  assert.equal(route.model, 'mistral-medium-3-5')
})

test('the provider slot never holds a model id', () => {
  const route = resolveVibeRoute('mistral-large-4-0-3', { provider: 'mistral' })
  assert.equal(route.provider, 'mistral')
  assert.equal(route.model, 'mistral-large-4-0-3')
  assert.equal(route.route, 'mistral/mistral-large-4-0-3')
})

test('no route at all stays empty', () => {
  const route = resolveVibeRoute(undefined, undefined)
  assert.deepEqual(route, { route: '', provider: '', model: '' })
})
