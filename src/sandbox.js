/**
 * 脚本沙箱：每个座位一个常驻 worker 线程。
 *
 * 为什么要隔离：AI 脚本是「用户自己写的代码」，一次死循环就能把整个观战服务
 * 卡死。放进 worker 之后，超时可以直接 terminate，主进程只是少一个参赛者，
 * 不会连累界面和其他座位。
 */

import { Worker } from 'node:worker_threads';

const WORKER_FILE = new URL('./sandbox-worker.mjs', import.meta.url);

export class AgentError extends Error {
  constructor(message, { timeout = false } = {}) {
    super(message);
    this.name = timeout ? 'AgentTimeout' : 'AgentError';
    this.timeout = timeout;
  }
}

export class ScriptAgent {
  /**
   * @param {object} options
   * @param {string} options.scriptPath 脚本绝对路径
   * @param {number} options.seat       座位号
   * @param {number} options.playerCount
   * @param {number} options.seed
   * @param {number} [options.timeout]  单次决策超时（毫秒）
   * @param {(line: string) => void} [options.onLog]
   */
  constructor({ scriptPath, seat, playerCount, seed, timeout = 900, onLog = null }) {
    this.scriptPath = scriptPath;
    this.seat = seat;
    this.playerCount = playerCount;
    this.seed = seed;
    this.timeout = timeout;
    this.onLog = onLog;

    this.worker = null;
    this.pending = new Map();
    this.sequence = 0;
    this.broken = false;
    this.meta = null;
    this.decisions = 0;
    this.totalMs = 0;
  }

  async start() {
    if (this.worker) return this.meta;

    this.worker = new Worker(WORKER_FILE, { stdout: false, stderr: false });
    this.worker.on('message', (message) => this.#handle(message));
    this.worker.on('error', (error) => this.#fail(new AgentError(`脚本线程崩溃：${error.message}`)));
    this.worker.on('exit', (code) => {
      if (!this.broken && code !== 0) this.#fail(new AgentError(`脚本线程退出（code ${code}）`));
    });

    const reply = await this.#request('init', {
      scriptPath: this.scriptPath,
      seat: this.seat,
      playerCount: this.playerCount,
      seed: this.seed,
    }, 5000);

    this.meta = reply.meta || { id: 'unknown', name: '未命名脚本' };
    return this.meta;
  }

  #handle(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'log') {
      this.onLog?.(message.message);
      return;
    }

    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);

    if (message.type === 'error') {
      entry.reject(new AgentError(String(message.message || '脚本出错')));
      return;
    }
    entry.resolve(message);
  }

  #request(type, payload, timeout = this.timeout) {
    if (this.broken) return Promise.reject(new AgentError('脚本已停用'));
    if (!this.worker) return Promise.reject(new AgentError('脚本尚未启动'));

    const id = (this.sequence += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new AgentError(`脚本响应超时（>${timeout}ms）`, { timeout: true });
        this.#fail(error);
        reject(error);
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  #fail(error) {
    if (this.broken) return;
    this.broken = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
    this.#kill();
  }

  #kill() {
    if (!this.worker) return;
    try {
      this.worker.terminate();
    } catch {
      /* ignore */
    }
    this.worker = null;
  }

  /** 请求一次决策。返回脚本给出的 move（未经校验，校验在 runner 里做）。 */
  async decide(view, moves) {
    const started = Date.now();
    const reply = await this.#request('decide', { view, moves });
    this.decisions += 1;
    this.totalMs += Date.now() - started;
    return reply.move;
  }

  get averageMs() {
    return this.decisions ? Math.round(this.totalMs / this.decisions) : 0;
  }

  dispose() {
    this.broken = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new AgentError('对局结束，脚本已释放'));
    }
    this.pending.clear();
    this.#kill();
  }
}
