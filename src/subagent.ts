/**
 * dsh-vibe-subagent — a DSH subagent provider whose child is the Mistral
 * Vibe agent.
 *
 * Each accepted run spawns `vibe-acp`, negotiates ACP, opens a session in the
 * delegating session's workspace, sends the task as one prompt and returns
 * the final assistant text as the run's output. The child runs to completion
 * and exits — a one-shot, out-of-process engine, exactly like DSH's own
 * `subagent-claude-code` and `subagent-codex` bridges, but for the Mistral
 * Vibe agent.
 *
 * The child is a bare Vibe agent: its own system prompt, its own tools, its
 * own skills. Nothing from the parent conversation, persona, or tool surface
 * crosses the process boundary — `inheritsParentContext: false`, zero prompt
 * collision.
 *
 * Mount alongside the delegation tool and select it by config:
 *
 * ```yaml
 * - id: subagent-vibe
 *   name: 'dsh-vibe-loop/subagent'
 *   config:
 *     providerName: vibe
 *     vibePath: 'vibe-acp'
 *
 * - id: tool-subagent
 *   name: '@deepseek-ai/dsh-tool-subagent'
 *   config:
 *     provider: vibe        # vibe as the delegation engine
 *     toolName: subagent
 *     backgroundMode: one-shot
 *     maxDepth: 'provider-managed'
 * ```
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { spawnVibe } from './spawn.ts'

export const name = 'subagent-vibe'

export const inject = ['subagents']

/** Maximum diagnostic detail carried by a failed run, in UTF-8 bytes. */
const MAX_DIAGNOSTIC_BYTES = 4096

/** Config: how to spawn and drive the child Vibe agent. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `vibe`). Must be unique per mounted instance. */
  providerName?: string
  /** `vibe-acp` executable (default `vibe-acp`, resolved from PATH; or an absolute path). */
  vibePath?: string
  /** Extra arguments passed to every `vibe-acp` invocation. */
  args?: string[]
  /** Vibe model id (for example `mistral-large-4`). Omit for the agent's own default. */
  model?: string
  /** Working-directory override; omit to inherit the delegating parent session's cwd. */
  cwd?: string
  /** Maximum wall-clock time for one run in ms (default 600000 = 10 minutes). */
  timeoutMs?: number
}

export const Config = z.object({
  providerName: z.string(),
  vibePath: z.string(),
  args: z.array(z.string()),
  model: z.string(),
  cwd: z.string(),
  timeoutMs: z.number(),
}) as unknown as z<Config>

/** Flatten the request prompt blocks into the single text task for Vibe. */
function promptText(prompt: readonly ContentBlock[]): string {
  return prompt
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(text => text.length > 0)
    .join('\n')
    .trim()
}

/** Resolve the child cwd: configured override, else the request's resolved cwd. */
function resolveCwd(configured: string | undefined, request: ResolvedSubagentStartRequest): string {
  if (configured !== undefined && configured !== '') return configured
  if (request.cwd === undefined || request.cwd === '') {
    throw new Error('subagent-vibe: the request carries no cwd and no cwd override is configured')
  }
  return request.cwd
}

/** Truncate text to a UTF-8 byte budget. */
function clampUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const buffer = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  return buffer.toString('utf8')
}

