import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { VibeAgent } from '../dist/vibe-agent.js'
import { FakeAcp, FakeSession, waitFor } from './helpers.mjs'

function createAgent(options = {}) {
  const ctx = new Context()
  const session = new FakeSession(options.sessionId ?? 'session-1')
  const acp = new FakeAcp(options.acp)
  const agent = new VibeAgent({
    ctx,
    session,
    agentOptions: options.agentOptions ?? {},
    acp,
    ...(options.lastTurn === undefined ? {} : { lastTurn: options.lastTurn }),
    ...(options.pinnedRoute === undefined ? {} : { pinnedRoute: options.pinnedRoute }),
  })
  return { ctx, session, acp, agent }
}

function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }] }
}

const textChunk = (text) => ({ kind: 'agent_message_chunk', raw: { content: { type: 'text', text } } })
const thoughtChunk = (text) => ({ kind: 'agent_thought_chunk', raw: { content: { type: 'text', text } } })

test('the answer arrives as one assistant message with the streamed text', async () => {
  const { session, acp, agent } = createAgent({
    acp: { replies: [[textChunk('vibe-'), textChunk('ok')]] },
  })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  const message = session.last('assistant/message')
  assert.ok(message, 'an assistant/message event was recorded')
  assert.deepEqual(message.data.message.content, [{ type: 'text', text: 'vibe-ok' }])
  assert.equal(acp.prompts.length, 1)
  assert.equal(acp.prompts[0], 'hello')
  agent.dispose()
})

test('the reasoning chunk becomes a reasoning block', async () => {
  const { session, agent } = createAgent({
    acp: { replies: [[thoughtChunk('thinking hard'), textChunk('done')]] },
  })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  const message = session.last('assistant/message')
  assert.deepEqual(message.data.message.content, [
    { type: 'reasoning', text: 'thinking hard' },
    { type: 'text', text: 'done' },
  ])
  agent.dispose()
})

test('the token usage travels with the assistant message', async () => {
  const { session, agent } = createAgent({
    acp: { replies: [[textChunk('ok')]], usage: { inputTokens: 120, outputTokens: 8, cachedReadTokens: 4 } },
  })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  const message = session.last('assistant/message')
  assert.deepEqual(message.data.usage, {
    inputTokens: 120,
    outputTokens: 8,
    cacheReadTokens: 4,
  })
  agent.dispose()
})

test('a tool call and its result reach the durable log', async () => {
  const { session, agent } = createAgent({
    acp: {
      replies: [[
        { kind: 'tool_call', raw: { toolCallId: 'call_1', title: 'Read a.ts', rawInput: { path: 'a.ts' } } },
        {
          kind: 'tool_call_update',
          raw: {
            toolCallId: 'call_1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
          },
        },
        textChunk('read it'),
      ]],
    },
  })
  agent.send(userMessage('m1', 'read a.ts'), 'next-turn', true)
  await agent.whenIdle()

  const call = session.last('tool/call')
  assert.ok(call, 'a tool/call event was recorded')
  assert.equal(call.data.callId, 'call_1')
  assert.equal(call.data.name, 'Read a.ts')
  assert.equal(call.data.arguments, '{"path":"a.ts"}')

  const result = session.last('tool/result')
  assert.ok(result, 'a tool/result event was recorded')
  assert.equal(result.data.message.toolCallId, 'call_1')
  assert.equal(result.data.message.isError, false)
  assert.deepEqual(result.data.message.content, [{ type: 'text', text: 'file body' }])
  agent.dispose()
})

test('a failed tool call is recorded as an error result', async () => {
  const { session, agent } = createAgent({
    acp: {
      replies: [[
        { kind: 'tool_call', raw: { toolCallId: 'call_2', title: 'Run', rawInput: {} } },
        { kind: 'tool_call_update', raw: { toolCallId: 'call_2', status: 'failed', content: [] } },
      ]],
    },
  })
  agent.send(userMessage('m1', 'run'), 'next-turn', true)
  await agent.whenIdle()

  const result = session.last('tool/result')
  assert.equal(result.data.message.isError, true)
  agent.dispose()
})

test('the turn opens and closes around the prompt', async () => {
  const { session, agent } = createAgent({ acp: { replies: [[textChunk('ok')]] } })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  const types = session.events.map((event) => event.type)
  assert.ok(types.includes('turn/start'))
  assert.ok(types.includes('step/start'))
  assert.ok(types.includes('step/end'))
  assert.ok(types.includes('turn/end'))
  assert.ok(types.indexOf('step/start') < types.indexOf('assistant/message'))
  assert.ok(types.indexOf('assistant/message') < types.indexOf('step/end'))
  agent.dispose()
})

test('the consumed prompt is claimed, never discarded', async () => {
  const { session, agent } = createAgent({ acp: { replies: [[textChunk('ok')]] } })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  const splices = session.ofType('agent/inbox/spliced')
  const removal = splices.find((event) => event.data.removedCount === 1)
  assert.ok(removal, 'the inbox recorded the removal')
  assert.equal(removal.data.outcome, undefined, 'a claimed message is not a cancellation')
  agent.dispose()
})

