import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'

async function acquired(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let error = ''
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      error += chunk
    })
    child.once('error', reject)
    child.stdin.once('error', reject)
    child.once('exit', (code) => {
      reject(new Error(`directory lock exited (${String(code)}): ${error}`))
    })
    child.stdout.once('data', () => {
      resolve()
    })
  })
}

export async function withDirectoryLock<T>(
  directory: string,
  operation: () => Promise<T>
): Promise<T> {
  await fs.mkdir(directory, { recursive: true })
  const child = spawn('flock', [
    '--exclusive',
    '--no-fork',
    '--',
    directory,
    'sh',
    '-c',
    String.raw`printf "locked\n"; cat >/dev/null`
  ])
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      resolve()
    })
  })
  try {
    await acquired(child)
    return await operation()
  } finally {
    child.stdin.end()
    await closed
  }
}
