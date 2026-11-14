import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { VibeAgent } from '../dist/vibe-agent.js'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { registerSessionProjections } from '../dist/index.js'
import { buildVibeHistory, buildVibeHistoryPrompt, fitHistoryBudget, renderVibeHistory } from '../dist/history.js'
import { FakeAcp, FakeSession } from './helpers.mjs'

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
    ...(options.approval === undefined ? {} : { approval: options.approval }),
    ...(options.permission === undefined ? {} : { permission: options.permission }),
    ...(options.historyPrompt === undefined ? {} : { historyPrompt: options.historyPrompt }),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
  })
  return { ctx, session, acp, agent }
}

function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }] }
}

const textChunk = (text) => ({ kind: 'agent_message_chunk', raw: { content: { type: 'text', text } } })

test('a permission request goes through the DSH approval chain', async () => {
  const asked = []
  const approval = {
    async request(request) {
      asked.push(request)
      return 'allowed-once'
    },
  }
  const { acp, agent } = createAgent({ approval, acp: { replies: [[textChunk('ok')]] } })
  agent.send(userMessage('m1', 'run something'), 'next-turn', true)
  await agent.whenIdle()

  // The chain is asked when the agent asks; the fake ACP never asks, so the
  // decision path is exercised directly.
  const decision = await acp.onPermission({
    sessionId: 's1',
    toolCallId: 'call_1',
    title: 'Write a.ts',
    options: [{ kind: 'allow_once', optionId: 'yes' }],
  })
  assert.equal(decision, 'allow-once')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].toolName, 'Write a.ts')
  assert.equal(asked[0].callId, 'call_1')
  agent.dispose()
})

test('a rejected approval refuses the tool call', async () => {
  const approval = {
    async request() {
      return 'rejected'
    },
  }
  const { acp, agent } = createAgent({ approval })
  const decision = await acp.onPermission({
    sessionId: 's1',
    title: 'Write a.ts',
    options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject', optionId: 'no' }],
  })
  assert.equal(decision, 'reject')
  agent.dispose()
})

test('without an approval chain the fallback policy decides', async () => {
  const { acp, agent } = createAgent({ permission: 'deny' })
  const decision = await acp.onPermission({
    sessionId: 's1',
    title: 'Write a.ts',
    options: [{ kind: 'allow_once', optionId: 'yes' }],
  })
  assert.equal(decision, 'reject')
  agent.dispose()
})

test('a lost Vibe session is handed the conversation DSH recorded', async () => {
  const { acp, agent } = createAgent({
    historyPrompt: 'User: earlier\nAssistant: answer',
    acp: { replies: [[textChunk('ok')]] },
  })
  agent.send(userMessage('m1', 'now'), 'next-turn', true)
  await agent.whenIdle()

  assert.ok(acp.prompts[0].startsWith('User: earlier'), 'the history leads the prompt')
  assert.ok(acp.prompts[0].includes('now'), 'the new message follows the history')
  agent.dispose()
})

test('the history is handed over once', async () => {
  const { acp, agent } = createAgent({
    historyPrompt: 'User: earlier',
    acp: { replies: [[textChunk('ok')], [textChunk('ok')]] },
  })
  agent.send(userMessage('m1', 'first'), 'next-turn', true)
  await agent.whenIdle()
  agent.send(userMessage('m2', 'second'), 'next-turn', true)
  await agent.whenIdle()

  assert.equal(acp.prompts.length, 2)
  assert.ok(acp.prompts[0].includes('User: earlier'))
  assert.ok(!acp.prompts[1].includes('User: earlier'))
  agent.dispose()
})

test('an image in the user message reaches Vibe as an image block', async () => {
  const stored = {
    ref: { id: 'img-1', mediaType: 'image/png' },
    data: new Uint8Array([1, 2, 3, 4]),
  }
  const attachments = {
    async readImage() {
      return stored
    },
  }
  const { acp, agent } = createAgent({ attachments })
  agent.send({
    id: 'm1',
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image', attachment: stored.ref },
    ],
  }, 'next-turn', true)
  await agent.whenIdle()

  const content = acp.contents[0]
  assert.equal(content.length, 2)
  assert.deepEqual(content[0], { type: 'text', text: 'what is this?' })
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].mimeType, 'image/png')
  assert.equal(content[1].data, Buffer.from([1, 2, 3, 4]).toString('base64'))
  agent.dispose()
})

test('an unreadable image does not lose the text', async () => {
  const attachments = {
    async readImage() {
      throw new Error('gone')
    },
  }
  const { acp, agent } = createAgent({ attachments })
  agent.send({
    id: 'm1',
    role: 'user',
    content: [
      { type: 'text', text: 'what is this?' },
      { type: 'image', attachment: { id: 'img-1', mediaType: 'image/png' } },
    ],
  }, 'next-turn', true)
  await agent.whenIdle()

  assert.equal(acp.contents[0].length, 1)
  assert.deepEqual(acp.contents[0][0], { type: 'text', text: 'what is this?' })
  agent.dispose()
})

test('the history is rendered from the durable log', () => {
  const session = new FakeSession()
  session.append('user/message', { content: [{ type: 'text', text: 'hello' }] })
  session.append('assistant/message', {
    message: { content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hi' }] },
  })
  session.append('tool/result', { message: { content: [{ type: 'text', text: 'file body' }] } })

  const entries = buildVibeHistory({ session })
  assert.deepEqual(entries, [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi' },
    { role: 'tool', text: 'file body' },
  ])

  const prompt = buildVibeHistoryPrompt({ session })
  assert.ok(prompt.includes('User: hello'))
  assert.ok(prompt.includes('Assistant: hi'))
  assert.ok(prompt.includes('Tool: file body'))
  assert.ok(!prompt.includes('thinking'), 'the reasoning is not part of the transcript')
})

test('an empty session renders no history', () => {
  const session = new FakeSession()
  assert.equal(buildVibeHistoryPrompt({ session }), '')
  assert.equal(renderVibeHistory([]), '')
})

test('the inbox projection is registered', async () => {
  // The native loop owns this projection and this plugin replaces it: the
  // frontend's queue dock reads it, so the key must be present.
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await registerSessionProjections(ctx)
  const keys = [...ctx.get('sessionProjections').summaryKeys()]
  assert.ok(keys.includes('inbox'), 'the inbox projection is registered')
  assert.ok(keys.includes('modelSelection'), 'the model selection projection is registered')
  await ctx.fiber.dispose()
})

test('the history fits the context budget', () => {
  // The transcript is the model's context: the provider refuses a request
  // whose context does not fit the model's window.
  const entries = []
  for (let index = 0; index < 40; index += 1) {
    entries.push({ role: 'assistant', text: `message ${index} ${'x'.repeat(400)}` })
  }
  const kept = fitHistoryBudget(entries, 4000)
  const size = kept.reduce((sum, entry) => sum + entry.text.length, 0)
  assert.ok(size <= 4000, `the transcript fits the budget (${size} chars)`)
  assert.match(kept[kept.length - 1].text, /message 39/)
})
