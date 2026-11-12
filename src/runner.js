/**
 * 对局驱动器。
 *
 * 它把「纯函数引擎」「沙箱里的脚本」「观战界面」三件互不知道对方存在的东西
 * 粘起来：问脚本 -> 校验 -> 落子 -> 广播快照 -> 控节奏。
 *
 * 观战不是"等对局算完再看录像"，而是每一步都推一次状态，所以暂停/单步/调速
 * 都只是这个循环里的一个闸门。
 */

import {
  applyMove,
  createGame,
  describeMove,
  legalMoves,
  moveKey,
  resolveRound,
  snapshot,
  startNextRound,
  viewFor,
} from './engine.js';
import { ScriptAgent } from './sandbox.js';

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function normalizeMove(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw.source === 'center' ? 'center' : raw.source === 'factory' ? 'factory' : null;
  if (!source) return null;
  const index = Number(raw.index);
  const color = Number(raw.color);
  const line = Number(raw.line);
  if (!Number.isInteger(index) || !Number.isInteger(color) || !Number.isInteger(line)) return null;
  return { source, index, color, line };
}

export class MatchRunner {
  constructor({
    playerCount = 4,
    seed = 1,
    scriptPaths = [],
    pace = 480,
    thinkTimeout = 900,
    onStep = null,
    onDone = null,
    onLog = null,
  } = {}) {
    this.playerCount = playerCount;
    this.seed = seed >>> 0 || 1;
    this.scriptPaths = scriptPaths;
    this.basePace = pace;
    this.speed = 1;
    this.thinkTimeout = thinkTimeout;
    this.onStep = onStep;
    this.onDone = onDone;
    this.onLog = onLog;

    this.agents = [];
    this.state = null;
    this.paused = false;
    this.stopped = false;
    this.stepOnce = false;
    this.waiters = [];
    this.warnings = [];
    this.fallbackRng = this.#makeRng(this.seed ^ 0x5f3759df);
  }

  #makeRng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  get paceMs() {
    if (this.basePace <= 0) return 0;              // CLI 批量：能跑多快跑多快
    if (this.speed >= 99) return 20;               // 观战「瞬时」：仍留一点余量给前端渲染
    return Math.max(20, Math.round(this.basePace / this.speed));
  }

  setSpeed(speed) {
    this.speed = Math.max(0.25, Math.min(99, Number(speed) || 1));
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.#wake();
  }

  stepOnce_() {
    this.paused = true;
    this.stepOnce = true;
    this.#wake();
  }

  #wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  async #gate() {
    if (!this.paused || this.stopped) return;
    if (this.stepOnce) {
      this.stepOnce = false;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
    if (this.stepOnce) this.stepOnce = false;
  }

  stop() {
    this.stopped = true;
    this.#wake();
  }

  async prepare() {
    for (let seat = 0; seat < this.playerCount; seat += 1) {
      const agent = new ScriptAgent({
        scriptPath: this.scriptPaths[seat],
        seat,
        playerCount: this.playerCount,
        seed: this.seed,
        timeout: this.thinkTimeout,
        onLog: (line) => this.onLog?.({ seat, message: line }),
      });

      let meta;
      try {
        meta = await agent.start();
      } catch (error) {
        meta = { name: `脚本异常`, id: 'broken' };
        this.warnings.push({ seat, message: `脚本加载失败：${error.message}` });
      }
      this.agents.push(agent);
      this.agents[seat].meta = meta;
    }
    return this.agents.map((agent) => agent.meta.name);
  }

  /** 询问一个座位。返回经过校验的合法行动（必要时用兜底）。 */
  async #ask(state, seat) {
    const view = viewFor(state, seat);
    const moves = legalMoves(state);
    const agent = this.agents[seat];
    const started = Date.now();
    let raw = null;
    let problem = null;

    if (!agent || agent.broken) {
      problem = '脚本不可用，已启用兜底';
    } else {
      try {
        raw = await agent.decide(view, moves);
      } catch (error) {
        problem = `脚本异常：${error.message}`;
      }
    }

    const normalized = normalizeMove(raw);
    const legal = normalized
      ? moves.find((move) => moveKey(move) === moveKey(normalized))
      : null;

    if (!legal) {
      if (!problem) {
        problem = normalized
          ? `返回了非法行动 ${JSON.stringify(normalized)}`
          : `返回了无法识别的行动 ${JSON.stringify(raw)}`;
      }
      // 兜底：优先在「真正放进行里」的行动里挑，避免脚本一坏就全往地板倒
      const pool = moves.filter((move) => move.line !== -1);
      const candidates = pool.length ? pool : moves;
      const fallback = candidates[Math.floor(this.fallbackRng() * candidates.length)];
      this.warnings.push({ seat, message: `${problem}（已兜底）` });
      return { move: fallback, thinkMs: Date.now() - started, problem };
    }

    return { move: legal, thinkMs: Date.now() - started, problem: null };
  }

  async #emit({ state, actor, label, events, thinkMs = 0, problems = [] }) {
    await this.onStep?.({
      snapshot: snapshot(state),
      actor,
      label,
      events,
      thinkMs,
      problems,
      speed: this.speed,
      paused: this.paused,
    });
  }

  async run() {
    const names = await this.prepare();

    try {
      const opened = createGame({ playerCount: this.playerCount, seed: this.seed, names });
      let state = opened.state;
      this.state = state;

      await this.#emit({
        state,
        actor: null,
        label: '开局',
        events: opened.events,
      });

      let guard = 0;
      while (!this.stopped && !state.over) {
        guard += 1;
        if (guard > 8000) throw new Error('对局步数失控，疑似死循环');

        await this.#gate();
        if (this.stopped) break;

        if (state.phase === 'draft') {
          const seat = state.turn;
          const answer = await this.#ask(state, seat);
          const label = describeMove(state, answer.move);
          const result = applyMove(state, answer.move);
          state = result.state;
          this.state = state;

          await this.#emit({
            state,
            actor: seat,
            label,
            events: result.events,
            thinkMs: answer.thinkMs,
            problems: answer.problem ? [{ seat, message: answer.problem }] : [],
          });
          await sleep(this.paceMs);
          continue;
        }

        if (state.phase === 'tiling') {
          const result = resolveRound(state);
          state = result.state;
          this.state = state;
          await this.#emit({
            state,
            actor: null,
            label: `第 ${state.round} 轮结算`,
            events: result.events,
          });
          await sleep(this.paceMs * 2);
          continue;
        }

        if (state.phase === 'prepare') {
          const result = startNextRound(state);
          state = result.state;
          this.state = state;
          await this.#emit({
            state,
            actor: null,
            label: `第 ${state.round} 轮开局`,
            events: result.events,
          });
          await sleep(this.paceMs);
          continue;
        }

        break;
      }

      if (state.over) {
        await this.onDone?.({
          snapshot: snapshot(state),
          ranking: state.ranking,
          warnings: this.warnings,
          agents: this.agents.map((agent, seat) => ({
            seat,
            name: agent.meta?.name || names[seat],
            averageMs: agent.averageMs,
            decisions: agent.decisions,
          })),
        });
      }
    } finally {
      for (const agent of this.agents) {
        try {
          agent.dispose();
        } catch {
          /* ignore */
        }
      }
    }
  }
}