export class VibeSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  }
  // The child is a fresh Vibe session: no parent conversation crosses the boundary.
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: Required<Pick<Config, 'vibePath' | 'timeoutMs'>> & Config,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const task = promptText(request.prompt)
    if (task.length === 0) {
      // The seam validates a non-empty prompt before start, but a prompt of
      // only non-text blocks would still flatten to nothing — fail loud.
      throw new Error('subagent-vibe: request prompt contains no text')
    }

    const cwd = resolveCwd(this.config.cwd, request)
    const id = SessionId(`vibe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

    // Provider-owned cancellation: dispose() and the request's abort signal
    // both funnel into one controller, so the run settles as 'aborted' either way.
    const controller = new AbortController()
    const onParentAbort = (): void => { controller.abort() }
    if (request.signal.aborted) controller.abort()
    else request.signal.addEventListener('abort', onParentAbort, { once: true })

    const result = (async (): Promise<SubagentResult> => {
      try {
        const output = await this.runVibe(task, cwd, controller.signal)
        return { output: output.length > 0 ? [{ type: 'text', text: output }] : [], stopReason: 'completed' }
      } catch (error: unknown) {
        if (controller.signal.aborted) return { output: [], stopReason: 'aborted' }
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(`subagent-vibe "${this.name}": child run failed: ${message}`)
        return { output: [], stopReason: 'error', diagnostic: clampUtf8(message, MAX_DIAGNOSTIC_BYTES) }
      } finally {
        request.signal.removeEventListener('abort', onParentAbort)
      }
    })()

    return {
      id,
      result,
      dispose: async () => {
        controller.abort()
        await result
      },
    }
  }

  /**
   * Spawn `vibe-acp`, negotiate ACP, run one prompt and return the answer.
   *
   * The child is driven over stdio with JSON-RPC: `initialize`,
   * `session/new`, `session/prompt`. The answer arrives as
   * `agent_message_chunk` updates while the prompt is pending; the prompt's
   * response only carries the stop reason.
   */
  private async runVibe(task: string, cwd: string, signal: AbortSignal): Promise<string> {
    const child = spawnVibe(this.config.vibePath, this.config.args ?? [], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      windowsHide: true,
    })
    const stdout = child.stdout!
    const stderr = child.stderr!

    let buffer = ''
    let text = ''
    let sessionId: string | undefined
    let nextId = 0
    const pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
    let stderrTail = ''

    const request = (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
      const id = ++nextId
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`subagent-vibe: "${method}" timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    }

    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim() === '') continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        const method = message.method
        if (method === 'session/update') {
          const params = (message.params ?? {}) as { update?: Record<string, unknown> }
          const update = params.update ?? {}
          if (update.sessionUpdate === 'agent_message_chunk') {
            const content = (update.content ?? {}) as { text?: unknown }
            if (typeof content.text === 'string') text += content.text
          }
          continue
        }
        if (message.id !== undefined) {
          const entry = pending.get(Number(message.id))
          if (!entry) continue
          pending.delete(Number(message.id))
          const error = message.error as { message?: string } | undefined
          if (error !== undefined) {
            entry.reject(new Error(`subagent-vibe: ${method ?? 'request'} failed: ${error.message ?? 'unknown error'}`))
            continue
          }
          entry.resolve(message.result)
        }
      }
    })
    stderr.setEncoding('utf8')
    stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2048)
    })

    try {
      await request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, 60_000)
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
      const created = await request('session/new', { cwd, mcpServers: [] }, 120_000) as { sessionId?: string }
      sessionId = created?.sessionId
      if (sessionId === undefined || sessionId === '') {
        throw new Error('subagent-vibe: session/new returned no sessionId')
      }
      if (this.config.model !== undefined && this.config.model !== '') {
        await request('session/set_config_option', {
          sessionId,
          configId: 'model',
          value: this.config.model,
        }, 60_000)
      }
      await request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: task }],
      }, this.config.timeoutMs)
      return text.trim()
    } finally {
      for (const entry of pending.values()) {
        entry.reject(new Error('subagent-vibe: the run was cancelled'))
      }
      pending.clear()
      try {
        child.stdin?.end()
      } catch {
        // already gone
      }
      child.kill('SIGTERM')
    }
  }
}

/**
 * Register the Vibe subagent provider.
 *
 * @returns the disposer that unregisters the provider.
 */
export function apply(ctx: Context, config: Config): () => void {
  const providerName = config.providerName === undefined || config.providerName === '' ? 'vibe' : config.providerName
  const timeoutMs = config.timeoutMs === undefined ? 600000 : config.timeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('subagent-vibe: timeoutMs must be a positive finite number')
  }
  const provider = new VibeSubagentProvider(providerName, ctx, {
    ...config,
    vibePath: config.vibePath === undefined || config.vibePath === '' ? 'vibe-acp' : config.vibePath,
    timeoutMs,
  })
  return ctx.subagents.registerProvider(provider)
}
