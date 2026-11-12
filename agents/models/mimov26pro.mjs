/**
 * mimov26pro —— 4 人局「反制专家」专精 AI：绊脚砖
 *
 * 信条：四人局不必做最会得分的人，只要做「让领先者最难受的人」。
 *
 * 4 人局的判断依据：
 *  - 9 个工厂、每轮 36 块砖，砖最充裕，几乎不会「没砖可取」，自评因此更看重
 *    「放得下、不溢出」而不是「抢得到」；地板反而常因砖太多放不下而吃罚分。
 *  - 断供摊薄到 3 个对手，纯断供收益最低 → 反制只占一半权重，另一半守自己布局。
 *  - 终局 +2/+7/+10 权重最高、轮次够多 → 布局型策略占优，每次上墙都算行列色进度。
 *  - 四人轮转慢，先手优势放大 → 地板浅时积极抢起始玩家标记。
 *
 * 反制机制（每轮给三个对手排危险度，针对第一名）：
 *  - 抢走他唯一能填的那一色：他对某色的补满需求越急、桌上该色越少，抢得越狠；
 *  - 把中央区堆成他放不下的形状：工厂取砖后落入中央的余色是他的「死色」则加分，
 *    是他的「急需色」则扣分；
 *  - 对手画像：create() 起累计各对手各色取用次数，预测他抢什么、无视什么。
 *
 * 自己明显领先（分数领先 8+）时切换保守模式：不再搅局，只求零溢出、避地板、稳布局。
 *
 * 单文件自包含，不 import 任何其它文件。
 */

const PATTERN_CAP = [1, 2, 3, 4, 5];
const FLOOR = [-1, -1, -2, -2, -2, -3, -3];
const EMPTY = -1;
const COLORS = 5;

// 引擎给的 wallColor 缺失时的兜底（官方拉丁方：每行相对上一行右移一格）
const DEFAULT_WALL = Array.from({ length: 5 }, (_, r) =>
  Array.from({ length: 5 }, (_, c) => (c - r + 5) % 5));

/* ---- 权重：自评与反制在攻击模式下各占一半决策权重 ---- */
const W = {
  gain: 2.3,      // 上墙即时得分
  complete: 2.6,  // 填满一行：变现 + 腾位
  short: 0.35,    // 短行效率：更少砖换一次上墙
  place: 0.30,    // 未填满时放进图案行的砖
  progress: 1.1,  // 越接近填满越接近变现
  bonusScale: 0.5, // ★ 4 人局终局 +2/+7/+10 延迟价值（布局型策略核心）
  spill: 2.7,     // ★ 砖太多放不下 → 溢出，4 人局地板罚分重灾区
  floor: 2.0,     // 地板罚分放大
  first: 3.0,     // ★ 四人轮转慢，先手优势放大
  exact: 0.35,    // 零溢出整批拿走的效率奖励
  selfW: 0.5,     // 攻击模式：自评权重
  denyW: 0.7,     // 攻击模式：反制权重（内部再按需求/稀缺度缩放）
  safeSpill: 1.35, // 保守模式：溢出惩罚再放大
  safeFloor: 1.35, // 保守模式：地板惩罚再放大
};

const LEAD_MARGIN = 8;   // 分数领先达到这个幅度 → 保守模式
const DENY_TAKE_CAP = 3; // 反制计价的取砖数上限（防止中央大份刷爆分值）

/** 目标格填上后能得几分（与引擎 scorePlacement 一致） */
function placementScore(wall, row, col) {
  let h = 1, v = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c--) h += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c++) h += 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r--) v += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r++) v += 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

/** 该格上墙后对终局奖励（行+2 / 列+7 / 色+10）的投影价值 */
function endgameBonus(wall, row, col, color) {
  let rowFilled = 1, colFilled = 1, colorCount = 1;
  for (let i = 0; i < 5; i += 1) {
    if (i !== col && wall[row][i] !== EMPTY) rowFilled += 1;
    if (i !== row && wall[i][col] !== EMPTY) colFilled += 1;
  }
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      if ((r !== row || c !== col) && wall[r][c] === color) colorCount += 1;
    }
  }
  return (rowFilled / 5) * 2 + (colFilled / 5) * 7 + (colorCount / 5) * 10;
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

/** 与引擎 canPlaceInLine 同判：给对手画像/死色判定用 */
function canPlaceColor(seat, line, color) {
  const pattern = seat.pattern[line];
  const cap = PATTERN_CAP[line];
  if (pattern.count >= cap) return false;
  if (pattern.count > 0 && pattern.color !== color) return false;
  if (seat.wall[line].includes(color)) return false;
  return true;
}

/** 一名玩家当前持有各色总数（墙 + 图案行 + 地板），对手画像的差分基数 */
function colorTotals(seat) {
  const totals = [0, 0, 0, 0, 0];
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      const v = seat.wall[r][c];
      if (v >= 0 && v < COLORS) totals[v] += 1;
    }
    const p = seat.pattern[r];
    if (p.count > 0 && p.color != null && p.color >= 0 && p.color < COLORS) {
      totals[p.color] += p.count;
    }
  }
  for (const t of seat.floor) if (t >= 0 && t < COLORS) totals[t] += 1;
  return totals;
}

