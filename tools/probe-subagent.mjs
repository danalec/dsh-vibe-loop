/**
 * Probe: the Vibe subagent provider runs a real task through vibe-acp.
 *
 * The provider is driven directly (not through the registry): the run itself
 * is what matters — a fresh vibe-acp, an ACP session, one prompt, the
 * answer.
 */
import { Context } from '@deepseek-ai/cordis'
import { VibeSubagentProvider } from '../dist/subagent.js'

const ctx = new Context()
const provider = new VibeSubagentProvider('vibe', ctx, {
  vibePath: 'C:/Users/danalec/AppData/Local/Microsoft/WinGet/Links/vibe-acp.exe',
  timeoutMs: 180000,
})

const run = await provider.start({
  prompt: [{ type: 'text', text: 'Reply with exactly: vibe-subagent-ok' }],
  cwd: 'C:/Users/danalec',
  signal: new AbortController().signal,
  depth: 0,
})
const result = await run.result
console.log('stopReason:', result.stopReason)
console.log('output:', result.output.map(block => block.text ?? '').join('').trim())
await run.dispose()
await ctx.fiber.dispose()
