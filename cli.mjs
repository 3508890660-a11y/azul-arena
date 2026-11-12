#!/usr/bin/env node
/**
 * 批量对局 / 单局复盘。
 *
 *   node cli.mjs --games 20 --players 4 --agents tactician,wallbuilder,denier,greedy
 *   node cli.mjs --games 1 --verbose            # 逐手打印
 *   node cli.mjs --list                         # 看看有哪些脚本
 *
 * 走的是和网页完全相同的链路：引擎 + 沙箱 worker + 驱动器。
 * 所以这里跑出来的结果，就是你在观战台上会看到的东西。
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentsForMode, defaultLineup, discoverAgents, findAgent } from './src/agents.js';
import { MatchRunner } from './src/runner.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const AGENTS_DIR = join(ROOT, 'agents');

function readArgs(argv) {
  const args = { games: 1, players: 4, agents: '', seed: 0, verbose: false, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--verbose' || token === '-v') args.verbose = true;
    else if (token === '--list') args.list = true;
    else if (token === '--games') args.games = Number(argv[++i]) || 1;
    else if (token === '--players') args.players = Number(argv[++i]) || 4;
    else if (token === '--agents') args.agents = String(argv[++i] || '');
    else if (token === '--seed') args.seed = Number(argv[++i]) || 0;
  }
  return args;
}

const args = readArgs(process.argv.slice(2));
const registry = await discoverAgents(AGENTS_DIR);
const usable = registry.filter((agent) => !agent.broken);

if (!usable.length) {
  console.error('没有可用脚本，检查 agents/ 目录。');
  process.exit(1);
}

if (args.list) {
  console.log('\n可用脚本：\n');
  for (const agent of registry) {
    const flag = agent.broken ? '✗' : '·';
    const modes = agent.modes.join('/');
    console.log(`  ${flag} ${agent.id.padEnd(16)} ${agent.name.padEnd(12)} ${agent.tag.padEnd(5)} [${modes}] ${agent.description}`);
  }
  console.log('');
  process.exit(0);
}

const playerCount = [2, 3, 4].includes(args.players) ? args.players : 4;

const pool = agentsForMode(registry, playerCount);

const requested = args.agents
  ? args.agents.split(',').map((id) => id.trim()).filter(Boolean)
  : defaultLineup(registry, playerCount);

const lineup = [];
const used = new Set();

for (let seat = 0; seat < playerCount; seat += 1) {
  const id = requested[seat % requested.length];
  let agent = findAgent(registry, id);

  if (agent && !agent.modes.includes(playerCount)) {
    console.warn(`  ⚠ ${agent.name} 只支持 ${agent.modes.join('/')} 人局，已跳过`);
    agent = null;
  }

  // 同一桌不安排重名对手：优先补没上过场的
  if (!agent || agent.broken || used.has(agent.id)) {
    agent = pool.find((candidate) => !used.has(candidate.id)) || agent;
  }

  if (!agent) {
    console.error(`没有支持 ${playerCount} 人局的脚本`);
    process.exit(1);
  }

  used.add(agent.id);
  lineup.push(agent);
}

console.log(`\n  阵容：${lineup.map((agent) => agent.name).join(' / ')}    人数 ${playerCount}\n`);

const tally = new Map();
for (const agent of lineup) {
  if (!tally.has(agent.id)) {
    tally.set(agent.id, { id: agent.id, name: agent.name, games: 0, wins: 0, score: 0, rank: 0, best: 0 });
  }
}

const startedAt = Date.now();

for (let game = 0; game < args.games; game += 1) {
  const seed = args.seed ? args.seed + game : 1 + Math.floor(Math.random() * 999999);
  const verbose = args.verbose;

  let last = null;

  const runner = new MatchRunner({
    playerCount,
    seed,
    scriptPaths: lineup.map((agent) => agent.path),
    pace: 0,
    onStep: verbose
      ? (step) => {
          if (step.actor !== null && step.actor !== undefined) {
            console.log(`  [${String(step.snapshot.round).padStart(2)}] ${step.label}  (${step.thinkMs}ms)`);
          } else if (step.label && step.events.some((e) => e.type !== 'round-start')) {
            console.log(`  -- ${step.label}`);
          }
        }
      : null,
    onDone: (result) => {
      last = result;
    },
  });

  runner.setSpeed(99);
  await runner.run();

  if (!last) {
    console.error(`  第 ${game + 1} 局没有正常结束`);
    continue;
  }

  const ranking = last.ranking;
  for (const row of ranking) {
    const agent = lineup[row.seat];
    const entry = tally.get(agent.id);
    entry.games += 1;
    entry.score += row.score;
    entry.rank += row.place;
    entry.best = Math.max(entry.best, row.score);
    if (row.place === 1) entry.wins += 1;
  }

  const line = ranking
    .map((row) => `${row.place}. ${row.name} ${row.score}`)
    .join('   ');
  console.log(`  第 ${String(game + 1).padStart(2)} 局  seed=${String(seed).padStart(6)}  ${line}`);

  if (last.warnings?.length) {
    for (const warning of last.warnings) {
      console.log(`        ⚠ P${warning.seat + 1} ${warning.message}`);
    }
  }
}

/* ------------------------------------------------------------------ */

console.log('\n  汇总\n');
const rows = [...tally.values()]
  .filter((entry) => entry.games > 0)
  .sort((a, b) => b.wins - a.wins || a.rank / a.games - b.rank / b.games);

const header = ['脚本', '胜', '局', '胜率', '均分', '均名次', '最高'];
const widths = [14, 4, 4, 8, 8, 8, 6];

const pad = (text, width) => {
  const raw = String(text);
  const widthUsed = [...raw].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  return raw + ' '.repeat(Math.max(0, width - widthUsed));
};

console.log('  ' + header.map((text, i) => pad(text, widths[i])).join(''));
console.log('  ' + widths.map((w) => '─'.repeat(w)).join(''));

for (const entry of rows) {
  const cells = [
    entry.name,
    entry.wins,
    entry.games,
    `${Math.round((entry.wins / entry.games) * 100)}%`,
    (entry.score / entry.games).toFixed(1),
    (entry.rank / entry.games).toFixed(2),
    entry.best,
  ];
  console.log('  ' + cells.map((cell, i) => pad(cell, widths[i])).join(''));
}

console.log(`\n  用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
