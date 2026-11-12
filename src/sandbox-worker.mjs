/**
 * 沙箱内的脚本宿主。只做三件事：加载模块、调 create()、转发决策请求。
 * 这里拿不到文件系统之外的任何东西，也改不了主进程状态。
 */

import { parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

let agent = null;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

parentPort.on('message', async (message) => {
  const { id, type } = message || {};

  try {
    if (type === 'init') {
      const module = await import(pathToFileURL(message.scriptPath).href);
      const definition = module.default || module;

      if (!definition || typeof definition.create !== 'function') {
        throw new Error('脚本必须 export default { create(ctx) { ... } }');
      }

      const rng = mulberry32(((message.seed ^ (message.seat * 0x9e3779b9)) >>> 0) || 1);
      agent = definition.create({
        seat: message.seat,
        playerCount: message.playerCount,
        seed: message.seed,
        rng,
        log: (...args) => {
          parentPort.postMessage({
            type: 'log',
            seat: message.seat,
            message: args.map((item) => String(item)).join(' '),
          });
        },
      });

      if (!agent || typeof agent.chooseMove !== 'function') {
        throw new Error('create() 必须返回包含 chooseMove(view, moves) 的对象');
      }

      parentPort.postMessage({
        id,
        type: 'ready',
        meta: {
          id: String(definition.id || 'unknown'),
          name: String(definition.name || definition.id || '未命名脚本'),
          tag: definition.tag ? String(definition.tag) : '',
          description: definition.description ? String(definition.description) : '',
        },
      });
      return;
    }

    if (type === 'decide') {
      if (!agent) throw new Error('脚本尚未初始化');
      const move = await agent.chooseMove(message.view, message.moves);
      parentPort.postMessage({ id, type: 'move', move: move ?? null });
      return;
    }

    throw new Error(`未知的沙箱消息：${type}`);
  } catch (error) {
    parentPort.postMessage({
      id,
      type: 'error',
      message: error && error.stack ? error.stack : String(error),
    });
  }
});
