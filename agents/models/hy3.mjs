/**
 * hy3 —— 2 人局「先手锁喉」专精脚本。
 *
 * 核心思路（硬约束）：
 *   1. 控制回合顺序。2 人局只有 5 个工厂、20 块砖，谁拿起始玩家标记，
 *      下一轮就第一个挑工厂——几乎是决定性的。能负担罚分时就抢标记，
 *      地板快满、罚不起时才把标记甩给对手。
 *   2. 砖极稀缺，任何一次断供 100% 转化为相对优势。盯住对手图案行，
 *      预判他想拿的颜色，提前截断。
 *   3. 地板罚分在低分局比重极高，溢出到地板一律重罚。
 *
 * 纯 ESM、无外部依赖、只用 ctx.rng()。
 */

// —— 规则常量（与引擎一致，本地重定义，不 import 任何文件）——
const WALL_COLOR = [
  [0, 1, 2, 3, 4],
  [4, 0, 1, 2, 3],
  [3, 4, 0, 1, 2],
  [2, 3, 4, 0, 1],
  [1, 2, 3, 4, 0],
];
const FLOOR_PENALTY = [-1, -1, -2, -2, -2, -3, -3];
const EMPTY = -1;
const PATTERN_CAP = [1, 2, 3, 4, 5];

// —— 评估权重 ——
const TOKEN_WORTH = 2.5;  // 抢到先手（下一轮首挑）的价值（只在放上图案行时才计）
const DENY_WEIGHT = 1.8;  // 截断对手所需颜色的价值
const PLACED_W = 1.0;     // 放进图案行的砖（建设是核心）
const COMPLETE_BONUS = 2; // 填满一行的额外奖励基数
const TAKEN_W = 0.1;      // 整批拿走的砖（效率 + 断供）
const SPILL_FLAT = 1.5;   // 每张溢出砖的额外平摊罚分
const SET_W = 6;          // 集齐整色（终局 +10）的折让权重
const COL_W = 1.0;        // 完整行的折让权重（终局 +2）
const OPEN_BONUS = 1.0;   // 给尚未占坑的颜色开家的奖励

function countColor(pool, color) {
  let n = 0;
  for (let i = 0; i < pool.length; i += 1) if (pool[i] === color) n += 1;
  return n;
}

// 把 color 放到 wall[row][col] 的即时得分（与引擎 scorePlacement 同算法）
function wallPoints(wall, row, col, color) {
  let h = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c -= 1) h += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c += 1) h += 1;
  let v = 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r -= 1) v += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r += 1) v += 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

// 本步会让地板额外背多少罚分（含起始标记的占位 + 溢出砖的移位）
function addedPenalty(floorLen, token, spill) {
  let pen = 0;
  let idx = floorLen;
  if (token) {
    pen += Math.abs(FLOOR_PENALTY[idx] || 0);
    idx += 1;
  }
  for (let i = 0; i < spill; i += 1) pen += Math.abs(FLOOR_PENALTY[idx + i] || 0);
  return pen;
}

// 找出对手最想要的颜色（图案行正在攒的 / 墙面差一块就集齐的）
function opponentTargetColor(opp) {
  let best = -1;
  let bestNeed = 0;
  for (let r = 0; r < 5; r += 1) {
    const pat = opp.pattern[r];
    if (pat.color !== null && pat.count > 0 && pat.count < r + 1) {
      const need = r + 1 - pat.count;
      if (need > bestNeed) { bestNeed = need; best = pat.color; }
    }
  }
  // 墙面颜色差一块集齐（列/色集），同样是最想要的颜色
  for (let color = 0; color < 5; color += 1) {
    let have = 0;
    for (let r = 0; r < 5; r += 1) if (opp.wall[r].includes(color)) have += 1;
    if (have === 4) {
      // 已 4 块，再拿 1 块就集齐整色（+10）或整列（+7），优先级最高
      if (4 > bestNeed) { bestNeed = 4; best = color; }
    }
  }
  return best;
}

