/**
 * deepseekv4pro —— 4 人局「全局估值」专精 AI
 *
 * 信条：不看「最爽的一手」，只算「可比较的期望分」。给每个候选行动打分：
 *
 *   期望分 = 上墙即时分（本轮真上墙拿到的相邻分）
 *          + 未来上墙概率 × 该格价值（终局行/列/色奖励的边际份额）
 *          − 地板扣分（溢出 + 起始标记占格）
 *          + 阻塞收益（拿走对手在攒的颜色）
 *          − 留砖送分（把成堆好砖留给下家）
 *          − 溢出浪费（本可上墙却被丢弃的机会成本）
 *          + 先手价值（抢到起始玩家标记）
 *
 * 显式建模三件事：
 *  1. 这条图案行多久能填满 —— 用「缺口 need」与「每轮可取速率」估上墙概率；
 *  2. 这个颜色在袋里还剩多少 —— bagColors 越少越难补，供应决定概率上界；
 *  3. 这一手会不会把好砖留给下家 —— 拿走对手在攒的颜色，且别留成堆单色。
 *
 * 4 人局特点（据此设计，不是通用策略）：
 *  - 9 工厂 / 36 块砖四人分，砖最充裕，断供摊薄到 3 个对手，权重压到最低；
 *  - 终局 +2/+7/+10 权重最高，布局（列、色）收益远大于单次上墙，估值里
 *    把列 +7、色 +10 的边际份额算足，引导「追列 / 追色」而非零散铺砖；
 *  - 砖太多放不下是 4 人局的主要地板来源，溢出与地板双重惩罚，逼自己避溢出；
 *  - 轮转慢，先手优势被放大，起始标记给正收益（净值约 +0.8）。
 *
 * 单文件自包含，不 import 任何其它文件。
 */

const EMPTY = -1;

const ROW_BONUS = 2;    // 每完整行
const COL_BONUS = 7;    // 每完整列
const COLOR_BONUS = 10; // 每集齐一色

const FLOOR_PENALTY = [-1, -1, -2, -2, -2, -3, -3];
const FLOOR_SIZE = FLOOR_PENALTY.length;

const W = {
  deny: 0.10,         // 阻塞收益权重（4 人局摊薄到 3 个对手，压得很低）
  leave: 0.05,        // 留成堆好砖给下家的送分惩罚
  waste: 1.0,         // 每块溢出砖的机会成本（本来能上墙）
  first: 1.8,         // 起始玩家标记的先手价值（地板格另扣 1，净值约 +0.8）
  grabPerRound: 2,    // 每轮我大约能锁定某色的砖块数（估取砖速率）
};

// 引擎给的 wallColor 缺失时的兜底（官方拉丁方：每行相对上一行右移一格）
const DEFAULT_WALL = Array.from({ length: 5 }, (_, r) =>
  Array.from({ length: 5 }, (_, c) => (c - r + 5) % 5));

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 目标格填上后能得几分（与引擎 scorePlacement 完全一致） */
function placementScore(wall, row, col) {
  let h = 1;
  let v = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c -= 1) h += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c += 1) h += 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r -= 1) v += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r += 1) v += 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

/** 已有 floorLen 块地板时，再压 add 块砖的罚分增量（返回正数） */
function floorPenaltyDelta(floorLen, add) {
  let pen = 0;
  for (let i = 0; i < add; i += 1) {
    const idx = floorLen + i;
    if (idx < FLOOR_SIZE) pen += -FLOOR_PENALTY[idx];
  }
  return pen;
}

function countTiles(pool, color) {
  let n = 0;
  for (const t of pool) if (t === color) n += 1;
  return n;
}

/** 该颜色此刻散落在工厂 + 中央的可取砖数 */
function countOnTable(view, color) {
  let n = 0;
  for (const f of view.factories) for (const t of f) if (t === color) n += 1;
  for (const t of view.center) if (t === color) n += 1;
  return n;
}

/** 某玩家图案行里正在攒该色的总块数（衡量他多想再拿这个色） */
function patternDemandOf(seat, color) {
  let d = 0;
  for (const p of seat.pattern) if (p.color === color) d += p.count;
  return d;
}

/** 三个对手（不含自己）图案行里该色的总块数 */
function opponentsDemand(view, color) {
  let d = 0;
  for (let i = 0; i < view.playerCount; i += 1) {
    if (i === view.mySeat) continue;
    d += patternDemandOf(view.seats[i], color);
  }
  return d;
}

/** 估剩余轮数：有人某行墙快满则很快收官，否则按 5~6 轮常规节奏 */
function estimateRoundsLeft(view) {
  let bestRow = 0;
  for (const s of view.seats) {
    for (const row of s.wall) {
      let filled = 0;
      for (const cell of row) if (cell !== EMPTY) filled += 1;
      if (filled > bestRow) bestRow = filled;
    }
  }
  if (bestRow >= 4) return 1;           // 只差 1 块就补满一行，本轮可能就是最后一轮
  if (bestRow >= 3) return 2;           // 快收官
  return Math.max(1, 6 - view.round);   // 常规节奏：约 5~6 轮
}

/**
 * 未来上墙概率：该图案行还差 need 块，这个颜色供应 supply 块，
 * playerCount 人分、剩余 roundsLeft 轮。取「供应够不够」与「时间够不够」的较小者。
 *   need<=0 → 本轮就上墙，概率 1；supply=0 → 补无可补，概率 0。
 */
