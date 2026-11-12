#!/usr/bin/env node
/**
 * 单脚本自检：加载一个 AI 脚本，让它坐 0 号位打完一整局，报告合法性。
 *
 *   node tools/check-agent.mjs agents/models/hy4.mjs 2
 *
 * 只依赖引擎，不依赖任何其它脚本——所以它既能在开发时验脚本，
 * 也能在脚本写崩时告诉你「是规则理解错了，还是只是策略差」。
 */

import { pathToFileURL } from 'node:url';

import {
  applyMove,
  createGame,
  legalMoves,
  moveKey,
  resolveRound,
  startNextRound,
  viewFor,
} from '../src/engine.js';

const scriptPath = process.argv[2];
const playerCount = Number(process.argv[3] || 2);

if (!scriptPath) {
  console.error('用法: node tools/check-agent.mjs <脚本路径> [人数 2|3|4]');
  process.exit(2);
}
if (![2, 3, 4].includes(playerCount)) {
  console.error(`人数必须是 2/3/4，收到 ${playerCount}`);
  process.exit(2);
}

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

/* ------------------------------------------------------------------ */

let definition;
try {
  const module = await import(pathToFileURL(scriptPath).href);
  definition = module.default || module;
} catch (error) {
  console.error(`✗ 脚本加载失败：${error.message}`);
  process.exit(1);
}

const problems = [];
if (!definition || typeof definition.create !== 'function') problems.push('缺少 create(ctx) 导出');
if (!Array.isArray(definition?.modes) || definition.modes.length === 0) problems.push('缺少 modes 数组');
else if (!definition.modes.includes(playerCount)) problems.push(`modes 是 [${definition.modes}]，不含 ${playerCount}`);
if (!definition?.id) problems.push('缺少 id');
if (!definition?.name) problems.push('缺少 name');

console.log(`\n脚本 ${scriptPath}`);
console.log(`  id      ${definition?.id ?? '—'}`);
console.log(`  name    ${definition?.name ?? '—'}`);
console.log(`  model   ${definition?.model ?? '—'}`);
console.log(`  modes   ${JSON.stringify(definition?.modes ?? null)}`);
console.log(`  tag     ${definition?.tag ?? '—'}`);

if (problems.length) {
  console.error(`\n✗ 契约不完整：${problems.join('；')}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 对手：内联的朴素策略，避免依赖其它脚本
 * ------------------------------------------------------------------ */

function makeSimpleAgent() {
  return {
    chooseMove(view, moves) {
      const me = view.seats[view.mySeat];
      let best = moves[0];
      let bestValue = -Infinity;

      for (const move of moves) {
        let value = 0;
        if (move.line >= 0) {
          const pattern = me.pattern[move.line];
          const cap = move.line + 1;
          const room = cap - pattern.count;
          const pool = move.source === 'center' ? view.center : view.factories[move.index] || [];
          const taken = pool.filter((tile) => tile === move.color).length;
          const placed = Math.min(room, taken);
          const spill = taken - placed;

          value += placed * 0.4;
          value -= spill * 1.1;
          if (pattern.count + placed === cap) value += 2 + move.line;
        } else {
          value -= 2;
        }
        if (value > bestValue) {
          bestValue = value;
          best = move;
        }
      }
      return best;
    },
  };
}

/* ------------------------------------------------------------------ */

let agent;
try {
  agent = definition.create({
    seat: 0,
    playerCount,
    seed: 20261112,
    rng: (() => {
      let a = 0x9e3779b9;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })(),
    log: (line) => console.log(`    [agent] ${line}`),
  });
} catch (error) {
  console.error(`\n✗ create(ctx) 抛异常：${error.message}`);
  process.exit(1);
}

if (!agent || typeof agent.chooseMove !== 'function') {
  console.error('\n✗ create(ctx) 必须返回包含 chooseMove(view, moves) 的对象');
  process.exit(1);
}

const rivals = Array.from({ length: playerCount - 1 }, makeSimpleAgent);

let illegal = 0;
let errors = 0;
let decisions = 0;
let totalMs = 0;
let worstMs = 0;

function ask(state, seat) {
  const moves = legalMoves(state);
  const view = viewFor(state, seat);
  const started = Date.now();

  let raw = null;
  try {
    raw = (seat === 0 ? agent : rivals[seat - 1]).chooseMove(view, moves);
  } catch (error) {
    errors += 1;
    console.error(`  步 ${state.moveCount} 抛异常：${error.message}`);
  }

  const elapsed = Date.now() - started;
  totalMs += elapsed;
  worstMs = Math.max(worstMs, elapsed);
  decisions += 1;

  const normalized = normalizeMove(raw);
  const hit = normalized ? moves.find((move) => moveKey(move) === moveKey(normalized)) : null;

  if (!hit) {
    illegal += 1;
    if (illegal <= 3) {
      console.error(`  步 ${state.moveCount} 非法返回：${JSON.stringify(raw)}`);
    }
    return moves[0];
  }
  return hit;
}

const opened = createGame({ playerCount, seed: 20261112, names: ['被测脚本', ...Array.from({ length: playerCount - 1 }, (_, i) => `陪练 ${i + 1}`)] });
let state = opened.state;
let guard = 0;

while (!state.over && guard < 5000) {
  guard += 1;
  if (state.phase === 'draft') {
    state = applyMove(state, ask(state, state.turn)).state;
  } else if (state.phase === 'tiling') {
    state = resolveRound(state).state;
  } else if (state.phase === 'prepare') {
    state = startNextRound(state).state;
  } else {
    break;
  }
}

if (!state.over) {
  console.error(`\n✗ 对局没有正常结束（跑了 ${guard} 步）`);
  process.exit(1);
}

const average = decisions ? (totalMs / decisions).toFixed(2) : '0';
console.log('');
console.log(`  决策 ${decisions} 次｜平均 ${average}ms｜最慢 ${worstMs}ms｜非法 ${illegal}｜异常 ${errors}`);

const mine = state.ranking.find((row) => row.seat === 0);
console.log(`  排名 ${mine.place}/${playerCount}　得分 ${mine.score}　完整行 ${mine.rows}`);
console.log(`  全场 ${state.ranking.map((row) => `${row.place}.${row.name} ${row.score}`).join('　')}`);
console.log(`  轮数 ${state.round}　步数 ${state.moveCount}`);

if (illegal > 0 || errors > 0) {
  console.error('\n✗ 存在非法返回或异常，脚本未通过自检');
  process.exit(1);
}

console.log('\n对局完成');
