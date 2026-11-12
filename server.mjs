/**
 * 观战服务：零依赖 HTTP + SSE。
 *
 * 单进程只跑一局（单机观战台的正确规模），所有连上来的页面看到同一场对局。
 * 若将来要多开桌子，把 `current` 换成 Map<matchId, ...> 即可，其余不用动。
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultLineup, discoverAgents, findAgent } from './src/agents.js';
import { MatchRunner } from './src/runner.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const AGENTS_DIR = join(ROOT, 'agents');
const PORT = Number(process.argv[2] || process.env.PORT || 4297);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

/* ------------------------------------------------------------------ *
 * 会话状态
 * ------------------------------------------------------------------ */

const clients = new Set();
let registry = [];
let current = {
  runner: null,
  snapshot: null,
  status: 'idle',
  log: [],
  result: null,
  config: null,
  startedAt: 0,
};

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const response of clients) {
    try {
      response.write(frame);
    } catch {
      clients.delete(response);
    }
  }
}

function pushLog(entry) {
  current.log.push(entry);
  if (current.log.length > 400) current.log.splice(0, current.log.length - 400);
}

function publicConfig() {
  return {
    playerCount: current.config?.playerCount ?? 0,
    seed: current.config?.seed ?? 0,
    agents: current.config?.agents ?? [],
  };
}

function startMatch({ playerCount, seed, agents }) {
  if (current.runner) {
    current.runner.stop();
    current.runner = null;
  }

  // 只接受「支持该人数」的脚本：2 人专精的脚本硬塞进 4 人局只会自曝其短
  const chosen = (agents || [])
    .map((id) => findAgent(registry, id))
    .filter((agent) => agent && !agent.broken && agent.modes.includes(playerCount));
  if (chosen.length < playerCount) {
    const fill = defaultLineup(registry, playerCount);
    while (chosen.length < playerCount) {
      const candidate = findAgent(registry, fill[chosen.length % fill.length]);
      chosen.push(candidate || { id: 'random', name: '随机漫步', path: join(AGENTS_DIR, 'random.mjs') });
    }
  }

  const lineup = chosen.slice(0, playerCount);
  current.config = { playerCount, seed, agents: lineup.map((agent) => agent.id) };
  current.status = 'running';
  current.log = [];
  current.result = null;
  current.startedAt = Date.now();

  const runner = new MatchRunner({
    playerCount,
    seed,
    scriptPaths: lineup.map((agent) => agent.path),
    onStep: (step) => {
      current.snapshot = step.snapshot;
      broadcast({ type: 'step', ...step });
      if (step.label && step.actor !== null) {
        pushLog({ kind: 'move', seat: step.actor, text: step.label, thinkMs: step.thinkMs });
      } else if (step.label) {
        pushLog({ kind: 'phase', text: step.label });
      }
      for (const problem of step.problems || []) {
        pushLog({ kind: 'warn', seat: problem.seat, text: problem.message });
      }
    },
    onDone: (result) => {
      current.status = 'done';
      current.result = result;
      current.snapshot = result.snapshot;
      broadcast({ type: 'done', ...result });
      pushLog({ kind: 'done', text: '对局结束' });
    },
    onLog: ({ seat, message }) => {
      pushLog({ kind: 'agent', seat, text: message });
      broadcast({ type: 'agent-log', seat, message });
    },
  });

  current.runner = runner;
  broadcast({ type: 'new', config: publicConfig(), agents: registry.map(({ path, ...rest }) => rest) });

  runner.run().catch((error) => {
    current.status = 'error';
    broadcast({ type: 'error', message: error.message });
    pushLog({ kind: 'warn', text: `对局异常：${error.message}` });
  });

  return current.config;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function serveStatic(response, urlPath) {
  let filePath = resolve(ROOT, `.${urlPath}`);
  if (urlPath === '/' || urlPath.endsWith('/')) filePath = join(filePath, 'index.html');

  const rel = relative(ROOT, filePath);
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('403 Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    const target = info.isDirectory() ? join(filePath, 'index.html') : filePath;
    const body = await readFile(target);
    response.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('404 Not Found');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === '/api/agents') {
      sendJson(response, 200, {
        agents: registry.map(({ path, ...rest }) => rest),
      });
      return;
    }

    if (pathname === '/api/state') {
      sendJson(response, 200, {
        status: current.status,
        snapshot: current.snapshot,
        log: current.log,
        result: current.result,
        config: publicConfig(),
        agents: registry.map(({ path, ...rest }) => rest),
      });
      return;
    }

    if (pathname === '/api/stream') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write(': connected\n\n');

      clients.add(response);
      response.write(`data: ${JSON.stringify({
        type: 'hello',
        status: current.status,
        snapshot: current.snapshot,
        log: current.log,
        result: current.result,
        config: publicConfig(),
        agents: registry.map(({ path, ...rest }) => rest),
      })}\n\n`);

      const heartbeat = setInterval(() => {
        try {
          response.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 25000);

      request.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(response);
      });
      return;
    }

    if (pathname === '/api/new' && request.method === 'POST') {
      const body = await readJson(request);
      const playerCount = [2, 3, 4].includes(Number(body.playerCount)) ? Number(body.playerCount) : 4;
      const seed = Number.isInteger(Number(body.seed)) && Number(body.seed) > 0
        ? Number(body.seed)
        : 1 + Math.floor(Math.random() * 999999);
      const agents = Array.isArray(body.agents) ? body.agents.map(String) : [];
      const config = startMatch({ playerCount, seed, agents });
      sendJson(response, 200, { ok: true, config });
      return;
    }

    if (pathname === '/api/control' && request.method === 'POST') {
      const body = await readJson(request);
      const runner = current.runner;
      if (!runner) {
        sendJson(response, 409, { ok: false, message: '当前没有进行中的对局' });
        return;
      }
      switch (body.action) {
        case 'pause':
          runner.pause();
          current.status = 'paused';
          break;
        case 'resume':
          runner.resume();
          current.status = 'running';
          break;
        case 'step':
          runner.stepOnce_();
          current.status = 'paused';
          break;
        case 'speed':
          runner.setSpeed(body.speed);
          break;
        default:
          sendJson(response, 400, { ok: false, message: `未知指令 ${body.action}` });
          return;
      }
      broadcast({ type: 'control', status: current.status, speed: runner.speed, paused: runner.paused });
      sendJson(response, 200, { ok: true, status: current.status, speed: runner.speed });
      return;
    }

    await serveStatic(response, pathname === '/' ? '/' : pathname);
  } catch (error) {
    sendJson(response, 500, { ok: false, message: error.message });
  }
});

registry = await discoverAgents(AGENTS_DIR);
const usable = registry.filter((agent) => !agent.broken);

if (!usable.length) {
  console.error('没有找到任何可用脚本，请检查 agents/ 目录。');
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`\n  花砖物语观战台　http://localhost:${PORT}\n`);
  console.log(`  已加载脚本：${usable.map((agent) => `${agent.name}(${agent.id})`).join('　')}`);
  if (registry.length !== usable.length) {
    for (const broken of registry.filter((agent) => agent.broken)) {
      console.log(`  ⚠ ${broken.file} 加载失败：${broken.description}`);
    }
  }
  console.log('');
  startMatch({ playerCount: 4, seed: 1 + Math.floor(Math.random() * 999999), agents: [] });
});
