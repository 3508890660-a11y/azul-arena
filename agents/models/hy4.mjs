/**
 * hy4 —— 2 人局「极简效率流」专精 AI
 *
 * 信条：每一块砖都必须有去处。
 * 2 人局一轮只有 20 块砖、两人平分，砖极度稀缺；任何一块掉进地板，
 * 既是自己扣分、又是把机会白送给唯一的对手（双重损失）。因此评分
 * 函数把「取走 N 块、只放得下 M 块」的浪费算得一清二楚，宁可少取
 * 也绝不制造溢出。
 *
 * 专精 2 人局的几个判断：
 *  - 短行（1~3 格）用最少的砖换一次上墙，效率最高、见效最快，优先填满变现；
 *  - 地板罚分是真实扣分且边际递增（-1/-1/-2/-2/-2/-3/-3），深地板尤其要躲；
 *  - 起始玩家标记＝下轮先挑工厂，地板浅时值得抢，地板深时果断放弃；
 *  - 零溢出地拿走一整批同色，等于从场上抹掉对手的一个高效选择（断供）。
 *
 * 单文件自包含，不 import 任何其它文件。
 */

const PATTERN_CAP = [1, 2, 3, 4, 5];
const FLOOR = [-1, -1, -2, -2, -2, -3, -3];
const EMPTY = -1;

// 引擎给的 wallColor 缺失时的兜底（官方拉丁方：每行相对上一行右移一格）
const DEFAULT_WALL = Array.from({ length: 5 }, (_, r) =>
  Array.from({ length: 5 }, (_, c) => (c - r + 5) % 5));

/* ---- 权重：只作相对比较，重点是让「溢出 / 地板」压倒一切 ---- */
const W = {
  gain: 2.4,      // 填满上墙的即时真实得分
  complete: 2.8,  // 填满一行：变现 + 清空 + 腾位
  short: 0.35,    // 短行效率：用更少砖换一次上墙
  place: 0.30,    // 未填满时放进图案行的砖（投资，小分）
  progress: 1.2,  // 越接近填满，越接近变现
  spill: 2.6,     // ★ 每块溢出：浪费 + 对手得利 + 占地板
  floor: 1.9,     // ★ 地板罚分放大（低分局 -3 分＝一整轮白干）
  first: 2.6,     // 抢到起始玩家标记＝下轮先手
  deny: 0.55,     // 零溢出拿走大份：对唯一对手的断供
};

/** 目标格填上后能得几分（与引擎 scorePlacement 完全一致） */
function placementScore(wall, row, col) {
  let h = 1, v = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c--) h += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c++) h += 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r--) v += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r++) v += 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

/** 已有 floorLen 块地板时，再压 add 块砖的罚分增量（返回正数） */
function floorPenaltyDelta(floorLen, add) {
  let pen = 0;
  for (let i = 0; i < add; i += 1) {
    const idx = floorLen + i;
    if (idx < FLOOR.length) pen += -FLOOR[idx];
  }
  return pen;
}

function evaluate(view, move) {
  const seat = view.seats[view.mySeat];
  const wallColor = view.wallColor || DEFAULT_WALL;
  const pool = move.source === 'center' ? view.center : view.factories[move.index];
  let taken = 0;
  for (const tile of pool) if (tile === move.color) taken += 1;

  let placed = 0, spill = 0, complete = false, gain = 0;
  if (move.line >= 0) {
    const cap = PATTERN_CAP[move.line];
    const room = cap - seat.pattern[move.line].count;
    placed = Math.min(room, taken);
    spill = taken - placed;
    complete = seat.pattern[move.line].count + placed === cap;
    if (complete) {
      const col = wallColor[move.line].indexOf(move.color);
      gain = col >= 0 ? placementScore(seat.wall, move.line, col) : 1;
    }
  } else {
    spill = taken; // 整批弃地板
  }

  // 从中央取且标记还在 → 标记额外占一格地板，并成为下轮首玩家
  const getsFirst = move.source === 'center' && view.centerFirst === true;
  const addFloor = spill + (getsFirst ? 1 : 0);
  const floorPen = floorPenaltyDelta(seat.floor.length, addFloor);

  let v = 0;

  if (move.line >= 0) {
    if (complete) {
      v += gain * W.gain + W.complete + (5 - PATTERN_CAP[move.line]) * W.short;
    } else {
      const newCount = seat.pattern[move.line].count + placed;
      v += placed * W.place + (newCount / PATTERN_CAP[move.line]) * W.progress;
    }
  }

  // 核心惩罚：把「取多了放不下」的浪费算清楚
  v -= spill * W.spill;
  v -= floorPen * W.floor;

  if (getsFirst) v += W.first;
  // 零溢出地吃下一整批同色：抹掉对手的一个高效选择（2 人局断供）
  if (move.source === 'factory' && spill === 0 && taken >= 2) {
    v += (taken - 1) * W.deny;
  }

  return v;
}

export default {
  id: 'hy4',
  name: '粒粒归仓',
  tag: '专精',
  model: 'hy4',
  modes: [2],
  strategy: '零溢效率流',
  description: '两人局极简效率流：算清取砖数与行容量，零溢出、避地板，短行快速上墙，浅地板时抢先手断供，宁可少取绝不浪费。',

  create(ctx) {
    const rng = typeof ctx.rng === 'function' ? ctx.rng : () => 0;
    return {
      chooseMove(view, moves) {
        try {
          let best = moves[0];
          let bestValue = -Infinity;
          for (const move of moves) {
            const value = evaluate(view, move) + rng() * 1e-4;
            if (value > bestValue) {
              bestValue = value;
              best = move;
            }
          }
          return best || moves[0];
        } catch (_e) {
          return moves[0];
        }
      },
    };
  },
};