/** 危险度：分数 + 图案行接近满的程度 + 墙面完整行列数（+ 近乎集齐的颜色） */
function dangerOf(seat) {
  let d = seat.score;
  for (let r = 0; r < 5; r += 1) {
    const p = seat.pattern[r];
    const cap = PATTERN_CAP[r];
    if (p.count > 0) {
      d += (p.count / cap) * 2;
      if (p.count === cap - 1) d += 3; // 只差一块就上墙：最急的即时威胁
    }
  }
  let rows = 0, cols = 0;
  const colorCount = [0, 0, 0, 0, 0];
  for (let r = 0; r < 5; r += 1) {
    if (seat.wall[r].every((cell) => cell !== EMPTY)) rows += 1;
    for (let c = 0; c < 5; c += 1) {
      const v = seat.wall[r][c];
      if (v >= 0 && v < COLORS) colorCount[v] += 1;
    }
  }
  for (let c = 0; c < 5; c += 1) {
    if (seat.wall.every((row) => row[c] !== EMPTY)) cols += 1;
  }
  d += rows * 3 + cols * 5;
  for (let k = 0; k < COLORS; k += 1) {
    if (colorCount[k] >= 4) d += 4;
    else if (colorCount[k] >= 3) d += 1.5;
  }
  return d;
}

/** 对目标的各色需求强度 + 死色标记（放不下 / 不想要的颜色） */
function targetDemand(view, target, pref) {
  const need = [0, 0, 0, 0, 0];
  const dead = [0, 0, 0, 0, 0];

  for (let color = 0; color < COLORS; color += 1) {
    let openRows = 0, usable = 0;
    for (let r = 0; r < 5; r += 1) {
      const p = target.pattern[r];
      const cap = PATTERN_CAP[r];
      if (p.count >= cap) continue;
      openRows += 1;
      if (canPlaceColor(target, r, color)) {
        usable += 1;
        if (p.count > 0 && p.color === color) {
          need[color] += 2.5;                       // 已在攒这一色
          if (p.count === cap - 1) need[color] += 4.5; // 「唯一能填的那一色」
        } else if (p.count === 0) {
          need[color] += 0.7;                        // 空行可以起手
        }
      }
    }
    // 颜色奖励只差一块：他一定会抢
    let onWall = 0;
    for (let r = 0; r < 5; r += 1) {
      for (let c = 0; c < 5; c += 1) if (target.wall[r][c] === color) onWall += 1;
    }
    if (onWall === 4) need[color] += 3;
    else if (onWall === 3) need[color] += 1;

    dead[color] = openRows > 0 ? 1 - usable / openRows : 1;

    // 对手画像微调：历史上越爱抢的颜色，需求可信度越高
    const maxPref = Math.max(1, ...pref);
    need[color] *= 0.75 + 0.25 * (pref[color] / maxPref);
  }
  return { need, dead };
}

