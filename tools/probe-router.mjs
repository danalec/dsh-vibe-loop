/**
 * Probe: the loop router picks the engine the session's preset names.
 *
 * Mounts the router from the profile (its imports resolve from the
 * profile's node_modules) on a bare DSH context and creates one session per
 * preset, reading the router's own log lines.
 */
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolsService from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'

const PROFILE = process.env.DSH_PROFILE ?? 'C:/Users/danalec/.dsh/profiles/desktop'
const router = await import(`file:///${PROFILE}/dsh/loop-router.mjs`)

const out = line => process.stdout.write(line + '\n')
const store = mkdtempSync(join(tmpdir(), 'dsh-router-probe-'))

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolsService)
await ctx.plugin(SystemPrompt)
await ctx.plugin(LocalCredentialProvider, { dshHome: join(homedir(), '.dsh') })
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root: store })

await ctx.plugin({
  name: router.name,
  inject: router.inject,
  apply: router.apply,
}, {
  presets: {
    coding: { engine: 'pi', model: 'minimax/MiniMax-M3.1-Flash', thinking: 'high' },
    'coding-leve': { engine: 'vibe', model: 'mistral-large-4' },
  },
  default: 'vibe',
  pi: {
    piPath: 'C:\\Users\\danalec\\.pi\\agent\\bin\\pi.cmd',
    cwd: 'C:\\Users\\danalec',
    model: 'minimax/MiniMax-M3.1-Flash-Preview',
    pinModel: true,
  },
  vibe: {
    vibePath: 'C:\\Users\\danalec\\AppData\\Local\\Microsoft\\WinGet\\Links\\vibe-acp.exe',
    cwd: 'C:\\Users\\danalec',
    model: 'mistral-large-4',
    pinModel: true,
    permission: 'dsh',
    mode: 'ask',
  },
})

const deadline = Date.now() + 15_000
while (Date.now() < deadline) {
  try {
    ctx.agents.requireFactory()
    break
  } catch {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

for (const preset of ['coding-leve', 'coding']) {
  const id = SessionId(`probe-${preset}-${Date.now().toString(36)}`)
  const handle = await ctx.agents.create({
    sessionId: id,
    meta: { cwd: 'C:\\Users\\danalec', agentPreset: preset },
  })
  const engine = handle.agent.constructor.name
  const route = handle.agent.model?.current()
  const named = route && route.model !== '' ? `${route.provider}/${route.model}` : 'none'
  const effort = route?.reasoningEffort ?? 'none'
  out(`preset "${preset}" -> session ${String(id)} created; driver: ${engine}; route: ${named}; thinking: ${effort}`)
  await handle.dispose()
}

await ctx.fiber.dispose()
