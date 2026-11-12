/**
 * kimi28preview —— 3 人局「机会主义嗅探」专精 AI
 *
 * 信条：不背长期计划，每一步重新问「现在桌面上最划算的一手是什么」。
 * 三人局 7 工厂 28 砖，两家对手互相消耗，我只要在他们顾不过来的时候
 * 捡走最好的那块——通常是中央区堆出来的大份同色。
 *
 * 三个专精判断：
 *  - 局面嗅探：按轮次/补行进度把局面分为布局期/抢分期/收尾期，
 *    三期用完全不同的评分权重（收尾期重终局奖励 +2/+7/+10）；
 *  - 危险信号：某家对手图案行差 1~2 块就补齐、且所需颜色还在桌面上，
 *    立即切阻断模式——断供不平均用力，只摊给更危险的那一家；
 *  - 中间顺位难受：抢不到先手也捡不到最后一手，所以地板浅时中央区
 *    的起始标记值得抢，深地板果断放弃。
 *
 * 单文件自包含，不 import 任何其它文件。
 */

const EMPTY = -1;
const PATTERN_CAP = [1, 2, 3, 4, 5];
const FLOOR = [-1, -1, -2, -2, -2, -3, -3];

// 引擎给的 wallColor 缺失时的兜底（官方拉丁方：每行相对上一行右移一格）
const DEFAULT_WALL = Array.from({ length: 5 }, (_, r) =>
  Array.from({ length: 5 }, (_, c) => (c - r + 5) % 5));

const PHASE_NAME = { open: '布局期', mid: '抢分期', end: '收尾期' };

/* ---- 三期权重：同一手棋在不同时期价值完全不同 ---- */
const PHASE_W = {
  open: {
    gain: 2.2, complete: 2.6, short: 0.30, place: 0.35, progress: 1.35,
    spill: 2.8, floor: 2.0, first: 2.3, deny: 0.30, bonus: 0.8, block: 1.0,
  },
  mid: {
    gain: 2.9, complete: 3.3, short: 0.25, place: 0.30, progress: 1.10,
    spill: 2.6, floor: 2.0, first: 2.2, deny: 0.55, bonus: 1.8, block: 1.5,
  },
  end: {
    gain: 3.1, complete: 3.8, short: 0.20, place: 0.22, progress: 0.80,
    spill: 2.4, floor: 2.2, first: 1.7, deny: 0.80, bonus: 3.4, block: 2.2,
  },
};

/** 目标格填上后能得几分（与引擎 scorePlacement 一致） */
function placementScore(wall, row, col) {
  let h = 1, v = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c -= 1) h += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c += 1) h += 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r -= 1) v += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r += 1) v += 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

/** 这块砖上墙带来的终局奖励增量（完整行 +2 / 完整列 +7 / 集齐一色 +10） */
function endBonusDelta(wall, row, col, color) {
  let rowFull = true;
  for (let c = 0; c < 5; c += 1) {
    if (c !== col && wall[row][c] === EMPTY) { rowFull = false; break; }
  }
  let colFull = true;
  for (let r = 0; r < 5; r += 1) {
    if (r !== row && wall[r][col] === EMPTY) { colFull = false; break; }
  }
  let colorCount = 1;
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      if (wall[r][c] === color) colorCount += 1;
    }
  }
  return (rowFull ? 2 : 0) + (colFull ? 7 : 0) + (colorCount === 5 ? 10 : 0);
}

/** 未填满时的潜力：朝 nearly-complete 的列 / 颜色投资（收尾期才有意义） */
function potentialValue(wall, row, col, color) {
  let colFill = 0;
  for (let r = 0; r < 5; r += 1) if (wall[r][col] !== EMPTY) colFill += 1;
  let colorCount = 0;
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      if (wall[r][c] === color) colorCount += 1;
    }
  }
  let v = 0;
  if (colFill >= 3) v += (colFill - 2) * 0.35;
  if (colorCount >= 3) v += (colorCount - 2) * 0.45;
  return v;
}

