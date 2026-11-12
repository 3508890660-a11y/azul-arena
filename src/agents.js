/**
 * 脚本注册表：扫描 agents/ 与 agents/models/，读每个模块的元信息。
 *
 * 目录约定：
 *   agents/*.mjs          手写基线脚本
 *   agents/models/*.mjs   各模型产出的对战脚本
 *   下划线开头            内部工具，不参与注册
 *
 * 每个脚本必须声明 modes（支持的对战人数）。没写的按「全模式通用」处理，
 * 这样早期脚本不用改；但新写的脚本应该明确声明，否则观战台上看不出它擅长什么。
 */

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ALL_MODES = [2, 3, 4];
const TAG_ORDER = ['基线', '入门', '稳健', '进攻', '进阶', '专精'];

function normalizeModes(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [...ALL_MODES];
  const modes = [...new Set(raw.map(Number).filter((n) => ALL_MODES.includes(n)))].sort((a, b) => a - b);
  return modes.length ? modes : [...ALL_MODES];
}

async function collectScripts(dir, depth = 0) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (depth < 1) found.push(...(await collectScripts(path, depth + 1)));
      continue;
    }
    if (entry.name.endsWith('.mjs')) found.push(path);
  }
  return found;
}

export async function discoverAgents(agentsDir) {
  const files = await collectScripts(agentsDir);
  const list = [];
  const seen = new Set();

  for (const path of files) {
    const file = path.slice(agentsDir.length + 1).replace(/\\/g, '/');
    const fallbackId = basename(path, '.mjs');

    try {
      const module = await import(pathToFileURL(path).href);
      const definition = module.default || module;
      if (!definition || typeof definition.create !== 'function') {
        throw new Error('缺少 create(ctx) 导出');
      }

      let id = String(definition.id || fallbackId);
      if (seen.has(id)) id = `${id}-${fallbackId}`;
      seen.add(id);

      list.push({
        id,
        name: String(definition.name || fallbackId),
        tag: String(definition.tag || ''),
        description: String(definition.description || ''),
        strategy: String(definition.strategy || ''),
        model: String(definition.model || ''),
        modes: normalizeModes(definition.modes),
        file,
        path,
        broken: false,
      });
    } catch (error) {
      list.push({
        id: fallbackId,
        name: fallbackId,
        tag: '',
        description: `脚本加载失败：${error.message}`,
        strategy: '',
        model: '',
        modes: [...ALL_MODES],
        file,
        path,
        broken: true,
      });
    }
  }

  const rank = (tag) => {
    const index = TAG_ORDER.indexOf(tag);
    return index < 0 ? TAG_ORDER.length : index;
  };

  return list.sort((a, b) => rank(a.tag) - rank(b.tag) || a.name.localeCompare(b.name, 'zh'));
}

export function findAgent(list, id) {
  return list.find((agent) => agent.id === id) || null;
}

/** 该人数下可用的脚本。 */
export function agentsForMode(list, playerCount) {
  return list.filter((agent) => !agent.broken && agent.modes.includes(playerCount));
}

/** 给新对局挑默认阵容：优先风格差异大的，且必须支持该人数。 */
export function defaultLineup(list, playerCount) {
  const usable = agentsForMode(list, playerCount);
  const preferred = [
    'tactician', 'wallbuilder', 'denier', 'greedy',
    'glm53', 'kimi31pro', 'deepseekv4pro', 'minimaxm3',
    'hy4', 'step5preview', 'mimov26pro', 'glm53flash',
  ];

  const picked = [];
  for (const id of preferred) {
    const hit = usable.find((agent) => agent.id === id);
    if (hit && !picked.includes(hit.id)) picked.push(hit.id);
    if (picked.length >= playerCount) break;
  }
  for (const agent of usable) {
    if (picked.length >= playerCount) break;
    if (!picked.includes(agent.id)) picked.push(agent.id);
  }
  return picked;
}
