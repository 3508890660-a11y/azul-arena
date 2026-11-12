#!/usr/bin/env node
/**
 * 同模式循环赛：把某个人数下所有脚本排成所有可能的阵容，逐局对战并汇总。
 *
 *   node tools/roundrobin.mjs --players 4 --games 12
 *   node tools/roundrobin.mjs --players 2 --games 10 --ids hy4,hy3,glm53,glm53flash
 *
 * 座位每局轮换一次，避免「先手座总是赢」这种由座位带来的假信号。
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentsForMode, discoverAgents, findAgent } from '../src/agents.js';
import { MatchRunner } from '../src/runner.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENTS_DIR = join(ROOT, 'agents');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};

const playerCount = Number(arg('--players', 4));
const gamesPerCombo = Number(arg('--games', 8));
const idFilter = arg('--ids', '');

if (![2, 3, 4].includes(playerCount)) {
  console.error('--players 必须是 2/3/4');
  process.exit(2);
}

const registry = await discoverAgents(AGENTS_DIR);
let pool = agentsForMode(registry, playerCount);

if (idFilter) {
  const wanted = idFilter.split(',').map((s) => s.trim()).filter(Boolean);
  const picked = wanted.map((id) => findAgent(pool, id)).filter(Boolean);
  if (!picked.length) {
    console.error(`没有匹配的脚本：${idFilter}`);
    process.exit(1);
  }
  pool = picked;
}

if (pool.length < playerCount) {
  console.error(`支持 ${playerCount} 人局的脚本只有 ${pool.length} 个，不够开局`);
  process.exit(1);
}

function combinations(items, k) {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [head, ...rest] = items;
  return [
    ...combinations(rest, k - 1).map((combo) => [head, ...combo]),
    ...combinations(rest, k),
  ];
}

const combos = combinations(pool, playerCount);
const stats = new Map(pool.map((agent) => [agent.id, { agent, games: 0, wins: 0, score: 0, rank: 0 }]));
const matrix = new Map();

function bump(a, b, win) {
  const key = `${a}|${b}`;
  if (!matrix.has(key)) matrix.set(key, { a: 0, b: 0 });
  const cell = matrix.get(key);
  if (win) cell.a += 1;
  else cell.b += 1;
}

const startedAt = Date.now();
let played = 0;

for (const combo of combos) {
  for (let g = 0; g < gamesPerCombo; g += 1) {
    const shift = g % combo.length;
    const lineup = [...combo.slice(shift), ...combo.slice(0, shift)];

    let result = null;
    const runner = new MatchRunner({
      playerCount,
      seed: 1 + Math.floor(Math.random() * 999999),
      scriptPaths: lineup.map((agent) => agent.path),
      pace: 0,
      onDone: (payload) => {
        result = payload;
      },
    });

    runner.setSpeed(99);
    await runner.run();
    played += 1;

    if (!result) continue;

    for (const row of result.ranking) {
      const entry = stats.get(lineup[row.seat].id);
      if (!entry) continue;
      entry.games += 1;
      entry.score += row.score;
      entry.rank += row.place;
      if (row.place === 1) entry.wins += 1;
    }

    for (const a of result.ranking) {
      for (const b of result.ranking) {
        if (a.seat === b.seat) continue;
        bump(lineup[a.seat].id, lineup[b.seat].id, a.place < b.place);
      }
    }
  }
}

/* ------------------------------------------------------------------ */

const pad = (text, width) => {
  const raw = String(text);
  const used = [...raw].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  return raw + ' '.repeat(Math.max(0, width - used));
};

console.log(`\n  ${playerCount} 人局循环赛：${combos.length} 种阵容 × ${gamesPerCombo} 局 = ${played} 局\n`);

const rows = [...stats.values()]
  .filter((entry) => entry.games > 0)
  .sort((a, b) => b.wins - a.wins || a.rank / a.games - b.rank / b.games);

const widths = [18, 4, 4, 7, 7, 7];
console.log('  ' + ['脚本', '胜', '局', '胜率', '均分', '均名次'].map((t, i) => pad(t, widths[i])).join(''));
console.log('  ' + widths.map((w) => '─'.repeat(w)).join(''));

for (const entry of rows) {
  const cells = [
    entry.agent.name,
    entry.wins,
    entry.games,
    `${Math.round((entry.wins / entry.games) * 100)}%`,
    (entry.score / entry.games).toFixed(1),
    (entry.rank / entry.games).toFixed(2),
  ];
  console.log('  ' + cells.map((cell, i) => pad(cell, widths[i])).join(''));
}

// 对战矩阵（两两胜负）
console.log('\n  对战胜负（行 vs 列）\n');
const ids = rows.map((entry) => entry.agent.id);
const cellWidth = 12;
console.log('  ' + pad('', 18) + ids.map((id) => pad(id.slice(0, 10), cellWidth)).join(''));

for (const rowId of ids) {
  const cells = ids.map((colId) => {
    if (rowId === colId) return pad('—', cellWidth);
    const forward = matrix.get(`${rowId}|${colId}`);
    const backward = matrix.get(`${colId}|${rowId}`);
    const win = forward?.a ?? 0;
    const loss = backward?.a ?? 0;
    return pad(`${win}:${loss}`, cellWidth);
  });
  console.log('  ' + pad(rowId.slice(0, 16), 18) + cells.join(''));
}

console.log(`\n  用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