/** 已有 floorLen 块地板时，再压 add 块的罚分增量（正数） */
function floorPenaltyDelta(floorLen, add) {
  let pen = 0;
  for (let i = 0; i < add; i += 1) {
    const idx = floorLen + i;
    if (idx < FLOOR.length) pen += -FLOOR[idx];
  }
  return pen;
}

/** 一名玩家墙面上已补满的完整行数 */
function completedRows(seat) {
  let n = 0;
  for (let r = 0; r < 5; r += 1) {
    let full = true;
    for (let c = 0; c < 5; c += 1) {
      if (seat.wall[r][c] === EMPTY) { full = false; break; }
    }
    if (full) n += 1;
  }
  return n;
}

/** 桌面上各颜色还剩多少（中央区 + 所有工厂） */
function tableAvail(view) {
  const avail = [0, 0, 0, 0, 0];
  for (const t of view.center) avail[t] += 1;
  for (const f of view.factories) {
    for (const t of f) avail[t] += 1;
  }
  return avail;
}

/** 局面嗅探：布局期 / 抢分期 / 收尾期 */
function sniffPhase(view) {
  let maxRows = 0;
  for (const s of view.seats) maxRows = Math.max(maxRows, completedRows(s));
  if (view.round >= 5 || maxRows >= 2 || (view.bagCount <= 14 && view.round >= 3)) return 'end';
  if (view.round <= 2) return 'open';
  return 'mid';
}

/**
 * 危险信号收集：对手某条图案行差 1~2 块就补齐、墙位未堵、所需颜色还在
 * 桌面上 → 记为威胁。danger 按分差与补行进度加权——断供只摊给更危险的一家。
 */
function collectThreats(view) {
  const wallColor = view.wallColor || DEFAULT_WALL;
  const me = view.seats[view.mySeat];
  const avail = tableAvail(view);
  const myRows = completedRows(me);
  const threats = [];
  for (const s of view.seats) {
    if (s.seat === view.mySeat) continue;
    const danger = Math.max(
      0.5,
      1 + (s.score - me.score) / 30 + (completedRows(s) - myRows) * 0.6,
    );
    for (let r = 0; r < 5; r += 1) {
      const p = s.pattern[r];
      if (p.color < 0 || p.count <= 0) continue;
      const cap = PATTERN_CAP[r];
      const room = cap - p.count;
      if (room <= 0 || room > 2) continue;
      const col = wallColor[r].indexOf(p.color);
      if (col < 0 || s.wall[r][col] !== EMPTY) continue; // 墙已堵，行废了
      if (avail[p.color] < room) continue; // 桌面上凑不齐，威胁不成立
      threats.push({
        color: p.color,
        need: room,
        val: placementScore(s.wall, r, col) + cap * 0.4,
        danger,
      });
    }
  }
  return threats;
}

/** 这一手拿走 moveColor 能拆掉多少威胁（按危险度加权，只算最危险的方向） */
function threatScoreFor(moveColor, taken, source, threats) {
  let sum = 0;
  for (const t of threats) {
    if (t.color !== moveColor) continue;
    const got = Math.min(1, taken / t.need);
    // 从工厂取砖，剩下的会滑进中央区仍可被拿，阻断打折扣；中央区取走即真断供
    const ratio = source === 'center' ? got : got * 0.6;
    sum += t.val * t.danger * ratio;
  }
  return sum;
}

/** 起始玩家标记的价值：地板越浅越值得抢 */
function firstTokenValue(view, w) {
  const me = view.seats[view.mySeat];
  if (me.floor.length >= 6) return 0;
  let mult = 1;
  if (me.floor.length >= 5) mult = 0.2;
  else if (me.floor.length >= 4) mult = 0.6;
  return w.first * mult;
}

