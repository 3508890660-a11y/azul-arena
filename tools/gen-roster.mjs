#!/usr/bin/env node
/**
 * 生成 12 模型脚本清单：读 agents/models/*.mjs 的静态信息，合并战绩常量，
 * 输出 roster.json（机器可读）与 ROSTER.md（人读）。
 *
 *   node tools/gen-roster.mjs
 *
 * 战绩来自 tools/roundrobin.mjs 的同模式循环赛，改动脚本后应重跑循环赛再更新 RECORD。
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODELS_DIR = join(ROOT, 'agents', 'models');

/** 派发 subagent 时实际传给路由的模型 ID，与脚本里的 model 中文名分开记。 */
const MODEL_IDS = {
  hy4: 'hy4std',
  hy3: 'hy3',
  glm53: 'glm-5.3',
  glm53flash: 'glm-5.3-flash',
  minimaxm3: 'minimax-m3-pay',
  minimaxm31flash: 'minimax-m3.1-flash',
  kimi31pro: 'kimi-k3.1-pro',
  kimi28preview: 'kimi-k2.8-preview',
  deepseekv41flash: 'deepseek-v4.1-flash',
  deepseekv4pro: 'deepseek-v4-pro',
  step5preview: 'step-5-preview',
  mimov26pro: 'mimo-v2.6-pro',
};

/** 循环赛成绩：2 人 36 局、3 人 36 局、4 人 40 局。 */
const RECORD = {
  hy3: { games: 36, wins: 22, avgScore: 52.1, avgRank: 1.39 },
  glm53flash: { games: 36, wins: 19, avgScore: 53.9, avgRank: 1.47 },
  hy4: { games: 36, wins: 16, avgScore: 56.4, avgRank: 1.56 },
  glm53: { games: 36, wins: 15, avgScore: 51.5, avgRank: 1.58 },

  minimaxm31flash: { games: 36, wins: 22, avgScore: 61.9, avgRank: 1.53 },
  kimi28preview: { games: 36, wins: 15, avgScore: 56.8, avgRank: 1.89 },
  kimi31pro: { games: 36, wins: 7, avgScore: 51.4, avgRank: 2.17 },
  minimaxm3: { games: 36, wins: 4, avgScore: 47.6, avgRank: 2.42 },

  mimov26pro: { games: 40, wins: 16, avgScore: 64.8, avgRank: 2.15 },
  deepseekv41flash: { games: 40, wins: 11, avgScore: 62.4, avgRank: 2.35 },
  step5preview: { games: 40, wins: 9, avgScore: 61.0, avgRank: 2.52 },
  deepseekv4pro: { games: 40, wins: 4, avgScore: 57.3, avgRank: 2.98 },
};

const files = (await readdir(MODELS_DIR)).filter((name) => name.endsWith('.mjs')).sort();

const entries = [];
for (const file of files) {
  const path = join(MODELS_DIR, file);
  const module = await import(pathToFileURL(path).href);
  const definition = module.default || module;

  const [info, source] = await Promise.all([stat(path), readFile(path, 'utf8')]);
  const record = RECORD[definition.id] || null;

  entries.push({
    model: definition.model || '',
    modelId: MODEL_IDS[definition.id] || '',
    id: definition.id,
    name: definition.name,
    strategy: definition.strategy || '',
    tag: definition.tag || '',
    modes: definition.modes || [],
    file: `agents/models/${file}`,
    bytes: info.size,
    lines: source.split('\n').length,
    description: definition.description || '',
    record: record
      ? { ...record, winRate: Math.round((record.wins / record.games) * 100) }
      : null,
  });
}

entries.sort((a, b) => a.modes[0] - b.modes[0] || (b.record?.winRate ?? 0) - (a.record?.winRate ?? 0));

const counts = entries.reduce((acc, entry) => {
  for (const mode of entry.modes) acc[mode] = (acc[mode] || 0) + 1;
  return acc;
}, {});

