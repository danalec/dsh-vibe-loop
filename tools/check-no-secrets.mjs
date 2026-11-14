/**
 * Scan the repository history for anything that looks like a secret.
 *
 * Two passes, because they catch different things:
 *
 * - the exact values the host holds (the credential store, Pi's own auth
 *   file, the MCP configuration), and
 * - the shapes a secret takes, for a key this check does not know about.
 *
 * usage: node tools/check-no-secrets.mjs [repo ...]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const repos = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['../dsh-pi-loop', '../dsh-vibe-loop']

/**
 * The secret-shaped values the host holds.
 *
 * @returns the values, by the place they came from.
 */
function knownSecrets() {
  const values = new Map()

  const add = (where, value) => {
    if (typeof value !== 'string' || value.length < 8) return
    values.set(`${where}`, value)
  }

  // The harness's credential store: every reference and every record.
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    let section = ''
    for (const line of text.split('\n')) {
      const head = /^([a-z]+):\s*$/.exec(line)
      if (head) {
        section = head[1]
        continue
      }
      const entry = /^ {2,4}([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line)
      if (entry) add(`${section}.${entry[1]}`, entry[2])
    }
  } catch { /* no store */ }

  // Pi's own auth file.
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf8'))
    for (const [provider, record] of Object.entries(auth)) {
      if (typeof record?.key === 'string') add(`pi.auth.${provider}`, record.key)
    }
  } catch { /* no auth file */ }

  // The MCP configuration: the environment it hands to the servers.
  try {
    const mcp = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'mcp.json'), 'utf8'))
    for (const [server, config] of Object.entries(mcp.mcpServers ?? {})) {
      for (const [name, value] of Object.entries(config?.env ?? {})) {
        if (/KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL/i.test(name)) {
          add(`pi.mcp.${server}.${name}`, value)
        }
      }
    }
  } catch { /* no mcp file */ }

  return values
}

/** The shapes a secret takes. */
const PATTERNS = [
  { name: 'openai-style key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'alibaba token-plan key', pattern: /\bsk-sp-[A-Za-z0-9_.-]{20,}/g },
  { name: 'anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openrouter key', pattern: /\bsk-or-[A-Za-z0-9_-]{20,}/g },
  { name: 'google api key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { name: 'github token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'credential in a url', pattern: /[a-z+]+:\/\/[^\s/@:]+:[^\s/@]+@/g },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
]

const values = knownSecrets()
console.log(`known secret values checked: ${values.size}`)

/** The fragments of a value that would identify it. */
function fragments(value) {
  const found = new Set([value])
  if (value.length >= 24) {
    found.add(value.slice(0, 12))
    found.add(value.slice(-8))
    found.add(value.slice(0, 8))
  }
  return [...found].filter(fragment => fragment.length >= 8)
}

let leaks = 0
for (const repo of repos) {
  const objects = execFileSync('git', ['-C', repo, 'rev-list', '--objects', '--all'], { encoding: 'utf8' })
  const blobs = objects.split('\n').filter(Boolean).map(line => line.split(' ')[0])
  const messages = execFileSync('git', ['-C', repo, 'log', '--all', '--format=%B%n---'], { encoding: 'utf8' })

  console.log(`\n${repo}: ${blobs.length} objects`)

  for (const id of blobs) {
    const type = execFileSync('git', ['-C', repo, 'cat-file', '-t', id], { encoding: 'utf8' }).trim()
    if (type !== 'blob') continue
    const body = execFileSync('git', ['-C', repo, 'cat-file', 'blob', id], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    for (const [name, value] of values) {
      for (const fragment of fragments(value)) {
        if (!body.includes(fragment)) continue
        const line = body.split('\n').findIndex(row => row.includes(fragment))
        console.log(`  LEAK: the value of ${name} is in ${repo} ${id.slice(0, 10)} (line ${line + 1})`)
        leaks += 1
      }
    }
    for (const { name, pattern } of PATTERNS) {
      pattern.lastIndex = 0
      const match = pattern.exec(body)
      if (match === null) continue
      console.log(`  SHAPE: a ${name} is in ${repo} ${id.slice(0, 10)}: ${match[0].slice(0, 12)}…`)
      leaks += 1
    }
  }

  for (const [name, value] of values) {
    for (const fragment of fragments(value)) {
      if (!messages.includes(fragment)) continue
      console.log(`  LEAK: the value of ${name} is in a commit message of ${repo}`)
      leaks += 1
    }
  }
  for (const { name, pattern } of PATTERNS) {
    pattern.lastIndex = 0
    const match = pattern.exec(messages)
    if (match === null) continue
    console.log(`  SHAPE: a ${name} is in a commit message of ${repo}: ${match[0].slice(0, 12)}…`)
    leaks += 1
  }
}

console.log(`\nleaks found: ${leaks}`)
process.exit(leaks === 0 ? 0 : 1)
