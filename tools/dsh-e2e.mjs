/**
 * End-to-end check: mount the plugin on a bare DSH context, drive one real
 * Vibe turn, then resume the same session from the persistence backend.
 *
 * The context carries only the services the plugin's factory contract needs
 * (sessions, agents, session projections, persistence), so this exercises the
 * same code path the desktop app uses — minus the UI.
 *
 * By default the run drives the fake ACP agent (`test/fake-vibe-acp.mjs`), so
 * it is hermetic and burns no Mistral plan. Pass `--real` to drive the
 * installed `vibe-acp` instead.
 *
 * usage: node tools/dsh-e2e.mjs [--real] [cwd]
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolsService from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply, Config, inject, name } from '../dist/index.js'

const args = process.argv.slice(2)
const real = args.includes('--real')
const cwd = args.find(argument => !argument.startsWith('--')) ?? 'C:/Users/danalec'
const out = line => process.stdout.write(line + '\n')
const store = mkdtempSync(join(tmpdir(), 'dsh-vibe-e2e-'))

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)
// The agent scope resolves these through the plugin's dependency API, and the
// frontend's composition reads them from the agent context.
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolsService)
await ctx.plugin(SystemPrompt)
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root: store })

const fake = fileURLToPath(new URL('../test/fake-vibe-acp.mjs', import.meta.url))
const fiber = await ctx.plugin({
  name,
  inject,
  Config,
  apply,
}, {
  ...(real ? {} : { vibePath: process.execPath, vibeArgs: [fake] }),
  cwd,
  model: 'mistral-large-4-0-3',
  pinModel: true,
  debug: true,
})
// A cordis fiber is not thenable, and `fiber.await()` may return before the
// activation settles: wait until the factory slot is actually taken.
const deadline = Date.now() + 10_000
while (Date.now() < deadline) {
  try {
    ctx.agents.requireFactory()
    break
  } catch {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const id = SessionId(`e2e-${Date.now().toString(36)}`)
const handle = await ctx.agents.create({
  sessionId: id,
  agentOptions: { provider: 'mistral', model: 'mistral-large-4-0-3' },
  // The frontend composes the agent in this window (presets, prompt
  // sections, tools) and reads those services from the agent context: a scope
  // that cannot resolve them fails the whole session creation.
  setup: (agentCtx) => {
    // Resolving the services is the point: the frontend's composition reads
    // them from the agent context.
    void agentCtx.systemPrompt
    void agentCtx.tools
    void agentCtx.llm
  },
})
out(`agent created: ${String(id)}`)
out(`agent status: ${handle.agent.status}`)
out(`model: ${JSON.stringify(handle.agent.model.current())}`)

handle.agent.followup({
  id: SessionId(`msg-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: real ? 'Reply with exactly: dsh-vibe-e2e-ok' : 'hello' }],
  source: { kind: 'user' },
})

await handle.agent.whenIdle()
out('first turn; session log:')
for (const event of handle.agent.session.snapshotEvents()) {
  const summary = event.type === 'assistant/message'
    ? JSON.stringify(event.data.message.content)
    : event.type === 'user/message'
      ? JSON.stringify(event.data.content)
      : ''
  out(`  ${event.seq} ${event.type} ${summary}`)
}
await handle.dispose()

// A session stored by another agent — or one whose agent never disposed
// cleanly — carries no end-of-seed marker. A resume has to write that marker
// before it appends anything else, or the session runs one sequence number
// ahead of the store and every later append is refused with "append seq
// mismatch".
await new Promise(resolve => setTimeout(resolve, 1000))
const storedFile = readdirSync(store, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join(store, entry.name, String(id), 'session.v4.jsonl.zstd'))
  .find(file => {
    try { readFileSync(file); return true } catch { return false }
  })
if (storedFile === undefined) throw new Error('the stored session file was not found')
const storedLines = zstdDecompressSync(readFileSync(storedFile)).toString('utf8').split('\n').filter(Boolean)
const withoutMarker = storedLines.filter(line => {
  try { return JSON.parse(line).type !== 'session/end-seed' } catch { return true }
})
if (withoutMarker.length === storedLines.length) out('the stored log carried no end-of-seed marker')
else {
  writeFileSync(storedFile, zstdCompressSync(withoutMarker.join('\n') + '\n'))
  out(`stored log stripped of its end-of-seed marker: ${storedLines.length} -> ${withoutMarker.length} lines`)
}

// Resume: the persisted log must come back, and the Vibe session must be
// reloaded with the conversation it already had.
const resumed = await ctx.agents.resume({ resumeSessionId: id })
out(`resumed: ${String(resumed.agent.id)}`)
out('resumed log:')
for (const event of resumed.agent.session.snapshotEvents()) {
  const summary = event.type === 'assistant/message'
    ? JSON.stringify(event.data.message.content)
    : event.type === 'user/message'
      ? JSON.stringify(event.data.content)
      : ''
  out(`  ${event.seq} ${event.type} ${summary}`)
}
const sidecar = join(process.env.USERPROFILE ?? '', '.dsh', 'vibe-sessions', `${String(id).replace(/[^\w-]/g, '_')}.json`)
out(`vibe session sidecar: ${sidecar}`)
out(readFileSync(sidecar, 'utf8').trim())

resumed.agent.followup({
  id: SessionId(`msg2-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: real ? 'Reply with exactly: dsh-vibe-e2e-resumed' : 'hello again' }],
  source: { kind: 'user' },
})
await resumed.agent.whenIdle()
out('second turn; session log:')
for (const event of resumed.agent.session.snapshotEvents()) {
  const summary = event.type === 'assistant/message'
    ? JSON.stringify(event.data.message.content)
    : event.type === 'user/message'
      ? JSON.stringify(event.data.content)
      : ''
  out(`  ${event.seq} ${event.type} ${summary}`)
}
await resumed.dispose()

// The store is the ground truth. A resumed session that appends ahead of
// the store's cursor is refused with "append seq mismatch", and that
// refusal only shows up in the chat window, not in the agent's own log.
const persistence = ctx.get('sessionPersistence')
const readHandle = await persistence.open(id, 'read')
try {
  const stored = await readHandle.read(SessionLogOffset(0), undefined)
  const events = stored.events
  const contiguous = events.every((event, index) => event.seq === index)
  out(`stored events: ${events.length} | contiguous: ${contiguous ? 'yes' : 'NO'}`)
  if (!contiguous) {
    out(`stored seqs: ${events.map(event => event.seq).join(', ')}`)
    throw new Error('the stored log is not contiguous')
  }
  const assistants = events.filter(event => event.type === 'assistant/message').length
  out(`stored assistant messages: ${assistants}`)
  if (assistants < 2) throw new Error('the resumed turn never reached the store')
} finally {
  await readHandle.close()
}

await fiber.dispose()
await ctx.fiber.dispose()