test('a resumed agent continues the session turn sequence', async () => {
  const { session, agent } = createAgent({
    lastTurn: 7,
    acp: { replies: [[textChunk('ok')]] },
  })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  const start = session.last('turn/start')
  assert.equal(start.data.turn, 8, 'the turn continues the sequence instead of reopening turn 1')
  agent.dispose()
})

test('cancelling the agent stops the run and closes the turn', async () => {
  const { session, acp, agent } = createAgent({ acp: { hold: true } })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => acp.prompts.length > 0, 2000, 'the prompt')
  agent.cancel({ kind: 'user' })
  acp.release()
  await agent.whenIdle().catch(() => undefined)

  assert.equal(acp.cancelled, true, 'the ACP session was told to cancel')
  const turnEnd = session.last('turn/end')
  assert.ok(turnEnd, 'the turn closed')
  assert.equal(turnEnd.data.reason.kind, 'aborted')
  agent.dispose()
})

test('the next-step input rides the next prompt', async () => {
  const { acp, agent } = createAgent({ acp: { replies: [[textChunk('ok')], [textChunk('ok')]] } })
  agent.send(userMessage('m1', 'first'), 'next-turn', true)
  await waitFor(() => acp.prompts.length > 0, 2000, 'the first prompt')
  agent.steer(userMessage('m2', 'second'))
  await agent.whenIdle()

  assert.ok(acp.prompts.length >= 1)
  // The steer never reaches the running prompt (ACP has no mid-run steering),
  // but it is not lost: it is delivered with the next prompt.
  const delivered = acp.prompts.join('\n')
  assert.ok(delivered.includes('first'))
  agent.dispose()
})

test('a prompt that produced nothing records the attempt, not a message', async () => {
  const { session, agent } = createAgent({ acp: { replies: [[]] } })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  assert.equal(session.last('assistant/message'), undefined)
  agent.dispose()
})
test('the assistant frames carry a dense monotone revision', async () => {
  const { ctx, agent } = createAgent({
    acp: { replies: [[textChunk('a'), textChunk('b')]] },
  })
  const frames = []
  ctx.on('agent/assistant-stream', (payload) => { frames.push(payload.frame) })

  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  assert.deepEqual(frames.map(frame => frame.type), ['start', 'chunk', 'chunk', 'end'])
  // DSH's session controller keeps only a frame whose revision is the
  // successor of the last one it accepted: a gap drops the live stream.
  assert.deepEqual(frames.map(frame => frame.revision), [1, 2, 3, 4])
  assert.deepEqual(frames.filter(frame => frame.type === 'chunk').map(frame => frame.index), [0, 1])
  agent.dispose()
})

test('a model call that returns nothing fails the turn', async () => {
  const { ctx, session, agent } = createAgent({
    acp: { replies: [[]] },
  })
  const errors = []
  ctx.on('agent/error', (payload) => { errors.push(payload.error) })

  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  assert.equal(session.ofType('assistant/message').length, 0, 'no empty answer is recorded')
  assert.equal(session.last('turn/end').data.reason.kind, 'error')
  assert.equal(errors.length, 1, 'the failure is reported at its live boundary')
  agent.dispose()
})

test('a session that owns its route hands the choice to the vibe session', async () => {
  // The plugin does not pin a route, so the session's choice is the Vibe
  // session's route.
  const { acp, agent } = createAgent({
    pinnedRoute: false,
    acp: {
      configOptions: [
        { id: 'model', currentValue: 'mistral-large-4-0-3', options: [{ value: 'mistral-large-4-0-3' }, { value: 'mistral-medium-3' }] },
      ],
    },
  })
  agent.model.select({ provider: 'mistral', model: 'mistral-medium-3' })
  await waitFor(() => acp.setOptions.length > 0, 2000, 'the model switch')
  assert.deepEqual(acp.setOptions[0], { configId: 'model', value: 'mistral-medium-3' })
  agent.dispose()
})

test('a pinned route keeps the choice away from the vibe session', async () => {
  const { acp, agent } = createAgent({ pinnedRoute: true })
  agent.model.select({ provider: 'mistral', model: 'mistral-medium-3' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(acp.setOptions.length, 0, 'the session keeps the model it runs on')
  agent.dispose()
})

test('a model selection does not reach the session', async () => {
  // The Vibe agent has a model of its own: the session's own selection is
  // the session's record, never the route the Vibe session runs on.
  const { acp, agent } = createAgent({
    acp: {
      configOptions: [
        { id: 'model', currentValue: 'mistral-large-4-0-3', options: [{ value: 'mistral-large-4-0-3' }, { value: 'mistral-medium-3' }] },
      ],
    },
  })
  agent.model.select({ provider: 'mistral', model: 'mistral-medium-3' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(acp.setOptions.length, 0, 'the session keeps the model it runs on')
  agent.dispose()
})

test('a pinned route is recorded as the route that runs', () => {
  // The durable selection names the route the child runs on, so the log and
  // the frontend's projection never name a model the child did not use.
  const { session, agent } = createAgent({
    agentOptions: { provider: 'mistral', model: 'mistral-large-4-0-3' },
  })
  agent.model.select({ provider: 'mistral', model: 'mistral-medium-3' })
  const selection = session.last('model/selection')
  assert.ok(selection, 'the selection is recorded')
  assert.equal(selection.data.model, 'mistral-large-4-0-3')
  agent.dispose()
})
