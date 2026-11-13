import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { VibeAcpClient } from '../dist/acp-client.js'

const fake = fileURLToPath(new URL('./fake-vibe-acp.mjs', import.meta.url))

function createClient(options = {}) {
  const client = new VibeAcpClient({
    cwd: process.cwd(),
    vibePath: process.execPath,
    args: [fake],
    logger: undefined,
    ...options,
  })
  return client
}

test('the handshake answers with the agent capabilities', async () => {
  const client = createClient()
  await client.initialize()
  assert.equal(client.capabilities.loadSession, true)
  client.close()
})

test('a session is created and its options are remembered', async () => {
  const client = createClient()
  const sessionId = await client.newSession()
  assert.match(sessionId, /^fake-session-/)
  assert.deepEqual(client.optionValues('model'), ['mistral-large-4-0-3'])
  assert.equal(client.optionCurrent('model'), 'mistral-large-4-0-3')
  client.close()
})

test('a prompt streams the answer and answers with the usage', async () => {
  const client = createClient()
  await client.newSession()
  const updates = []
  client.onUpdate((update) => updates.push(update))

  const result = await client.prompt('hello')
  assert.equal(result.stopReason, 'end_turn')
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 8, cachedReadTokens: 4, totalTokens: 132 })

  const kinds = updates.map((update) => update.kind)
  assert.ok(kinds.includes('agent_thought_chunk'))
  assert.ok(kinds.includes('agent_message_chunk'))
  client.close()
})

test('a tool call and its result arrive as updates', async () => {
  const client = createClient()
  await client.newSession()
  const updates = []
  client.onUpdate((update) => updates.push(update))

  await client.prompt('read a.ts with tool')
  const call = updates.find((update) => update.kind === 'tool_call')
  assert.ok(call, 'a tool_call update arrived')
  assert.equal(call.raw.toolCallId, 'call_1')
  const done = updates.find((update) => update.kind === 'tool_call_update')
  assert.equal(done.raw.status, 'completed')
  client.close()
})

test('a config option is set on the session', async () => {
  const client = createClient()
  await client.newSession()
  await client.setOption('model', 'mistral-large-4-0-3')
  assert.equal(client.optionCurrent('model'), 'mistral-large-4-0-3')
  client.close()
})

test('an unknown session cannot be loaded', async () => {
  const client = createClient()
  await client.initialize()
  await assert.rejects(() => client.loadSession('nope'), /unknown session/)
  client.close()
})