function evaluate(view, move, phase, threats, blockMode) {
  const w = PHASE_W[phase];
  const me = view.seats[view.mySeat];
  const wallColor = view.wallColor || DEFAULT_WALL;
  const pool = move.source === 'center' ? view.center : (view.factories[move.index] || []);
  let taken = 0;
  for (const t of pool) if (t === move.color) taken += 1;

  let placed = 0;
  let spill = 0;
  let gain = 0;
  let bonus = 0;
  let potential = 0;
  let complete = false;
  let newProg = 0;

  if (move.line >= 0) {
    const cap = PATTERN_CAP[move.line];
    const p = me.pattern[move.line];
    const room = cap - p.count;
    placed = Math.min(room, taken);
    spill = taken - placed;
    complete = p.count + placed === cap;
    const col = wallColor[move.line].indexOf(move.color);
    if (complete) {
      if (col >= 0) {
        gain = placementScore(me.wall, move.line, col);
        bonus = endBonusDelta(me.wall, move.line, col, move.color);
      } else {
        gain = 1;
      }
    } else {
      newProg = (p.count + placed) / cap;
      if (col >= 0) potential = potentialValue(me.wall, move.line, col, move.color);
    }
  } else {
    spill = taken; // 整批弃地板
  }

  const getsFirst = move.source === 'center' && view.centerFirst === true;
  const floorPen = floorPenaltyDelta(me.floor.length, spill + (getsFirst ? 1 : 0));

  // 阻断模式下自己的经营贬值——机会主义者随时可以为拆台让路
  const opportun = blockMode ? 0.75 : 1;

  let v = 0;
  v += gain * w.gain;
  v += bonus * w.bonus;
  if (complete) v += (w.complete + (5 - PATTERN_CAP[move.line]) * w.short) * opportun;
  v += placed * w.place * opportun;
  v += newProg * w.progress * opportun;
  v += potential * w.bonus * 0.35 * opportun;
  v -= spill * w.spill;
  v -= floorPen * w.floor;
  if (getsFirst) v += firstTokenValue(view, w);

  // 捡漏：零溢出地吃下一整批同色（中央区大份最狠），既是自己的收益也是稀释
  if (spill === 0 && taken >= 2) {
    v += (taken - 1) * w.deny * (move.source === 'center' ? 1 : 0.5);
  }

  // 阻断：拆对手即将补齐的行，权重按危险度集中
  const threat = threatScoreFor(move.color, taken, move.source, threats);
  v += threat * w.block * (blockMode ? 1.7 : 1);

  return v;
}

export default {
  id: 'kimi28preview',
  name: '拾荒猎手',
  tag: '专精',
  model: 'KIMI 2.8preview',
  modes: [3],
  strategy: '嗅探捡漏',
  description: '三人局机会主义：嗅探布局/抢分/收尾三期动态换权重，盯最危险对手的补行信号切阻断，专捡中央区大份同色漏。',
  create(ctx) {
    const rng = typeof ctx.rng === 'function' ? ctx.rng : () => 0;
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};
    const mem = { phase: null, block: false };
    return {
      chooseMove(view, moves) {
        try {
          if (!Array.isArray(moves) || moves.length === 0) return null;
          const phase = sniffPhase(view);
          if (phase !== mem.phase) {
            log(`嗅探→${PHASE_NAME[phase]}（第${view.round}轮）`);
            mem.phase = phase;
          }
          const threats = collectThreats(view);
          const blockMode = threats.some((t) => t.val * t.danger >= 5);
          if (blockMode !== mem.block) {
            if (blockMode) log('危险信号：对手即将补行，切阻断模式');
            mem.block = blockMode;
          }
          let best = moves[0];
          let bestValue = -Infinity;
          for (const move of moves) {
            const value = evaluate(view, move, phase, threats, blockMode) + rng() * 1e-4;
            if (value > bestValue) {
              bestValue = value;
              best = move;
            }
          }
          return best || moves[0];
        } catch (_e) {
          return Array.isArray(moves) ? moves[0] : null;
        }
      },
    };
  },
};
