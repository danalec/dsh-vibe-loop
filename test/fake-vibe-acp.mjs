#!/usr/bin/env node
/**
 * A fake `vibe-acp`: speaks the Agent Client Protocol over stdio without a
 * Mistral account.
 *
 * It answers `initialize`, `session/new`, `session/load`,
 * `session/set_config_option` and `session/prompt`. A prompt streams a
 * reasoning chunk, an answer chunk and — when the text asks for it — a tool
 * call with its result, then resolves with the stop reason and the usage.
 *
 * The behaviour is driven by the prompt text:
 * - `tool` — the prompt streams a tool call and its result;
 * - `silent` — the prompt streams nothing;
 * - anything else — the prompt streams the answer `vibe-ok`.
 */

import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })
let nextId = 0
const sessions = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function update(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
}

const configOptions = [
  {
    id: 'model',
    currentValue: 'mistral-large-4-0-3',
    options: [{ value: 'mistral-large-4-0-3', name: 'Mistral Large' }],
  },
]

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  const { id, method, params } = message
  switch (method) {
    case 'initialize': {
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { list: {}, fork: {}, close: {} },
        },
        agentInfo: { name: 'fake-vibe', version: '0.0.0' },
      })
      return
    }
    case 'notifications/initialized':
      return
    case 'session/new': {
      const sessionId = `fake-session-${++nextId}`
      sessions.set(sessionId, params?.cwd ?? '')
      respond(id, { sessionId, configOptions })
      return
    }
    case 'session/load': {
      const sessionId = params?.sessionId
      if (!sessions.has(sessionId)) {
        send({ jsonrpc: '2.0', id, error: { code: -32000, message: `unknown session ${sessionId}` } })
        return
      }
      respond(id, { sessionId, configOptions })
      return
    }
    case 'session/set_config_option': {
      const option = configOptions.find(entry => entry.id === params?.configId)
      if (option) option.currentValue = params?.value
      respond(id, { configOptions })
      return
    }
    case 'session/prompt': {
      const sessionId = params?.sessionId
      const text = (params?.prompt ?? []).map(part => part.text ?? '').join('\n')
      if (text.includes('tool')) {
        // Vibe asks before it runs a tool.
        send({
          jsonrpc: '2.0',
          id: ++nextId,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCallId: 'call_1',
            title: 'Read a.ts',
            options: [
              { kind: 'allow_once', optionId: 'allow-once', name: 'Allow once' },
              { kind: 'reject', optionId: 'reject', name: 'Reject' },
            ],
          },
        })
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_1',
          title: 'Read a.ts',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'a.ts' },
        })
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
        })
      }
      if (!text.includes('silent')) {
        update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } })
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'vibe-ok' } })
      }
      respond(id, {
        stopReason: 'end_turn',
        usage: { inputTokens: 120, outputTokens: 8, cachedReadTokens: 4, totalTokens: 132 },
      })
      return
    }
    case 'session/cancel': {
      respond(id, {})
      return
    }
    default: {
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
      }
    }
  }
})

process.stdin.on('end', () => process.exit(0))
