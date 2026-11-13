/**
 * Cross-platform process launch for the `vibe-acp` executable.
 *
 * `vibe-acp` is installed by the Mistral Vibe installer, which drops a
 * `.cmd` batch shim on Windows next to the real executable. Node refuses to
 * execute a batch file without a shell (`spawn EINVAL`), so the shim is
 * launched through `cmd.exe` with every argument quoted — quoting keeps the
 * command line injection-free. On POSIX the executable is spawned directly.
 */

import { spawn, type ChildProcessByStdio, type StdioOptions } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

/** Executable extensions Windows accepts. */
const WINDOWS_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat']

export interface SpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: StdioOptions
  signal?: AbortSignal
  windowsHide?: boolean
}

/**
 * Resolve a command to an executable file on Windows.
 *
 * @returns the resolved path, or `undefined` when nothing matched.
 */
export function resolveWindowsExecutable(command: string): string | undefined {
  const lower = command.toLowerCase()
  const hasExtension = WINDOWS_EXTENSIONS.some((extension) => lower.endsWith(extension))
  const candidates: string[] = []
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    candidates.push(command)
    if (!hasExtension) {
      for (const extension of WINDOWS_EXTENSIONS) candidates.push(`${command}${extension}`)
    }
  } else {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (directory === '') continue
      if (hasExtension) {
        candidates.push(join(directory, command))
      } else {
        for (const extension of WINDOWS_EXTENSIONS) candidates.push(join(directory, `${command}${extension}`))
      }
    }
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // not a candidate
    }
  }
  return undefined
}

/** Quote one argument for a `cmd.exe` command line. */
function quoteArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** A child process whose stdin, stdout and stderr are pipes. */
export type PipedChild = ChildProcessByStdio<Writable, Readable, Readable>

/**
 * Spawn the `vibe-acp` executable.
 *
 * On Windows a `.cmd`/`.bat` shim is launched through `cmd.exe` with every
 * argument quoted; everything else is spawned directly.
 */
export function spawnVibe(command: string, args: string[], options: SpawnOptions): PipedChild {
  if (process.platform === 'win32') {
    const resolved = resolveWindowsExecutable(command)
    if (resolved !== undefined && /\.(cmd|bat)$/i.test(resolved)) {
      const commandLine = [quoteArgument(resolved), ...args.map(quoteArgument)].join(' ')
      // `cmd /s /c` strips the outermost quote pair of the command string, so
      // the line is wrapped once more to keep the shim's own path quoted.
      // `windowsVerbatimArguments` keeps Node from re-escaping the quotes
      // into `\"`, which cmd.exe does not understand.
      return spawn(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `"${commandLine}"`],
        { ...options, windowsVerbatimArguments: true },
      ) as unknown as PipedChild
    }
  }
  return spawn(command, args, options) as unknown as PipedChild
}
