// Probe: does the session header carry the agent preset, and does the
// persistence expose it on resume?
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'dsh-preset-probe-'))
const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root: store })

const deadline = Date.now() + 10_000
while (Date.now() < deadline && ctx.sessions === undefined) {
  await new Promise(resolve => setTimeout(resolve, 10))
}

const id = SessionId(`probe-${Date.now().toString(36)}`)
const preparation = SessionPreparation.create(ctx.sessions.prepare(id, {
  meta: { cwd: 'C:/Users/danalec', agentPreset: 'coding' },
}))
const session = preparation.session
console.log('header after prepare:', JSON.stringify(session.header))

const persistence = ctx.get('sessionPersistence')
const handle = await persistence.create(session.header, {})
await handle.append(session.snapshotEvents(0))
const reopened = await persistence.open(id, 'read')
console.log('header after reopen:', JSON.stringify(reopened.header))
await reopened.close()
await handle.close()
preparation[Symbol.dispose]()
await ctx.fiber.dispose()