const roster = {
  title: 'azul-arena · 12 模型对战脚本清单',
  round: 'model-forge-2026-11-12',
  contract: 'agents/models/_CONTRACT.md',
  interface: 'export default { id, name, tag, model, modes, strategy, description, create(ctx) { return { chooseMove(view, moves) } } }',
  isolation: '每个脚本单文件自包含，不 import 其它文件；跑在独立 worker_threads，900ms 超时即判弃权',
  modeCounts: counts,
  recordSource: 'tools/roundrobin.mjs：2 人 36 局、3 人 36 局、4 人 40 局，座位逐局轮换',
  agents: entries,
};

await writeFile(join(MODELS_DIR, 'roster.json'), `${JSON.stringify(roster, null, 2)}\n`, 'utf8');

/* ------------------------------------------------------------------ */

const pad = (text, width) => {
  const raw = String(text ?? '');
  const used = [...raw].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  return raw + ' '.repeat(Math.max(0, width - used));
};

const lines = [
  '# 12 模型对战脚本清单',
  '',
  `生成时间：${new Date().toISOString().slice(0, 10)}　契约：\`agents/models/_CONTRACT.md\``,
  '',
  '每个脚本由不同模型独立生成，单文件自包含，只依赖契约里定义的接口。',
  '`modes` 声明它负责的对战人数——2/3/4 人各 4 个脚本。',
  '',
  '## 清单',
  '',
  '| # | 模型 | 请求 modelId | 脚本 | id | 策略 | 模式 | 战绩 |',
  '|---|---|---|---|---|---|---|---|',
];

entries.forEach((entry, index) => {
  const record = entry.record
    ? `${entry.record.wins}/${entry.record.games} 胜（${entry.record.winRate}%，均分 ${entry.record.avgScore}）`
    : '—';
  lines.push(
    `| ${index + 1} | ${entry.model} | \`${entry.modelId || '—'}\` | \`${entry.file.replace('agents/models/', '')}\` | \`${entry.id}\` | ${entry.strategy} | ${entry.modes.join('/')} 人 | ${record} |`,
  );
});

lines.push('', '## 按模式分组', '');

for (const mode of [2, 3, 4]) {
  const group = entries.filter((entry) => entry.modes.includes(mode));
  lines.push(`**${mode} 人局**（${group.length} 个）`, '');
  lines.push('| 模型 | 脚本 | 策略名 | 说明 |');
  lines.push('|---|---|---|---|');
  for (const entry of group) {
    lines.push(`| ${entry.model} | \`${entry.file.replace('agents/models/', '')}\` | ${entry.strategy} | ${entry.description} |`);
  }
  lines.push('');
}

lines.push(
  '## 接口约定',
  '',
  '```js',
  "export default {",
  "  id: 'hy4',                 // 唯一标识",
  "  name: '粒粒归仓',           // 观战界面显示",
  "  tag: '专精',",
  "  model: 'hy4',             // 产出它的模型",
  "  modes: [2],               // 负责的对战人数",
  "  strategy: '零溢效率流',",
  "  description: '一句话说明',",
  '  create(ctx) {             // ctx: seat / playerCount / seed / rng / log',
  '    return {',
  '      chooseMove(view, moves) { return moves[0]; },   // 返回 moves 里的一项',
  '    };',
  '  },',
  '};',
  '```',
  '',
  '合法性由引擎保证：`moves` 里出现的一定合法，不出现的一定非法。脚本不需要自己判规则。',
  '',
  '## 复现方式',
  '',
  '```bash',
  '# 单个脚本自检（会真的打完整局）',
  'node tools/check-agent.mjs agents/models/hy4.mjs 2',
  '',
  '# 同模式循环赛',
  'node tools/roundrobin.mjs --players 2 --games 12 --ids hy4,hy3,glm53,glm53flash',
  'node tools/roundrobin.mjs --players 3 --games 12 --ids minimaxm3,minimaxm31flash,kimi31pro,kimi28preview',
  'node tools/roundrobin.mjs --players 4 --games 40 --ids deepseekv41flash,deepseekv4pro,step5preview,mimov26pro',
  '```',
  '',
);

await writeFile(join(MODELS_DIR, 'ROSTER.md'), `${lines.join('\n')}`, 'utf8');

console.log(`roster.json / ROSTER.md 已生成：${entries.length} 个脚本，模式分布 ${JSON.stringify(counts)}`);