function fillProb(need, supply, playerCount, roundsLeft) {
  if (need <= 0) return 1;
  if (supply <= 0) return 0;
  const perPlayer = supply / playerCount;            // 供应摊到每人
  const bySupply = perPlayer / need;                 // 供应维度
  const byTime = (roundsLeft * W.grabPerRound) / need; // 时间维度
  const p = Math.min(bySupply, byTime);
  return Math.max(0, Math.min(1, p));
}

/** 该格的终局价值 = 行 / 列 / 色三项奖励的边际份额，越接近补满越值钱 */
function positionValue(view, row, col, color) {
  const wall = view.seats[view.mySeat].wall;

  let rowEmpty = 0;
  for (let c = 0; c < 5; c += 1) if (wall[row][c] === EMPTY) rowEmpty += 1;

  let colEmpty = 0;
  for (let r = 0; r < 5; r += 1) if (wall[r][col] === EMPTY) colEmpty += 1;

  let colorPlaced = 0;
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) if (wall[r][c] === color) colorPlaced += 1;
  }
  const colorEmpty = 5 - colorPlaced; // 每色在墙上恰有 5 个格位

  const rowShare = ROW_BONUS / Math.max(1, rowEmpty);
  const colShare = COL_BONUS / Math.max(1, colEmpty);
  const colorShare = COLOR_BONUS / Math.max(1, colorEmpty);

  return rowShare + colShare + colorShare;
}

/* ------------------------------------------------------------------ *
 * 核心：给单个候选行动算可比较的期望分（分项相加，不黑箱）
 * ------------------------------------------------------------------ */

function scoreMove(view, move) {
  const me = view.seats[view.mySeat];
  const wallColor = view.wallColor || DEFAULT_WALL;
  const pool = move.source === 'center' ? view.center : view.factories[move.index];
  const taken = countTiles(pool, move.color);

  // ---- 放置结果 ----
  let placed = 0;
  let spill = 0;
  let complete = false;
  let col = -1;
  if (move.line >= 0) {
    const cap = move.line + 1;
    const room = cap - me.pattern[move.line].count;
    placed = Math.min(room, taken);
    spill = taken - placed;
    complete = me.pattern[move.line].count + placed === cap;
    col = wallColor[move.line].indexOf(move.color);
  } else {
    spill = taken; // 整批弃地板
  }

  // ---- 供应与剩余轮数 ----
  const supply = view.bagColors[move.color] + countOnTable(view, move.color);
  const roundsLeft = estimateRoundsLeft(view);
  const need = move.line >= 0
    ? (move.line + 1) - (me.pattern[move.line].count + placed)
    : Infinity;

  // === (1) 上墙即时分：本轮真上墙，立即拿到的相邻分 ===
  let immediateWall = 0;
  if (move.line >= 0 && complete) {
    immediateWall = placementScore(me.wall, move.line, col);
  }

  // === (2) 未来上墙概率 × 该格价值：终局奖励的期望贡献 ===
  let futureValue = 0;
  if (move.line >= 0) {
    const pv = positionValue(view, move.line, col, move.color);
    const pWall = complete ? 1 : fillProb(need, supply, view.playerCount, roundsLeft);
    futureValue = pWall * pv;
  }

  // === (3) 地板扣分：溢出砖 + 起始标记占格 ===
  const getsFirst = move.source === 'center' && view.centerFirst === true;
  const addFloor = spill + (getsFirst ? 1 : 0);
  const floorPenalty = floorPenaltyDelta(me.floor.length, addFloor);

  // === (4) 阻塞收益：拿走对手正在攒的颜色；越稀缺越值钱 ===
  let deny = 0;
  if (taken > 0) {
    const demand = opponentsDemand(view, move.color);
    const scarcity = 1 / (view.bagColors[move.color] + 1);
    deny = taken * demand * scarcity * W.deny;
  }

  // === 留砖送分：从工厂取走后，剩下的成堆单色滑入中央便宜下家 ===
  let leavePen = 0;
  if (move.source === 'factory') {
    const rest = view.factories[move.index].filter((t) => t !== move.color);
    const counts = [0, 0, 0, 0, 0];
    for (const t of rest) counts[t] += 1;
    for (let c = 0; c < 5; c += 1) {
      if (counts[c] >= 2) {
        const demand = opponentsDemand(view, c);
        const scarcity = 1 / (view.bagColors[c] + 1);
        leavePen += counts[c] * demand * scarcity * W.leave;
      }
    }
  }

  // === (5) 溢出浪费：这些砖本来能上墙，现在被丢弃 ===
  const waste = spill * W.waste;

  // === (6) 先手价值：抢到起始玩家标记（地板格已在 (3) 里扣过 1 分） ===
  const firstValue = getsFirst ? W.first : 0;

  return immediateWall + futureValue - floorPenalty + deny - leavePen - waste + firstValue;
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

export default {
  id: 'deepseekv4pro',
  name: '全局谋士',
  tag: '专精',
  model: 'deepseek v4pro',
  modes: [4],
  strategy: '全局估值',
  description: '四人局全局估值：每手拆成上墙即时分、未来上墙概率乘终局奖励份额、地板扣分与阻塞收益，重列重色、控溢出、抢先手。',

  create(ctx) {
    const rng = typeof ctx.rng === 'function' ? ctx.rng : () => 0;
    return {
      chooseMove(view, moves) {
        try {
          let best = moves[0];
          let bestValue = -Infinity;
          for (const move of moves) {
            const value = scoreMove(view, move) + rng() * 1e-4;
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
