/**
 * A lock so two runs cannot tag the same library at once — which would interleave their
 * journals and make undo ambiguous.
 *
 * Uses an exclusive-create file, which is atomic on every platform. A lock left behind by
 * a crashed process is detected by checking whether its PID is still alive.
 */
import fs from 'node:fs';
import path from 'node:path';

interface LockBody {
  pid: number;
  started: string;
}

export class LockHeldError extends Error {
  constructor(filePath: string, pid: number) {
    super(`another babeltag run (pid ${pid}) is using this library — lock: ${filePath}`);
    this.name = 'LockHeldError';
  }
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 checks existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class Lock {
  readonly #filePath: string;
  #held = false;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  acquire(): void {
    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    const body: LockBody = { pid: process.pid, started: new Date().toISOString() };
    try {
      fs.writeFileSync(this.#filePath, JSON.stringify(body), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = this.#owner();
      if (owner !== null && processAlive(owner)) throw new LockHeldError(this.#filePath, owner);
      // The holder is gone; take over its stale lock.
      fs.writeFileSync(this.#filePath, JSON.stringify(body));
    }
    this.#held = true;
  }

  release(): void {
    if (!this.#held) return;
    fs.rmSync(this.#filePath, { force: true });
    this.#held = false;
  }

  #owner(): number | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#filePath, 'utf8')) as LockBody;
      return typeof parsed.pid === 'number' ? parsed.pid : null;
    } catch {
      return null;
    }
  }

  /** Run `fn` holding the lock, releasing it whatever happens. */
  static async around<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
    const lock = new Lock(filePath);
    lock.acquire();
    try {
      return await fn();
    } finally {
      lock.release();
    }
  }
}
