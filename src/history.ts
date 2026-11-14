/**
 * VibeHistory — rebuilds a Vibe session's context from DSH's durable log.
 *
 * The Vibe session owns the model's context window: resuming a DSH session
 * normally reloads that session (`session/load`) and the conversation
 * continues exactly where it stopped. When the Vibe session is gone — the
 * user cleared it, the agent was reinstalled, the sidecar was lost — the
 * model would start with an empty context while DSH's log still shows the
 * whole conversation.
 *
 * This module closes that gap: it renders the DSH log as the transcript the
 * model would have seen, so a fresh Vibe session can be handed the history
 * it lost. The transcript is a plain prompt, not a replay of turns: Vibe
 * keeps one conversation per session, so the history arrives as context
 * rather than as a chain of prompts.
 */

import type { Session } from '@deepseek-ai/dsh-session'

export interface BuildVibeHistoryOptions {
  /** The session whose log is rendered. */
  session: Session
  /** How many of the last events to render. */
  limit?: number
  /**
   * Byte budget for the rendered transcript.
   *
   * The transcript is the model's context: the provider refuses a request
   * whose context does not fit the model's window. The budget keeps the
   * transcript inside it, the way the native loop compacts.
   *
   * Defaults to {@link DEFAULT_HISTORY_BUDGET_BYTES}.
   */
  budgetBytes?: number
}

/**
 * Default byte budget for the rendered transcript.
 *
 * The provider rejects the request well before this size — a transcript
 * with one oversized tool result is enough. The budget leaves room for
 * the model's own context window.
 */
export const DEFAULT_HISTORY_BUDGET_BYTES = 1_048_576

/** One rendered line of the transcript. */
export interface VibeHistoryEntry {
  role: 'user' | 'assistant' | 'tool'
  text: string
}

/**
 * Render the conversation a DSH session holds.
 *
 * @returns the entries in chronological order, oldest first.
 */
export function buildVibeHistory(options: BuildVibeHistoryOptions): VibeHistoryEntry[] {
  const entries: VibeHistoryEntry[] = []
  for (const event of options.session.snapshotEvents(options.session.inheritedEventCount)) {
    switch (event.type) {
      case 'user/message': {
        const text = messageText(event.data.content)
        if (text !== '') entries.push({ role: 'user', text })
        break
      }
      case 'assistant/message': {
        const content = event.data.message.content
        const text = content
          .map((block) => {
            if (block.type === 'text') return block.text
            if (block.type === 'reasoning') return ''
            return ''
          })
          .filter((text) => text !== '')
          .join('\n')
        if (text !== '') entries.push({ role: 'assistant', text })
        break
      }
      case 'tool/result': {
        const content = event.data.message.content
        const text = content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .filter((entry) => entry !== '')
          .join('\n')
        if (text !== '') entries.push({ role: 'tool', text })
        break
      }
      default:
        break
    }
  }
  const limit = options.limit ?? 200
  const kept = entries.length > limit ? entries.slice(entries.length - limit) : entries
  return fitHistoryBudget(kept, options.budgetBytes ?? DEFAULT_HISTORY_BUDGET_BYTES)
}

/**
 * Cut the transcript down to the byte budget, oldest entries first.
 *
 * The transcript carries the model's context, and the provider refuses a
 * request whose context does not fit the model's window. The oldest
 * entries go first, the way the native loop compacts.
 *
 * @param entries - the rendered entries, oldest first.
 * @param budget - the byte budget for the rendered transcript.
 * @returns the kept entries.
 */
export function fitHistoryBudget(
  entries: readonly VibeHistoryEntry[],
  budget: number,
): VibeHistoryEntry[] {
  const sizes = entries.map((entry) => entry.text.length)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= budget) return [...entries]
  let start = 0
  let keptSize = total
  while (start < entries.length && keptSize > budget) {
    keptSize -= sizes[start]
    start += 1
  }
  return entries.slice(start)
}

/** Extract the text of a user message's content blocks. */
function messageText(content: readonly { type: string, text?: string }[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text ?? '' : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/**
 * Render the conversation as the prompt text that carries it.
 *
 * The format is a plain transcript: `User:` / `Assistant:` / `Tool:` lines.
 * It is not meant to be pretty — it is meant to carry the context the model
 * lost, and to be obviously a transcript rather than an instruction.
 */
export function renderVibeHistory(entries: readonly VibeHistoryEntry[]): string {
  if (entries.length === 0) return ''
  const lines = [
    'This is the conversation so far, recovered from the host session log.',
    'Continue it as if it had always been part of this conversation.',
    '',
  ]
  for (const entry of entries) {
    const label = entry.role === 'user' ? 'User' : entry.role === 'assistant' ? 'Assistant' : 'Tool'
    lines.push(`${label}: ${entry.text}`)
  }
  return lines.join('\n')
}

/**
 * Build the prompt that hands a fresh Vibe session its lost history.
 *
 * @returns the prompt text, or an empty string when there is no history.
 */
export function buildVibeHistoryPrompt(options: BuildVibeHistoryOptions): string {
  return renderVibeHistory(buildVibeHistory(options))
}
