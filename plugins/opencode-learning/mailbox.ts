import type { MailboxKind, MailboxWaiter } from './types.ts'

export class InternalMailbox {
  private readonly internal = new Map<string, MailboxKind>()
  private readonly known = new Set<string>()
  private readonly waiters = new Map<string, MailboxWaiter>()
  private readonly early = new Map<string, unknown>()
  private readonly submitted = new Set<string>()

  register(sessionID: string, kind: MailboxKind): void {
    this.known.add(sessionID)
    this.internal.set(sessionID, kind)
  }

  release(sessionID: string): void {
    this.internal.delete(sessionID)
    this.waiters.get(sessionID)?.cancel()
    this.waiters.delete(sessionID)
    this.early.delete(sessionID)
    this.submitted.delete(sessionID)
  }

  isInternalSession(sessionID: string): boolean {
    return this.known.has(sessionID)
  }

  kind(sessionID: string): MailboxKind | undefined {
    return this.internal.get(sessionID)
  }

  sessionIds(): string[] {
    // Array.from keeps this compatible with supported Node 20 releases.
    // eslint-disable-next-line unicorn/prefer-spread
    return Array.from(this.internal.keys())
  }

  hasSubmitted(sessionID: string): boolean {
    return this.submitted.has(sessionID)
  }

  submit(sessionID: string, kind: MailboxKind, payload: unknown): void {
    if (this.internal.get(sessionID) !== kind) {
      throw new Error(`session is not registered for ${kind}`)
    }

    this.submitted.add(sessionID)
    const waiter = this.waiters.get(sessionID)
    if (waiter) {
      this.waiters.delete(sessionID)
      waiter.resolve(payload)
    } else if (this.early.has(sessionID)) {
      throw new Error(`session ${sessionID} already submitted ${kind}`)
    } else {
      this.early.set(sessionID, payload)
    }
  }

  async wait<T>(sessionID: string, timeoutMs: number): Promise<T> {
    if (!this.internal.has(sessionID)) {
      throw new Error(`internal session ${sessionID} is not registered`)
    }

    if (this.early.has(sessionID)) {
      const payload = this.early.get(sessionID)
      this.early.delete(sessionID)
      return payload as T
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(sessionID)
        reject(new Error(`internal agent did not submit within ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.waiters.set(sessionID, {
        resolve(value) {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject(error: unknown) {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error('internal mailbox rejected'))
        },
        cancel() {
          clearTimeout(timer)
        }
      })
    })
  }

  clear(): void {
    for (const waiter of this.waiters.values()) {
      waiter.cancel()
    }

    this.internal.clear()
    this.known.clear()
    this.waiters.clear()
    this.early.clear()
    this.submitted.clear()
  }
}