export default {
  id: 'hy3',
  name: '锁喉手',
  tag: '专精',
  model: 'hy3',
  modes: [2],
  strategy: '先手锁喉',
  description: '2人局专攻回合控制：抢起始标记保先手，断供对手并严控地板罚分。',

  create(ctx) {
    return {
      chooseMove(view, moves) {
        if (!moves || moves.length === 0) return null;
        if (moves.length === 1) return moves[0];

        const me = view.seats[view.mySeat];
        const opp = view.seats[1 - view.mySeat]; // 2 人局唯一对手
        const target = opponentTargetColor(opp);

        // 我已在图案行里占坑的颜色集合（每个颜色必须至少有一条行可去，
        // 否则后续拿到该色会被迫倒地板——2 人局 5 工厂极度容易发生）
        const homed = new Set();
        for (let r = 0; r < 5; r += 1) {
          if (me.pattern[r].color !== null) homed.add(me.pattern[r].color);
        }

        let best = moves[0];
        let bestScore = -Infinity;

        for (const move of moves) {
          const pool = move.source === 'center'
            ? view.center
            : (view.factories[move.index] || []);
          const taken = countColor(pool, move.color);
          if (taken === 0) continue;

          const token = move.source === 'center' && view.centerFirst === true;
          let score = 0;

          if (move.line >= 0) {
            const cap = PATTERN_CAP[move.line];
            const pat = me.pattern[move.line];
            const room = cap - pat.count;
            const placed = Math.min(room, taken);
            const spill = taken - placed;

            if (placed > 0) {
              score += placed * PLACED_W;
              // 给「还没在图案行占坑的颜色」开一条家：避免后期该色无处可去被迫倒地板
              if (!homed.has(move.color)) score += OPEN_BONUS;
              if (placed === room) {
                // 本步将填满该行 → 上墙一块，按即时连线计分
                const col = WALL_COLOR[move.line].indexOf(move.color);
                const wp = wallPoints(me.wall, move.line, col, move.color);
                score += wp;
                score += COMPLETE_BONUS + move.line; // 长行完成更值钱
                // 终局奖励潜力（打折计入）
                let rowFilled = 0;
                for (let c = 0; c < 5; c += 1) {
                  if (c === col || me.wall[move.line][c] !== EMPTY) rowFilled += 1;
                }
                if (rowFilled === 5) score += 2 * COL_W;      // 完整行 +2
                else if (rowFilled === 4) score += 1 * COL_W;  // 差一块成行
                let colorFilled = 0;
                for (let r = 0; r < 5; r += 1) {
                  if (r === move.line || me.wall[r][col] !== EMPTY) colorFilled += 1;
                }
                if (colorFilled === 5) score += SET_W;          // 集齐整色 +10 的折让
                else if (colorFilled === 4) score += SET_W * 0.5; // 差一块集齐
              }
            }
            // 溢出到地板：位置罚分 + 每张额外平摊罚分，坚决避免
            score -= addedPenalty(me.floor.length, token, spill) + spill * SPILL_FLAT;
            // 先手控制：干净抢标记（整批正好放得下、不倒地板）才值得；绝不为了标记倒砖
            if (token && spill === 0) score += TOKEN_WORTH;
          } else {
            // 整批弃地板：纯罚分，绝不为了抢标记而倒砖
            score -= addedPenalty(me.floor.length, false, taken);
          }

          // 取砖效率（断供对手 + 自己多拿）
          score += taken * TAKEN_W;

          // 截断对手：拿走他正需要的颜色
          if (move.color === target) {
            let oppNeed = 0;
            for (let r = 0; r < 5; r += 1) {
              const pat = opp.pattern[r];
              if (pat.color === move.color && pat.count > 0 && pat.count < r + 1) {
                oppNeed += r + 1 - pat.count;
              }
            }
            score += oppNeed * DENY_WEIGHT;
          }

          if (score > bestScore) {
            bestScore = score;
            best = move;
          }
        }

        return best;
      },
    };
  },
};
