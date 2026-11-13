/**
 * VibeSessionMap — the durable link between a DSH session and the Vibe ACP
 * session that carries its conversation.
 *
 * DSH's session log stays the source of truth for the *frontend*: the user
 * messages, the assistant messages and the tool results are all recorded
 * there. The Vibe session, on the other hand, owns the model's own context
 * window — it is the only place where the conversation the model actually
 * sees lives. Resuming a DSH session therefore means telling Vibe to load the
 * ACP session it used before, and that means remembering the ACP session id
 * across processes.
 *
 * The link is kept in a small sidecar file per DSH session, under
 * `~/.dsh/vibe-sessions/`, exactly like the Pi loop's rebuilt session files:
 * outside the DSH session log (which only speaks DSH's own event types) and
 * outside the Vibe session (which Vibe owns).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** What one sidecar remembers. */
export interface VibeSessionRecord {
  /** The DSH session id. */
  dshSessionId: string
  /** The Vibe ACP session id. */
  vibeSessionId: string
  /** The working directory the Vibe session was created with. */
  cwd: string
  /** When the record was written (ISO 8601). */
  updatedAt: string
}

/** Directory holding the sidecar files. */
export function vibeSessionsDir(): string {
  return join(homedir(), '.dsh', 'vibe-sessions')
}

/** The sidecar path of one DSH session. */
export function vibeSessionPath(dshSessionId: string): string {
  const safe = dshSessionId.replace(/[^\w-]/g, '_')
  return join(vibeSessionsDir(), `${safe}.json`)
}

/**
 * Read the ACP session id a DSH session used before.
 *
 * @returns the recorded id, or `undefined` when the session never ran under
 * this driver or the sidecar is gone.
 */
export function readVibeSessionId(dshSessionId: string): string | undefined {
  try {
    const raw = readFileSync(vibeSessionPath(dshSessionId), 'utf8')
    const parsed = JSON.parse(raw) as Partial<VibeSessionRecord>
    if (typeof parsed.vibeSessionId !== 'string' || parsed.vibeSessionId === '') return undefined
    return parsed.vibeSessionId
  } catch {
    return undefined
  }
}

/**
 * Remember the ACP session id of a DSH session.
 *
 * A failure here is never fatal: the worst case is that the next resume
 * starts a fresh Vibe session and the model loses the earlier context.
 */
export function writeVibeSessionId(dshSessionId: string, vibeSessionId: string, cwd: string): void {
  try {
    mkdirSync(vibeSessionsDir(), { recursive: true })
    const record: VibeSessionRecord = {
      dshSessionId,
      vibeSessionId,
      cwd,
      updatedAt: new Date().toISOString(),
    }
    writeFileSync(vibeSessionPath(dshSessionId), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch {
    // the sidecar is a convenience; the session still works without it
  }
}

/** Forget the ACP session id of a DSH session. */
export function forgetVibeSessionId(dshSessionId: string): void {
  try {
    rmSync(vibeSessionPath(dshSessionId), { force: true })
  } catch {
    // nothing to forget
  }
}