export default {
  id: 'mimov26pro',
  name: '绊脚砖',
  tag: '专精',
  model: 'MIMO-v2.6-pro',
  modes: [4],
  strategy: '反制搅局流',
  description: '四人局反制专家：按危险度锁定领先者，抢其待补之色、以死色污染中央；自己领先即转保守布局，兼顾终局行列色奖励。',

  create(ctx) {
    const rng = typeof ctx.rng === 'function' ? ctx.rng : () => 0;
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};

    /* ---- 对手画像：各对手的颜色偏好（跨步累计，随对局生长） ---- */
    const profiles = {}; // seat -> { pref:[5], last:[5] }
    let lastRound = 0;
    let lastMode = 'attack';

    function updateProfiles(view) {
      for (const seat of view.seats) {
        if (seat.seat === view.mySeat) continue;
        const totals = colorTotals(seat);
        let profile = profiles[seat.seat];
        if (!profile) {
          profile = profiles[seat.seat] = { pref: [0, 0, 0, 0, 0], last: totals };
        }
        for (let c = 0; c < COLORS; c += 1) {
          const delta = totals[c] - profile.last[c];
          if (delta > 0) profile.pref[c] += delta;
        }
        profile.last = totals;
      }
    }

    return {
      chooseMove(view, moves) {
        try {
          if (!Array.isArray(moves) || moves.length === 0) return moves && moves[0];

          updateProfiles(view);

          const me = view.seats[view.mySeat];
          const wallColor = view.wallColor || DEFAULT_WALL;

          /* -- 危险度排序：三个对手谁最危险，就针对谁 -- */
          const opponents = view.seats.filter((s) => s.seat !== view.mySeat);
          const ranked = opponents
            .map((s) => ({ seat: s.seat, name: s.name, d: dangerOf(s), score: s.score }))
            .sort((a, b) => b.d - a.d || b.score - a.score);
          const targetInfo = ranked[0] || null;
          const target = targetInfo ? view.seats[targetInfo.seat] : null;

          /* -- 模式：明显领先就转保守，不再搅局 -- */
          const bestOppScore = opponents.reduce((m, s) => Math.max(m, s.score), -Infinity);
          const mode = me.score >= bestOppScore + LEAD_MARGIN ? 'safe' : 'attack';

          if (view.round !== lastRound) {
            lastRound = view.round;
            log(`第${view.round}轮 危险度排名 ${ranked.map((r) => `${r.name}(${r.d.toFixed(0)})`).join(' ')}｜目标 ${target ? target.name : '无'}｜${mode === 'safe' ? '保守布局' : '反制搅局'}`);
          }
          if (mode !== lastMode) {
            lastMode = mode;
            if (mode === 'safe') log('领先稳固，转入保守布局（不再搅局）');
          }

          /* -- 反制弹药：目标的需求 / 死色、桌上余量 -- */
          let need = [0, 0, 0, 0, 0];
          let dead = [0, 0, 0, 0, 0];
          if (target && mode === 'attack') {
            const pref = profiles[target.seat] ? profiles[target.seat].pref : [0, 0, 0, 0, 0];
            const demand = targetDemand(view, target, pref);
            need = demand.need;
            dead = demand.dead;
          }
          const supply = [0, 0, 0, 0, 0];
          for (const factory of view.factories) {
            for (const t of factory) if (t >= 0 && t < COLORS) supply[t] += 1;
          }
          for (const t of view.center) if (t >= 0 && t < COLORS) supply[t] += 1;

          let best = moves[0];
          let bestValue = -Infinity;

          for (const move of moves) {
            const pool = move.source === 'center' ? view.center : view.factories[move.index] || [];
            let taken = 0;
            for (const t of pool) if (t === move.color) taken += 1;
            const leftovers = pool.length - taken;

            /* ===== 自评：上墙 / 溢出 / 地板 / 先手 / 布局 ===== */
            let self = 0;
            let placed = 0, spill = 0;
            if (move.line >= 0) {
              const cap = PATTERN_CAP[move.line];
              const pattern = me.pattern[move.line];
              const room = cap - pattern.count;
              placed = Math.min(room, taken);
              spill = taken - placed;
              const complete = pattern.count + placed === cap;
              if (complete) {
                const col = wallColor[move.line].indexOf(move.color);
                const gain = col >= 0 ? placementScore(me.wall, move.line, col) : 1;
                self += gain * W.gain + W.complete + (5 - cap) * W.short;
                if (col >= 0) self += endgameBonus(me.wall, move.line, col, move.color) * W.bonusScale;
              } else {
                const newCount = pattern.count + placed;
                self += placed * W.place + (newCount / cap) * W.progress;
              }
              if (spill === 0 && taken > 0) self += W.exact;
            } else {
              spill = taken;
            }

            const getsFirst = move.source === 'center' && view.centerFirst === true;
            const addFloor = spill + (getsFirst ? 1 : 0);
            const floorPen = floorPenaltyDelta(me.floor.length, addFloor);
            const spillW = mode === 'safe' ? W.spill * W.safeSpill : W.spill;
            const floorW = mode === 'safe' ? W.floor * W.safeFloor : W.floor;
            self -= spill * spillW;
            self -= floorPen * floorW;
            if (getsFirst) {
              const room = 1 - me.floor.length / 7;
              self += W.first * (room > 0 ? room : 0);
            }

            /* ===== 反制：针对危险度第一名（攻击模式才生效） ===== */
            let deny = 0;
            if (mode === 'attack' && target) {
              // 抢走他唯一能填的那一色：需求越急、桌上越少，抢得越狠
              const scarcity = 0.6 + 0.4 * (taken / Math.max(1, supply[move.color]));
              deny += need[move.color] * Math.min(taken, DENY_TAKE_CAP) * 0.5 * scarcity;

              if (move.source === 'factory') {
                // 余砖滑进中央：堆他放不下的颜色，别喂他急缺的颜色
                if (leftovers > 0) {
                  const rest = pool.length - taken;
                  const liveRatio = rest > 0 ? 1 : 0;
                  if (liveRatio) {
                    let poisonSum = 0, feedSum = 0, restCount = 0;
                    for (const t of pool) {
                      if (t === move.color) continue;
                      restCount += 1;
                      poisonSum += dead[t];
                      feedSum += need[t];
                    }
                    if (restCount > 0) {
                      deny += (poisonSum / restCount) * 0.5;
                      deny -= (feedSum / restCount) * 0.35;
                    }
                  }
                }
              } else {
                // 从中央直接拿走，也顺手抽掉他下一轮能摸到的份额
                deny += need[move.color] * 0.15;
              }
            }

            /* -- 攻击模式：自评与反制各占一半决策权重 -- */
            const value = (mode === 'attack'
              ? W.selfW * self + W.denyW * deny
              : self) + rng() * 1e-4;

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
