/**
 * deepseekv41flash —— 4 人局「终局收割」专精 AI
 *
 * 信条：4 人局五轮就打完，即时分人人都在拿，真正分胜负的是结算那笔 +2/+7/+10。
 * 所以这个脚本全程只干一件事：记账。每一块砖都要回答一句
 * 「这块砖让我离 +7 / +10 还差几块」。
 *
 * ── 先看几何，这决定了策略上限 ──────────────────────────────
 * 墙面 (r,c) 的颜色是 (c - r + 5) % 5，于是：
 *   · 一列的 5 格 = 五色各一块（竖线）
 *   · 一色的 5 格 = 一条斜线，恰好每行一块
 *   · 一行的 5 格 = 五色各一块（横线）
 * 关键在于「能不能连块」：一列自上而下填，横竖都接得上（1+2+3+4+5＝15 分）；
 * 一条斜线填下去几乎块块孤零零（约 5 分）。所以带连块估值的排序里，
 * 「一列」比「一色」更值钱——但 +10 只差 3 格时，斜线又反超。
 * 脚本不预设，每轮按「奖励 + 可期连块分 ÷ 还差的砖耗」重新招标。
 *
 * 预算也是真的会算穿：4 人局每人全场约 45 块砖、15~16 次上墙，
 * 而「两列 + 一色」要 13 格约 36 块砖——刚好够，再多就是自欺欺人。
 * 预算不够的目标会被主动降权，宁可少开一间账，也不留一堆半成品。
 *
 * ── 4 人局专属判断 ─────────────────────────────────────────
 * · 9 个工厂 36 块砖，砖多到用不完，最大的自伤是「取多了放不下」，
 *   溢出按地板边际罚分（-1/-1/-2/-2/-2/-3/-3）实扣，绝不心软；
 * · 断供摊到 3 个对手，收益全场最低，只留一点点权重；
 * · 轮转慢、9 个盘子轮着挑，先手被放大，中央标记值得抢；
 * · 长行（4、5 行）一开非清单颜色就堵死整行，必须收「开线税」；
 * · 清单外的一次小上墙（3 分）换不来一个 +10 格子，该放就放。
 *
 * 单文件自包含，不 import 任何其它文件。
 */

const CAP = [1, 2, 3, 4, 5];
const FLOOR = [-1, -1, -2, -2, -2, -3, -3];
const EMPTY = -1;

const BONUS_COL = 7;
const BONUS_COLOR = 10;
const BONUS_ROW = 2;

/** 4 人局一局约 5 轮：每人 14~18 次上墙、约 45 块砖。 */
const EST_PLACEMENTS = 15;
const EST_TILES = 46;
/** 不可能每一步都落在清单上，预算打八五折，才不会把账做穿。 */
const BUDGET_FACTOR = 0.85;
/** 同时最多追 3 个目标：先结清，再开新账。 */
const MAX_GOALS = 3;
/** 连块估值权重：决定「列/行」相对「色（斜线）」的排位。 */
const COMBO_W = 1.6;
/** 目标不可行的降权、超出总预算的降权。 */
const FEAS_PEN = 0.12;
const OVER_PEN = 0.55;

const W = {
  immediate: 1.0,     // 上墙即时分（含横竖连块）
  cell: 1.6,          // ★ 终局清单里的一格：全场核心权重
  chain: 0.45,        // ★ 紧贴已有砖的格子更容易连分，抬一点价
  progress: 1.0,      // 没填满时投进图案行的砖，按完成度折算
  place: 0.14,        // 砖进了行本身就有价值（离兑现更近）
  spill: 0.55,        // 每块溢出：砖白扔，还占用地板
  floor: 1.0,         // 地板边际罚分权重
  first: 1.15,        // 起始玩家标记（4 人局先手更值钱）
  openLine: 1.6,      // ★ 开线税：在长行塞清单外的颜色会堵死整行
  waste: 0.12,        // 超过 7 格被丢掉、连罚分都不计的砖
  deny: 0.035,        // 断供：4 人局摊薄，只给象征性权重
  complete: 0.25,     // 补满一条行：腾出可复用的行位
};

/** 引擎没给 wallColor 时的兜底（官方拉丁方：每行右移一格）。 */
const DEFAULT_WALL = Array.from({ length: 5 }, (_, r) =>
  Array.from({ length: 5 }, (_, c) => (c - r + 5) % 5));

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function keyOf(row, col) {
  return row * 5 + col;
}

/** 某色在某行墙面上对应的列号。 */
function colOfColor(wallColor, row, color) {
  const line = wallColor[row];
  for (let c = 0; c < 5; c += 1) if (line[c] === color) return c;
  return -1;
}

/** 与引擎 scorePlacement 完全一致：孤立 1 分，连块横、竖各计一段。 */
function wallScore(wall, row, col) {
  let h = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c -= 1) h += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c += 1) h += 1;
  let v = 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r -= 1) v += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r += 1) v += 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

/** 地板区再落 add 块砖的罚分增量（返回正数），超过 7 格的部分不计罚。 */
function floorDelta(floorLen, add) {
  let pen = 0;
  for (let i = 0; i < add; i += 1) {
    const index = floorLen + i;
    if (index < FLOOR.length) pen += Math.abs(FLOOR[index]);
    else pen += W.waste;
  }
  return pen;
}

function countFilled(wall) {
  let n = 0;
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) if (wall[r][c] !== EMPTY) n += 1;
  }
  return n;
}

function rowFilled(wall, row) {
  let n = 0;
  for (let c = 0; c < 5; c += 1) if (wall[row][c] !== EMPTY) n += 1;
  return n;
}

function colFilled(wall, col) {
  let n = 0;
  for (let r = 0; r < 5; r += 1) if (wall[r][col] !== EMPTY) n += 1;
  return n;
}

function colorFilled(wall, color) {
  let n = 0;
  for (let r = 0; r < 5; r += 1) if (wall[r].includes(color)) n += 1;
  return n;
}

/** 还剩下多少「格」和多少「砖」的配额。 */
function budgetCells(filled) {
  return Math.max(2, Math.round((EST_PLACEMENTS - filled) * BUDGET_FACTOR));
}

function budgetTiles(filled) {
  return Math.max(5, Math.round((EST_TILES - filled * 2.9) * BUDGET_FACTOR));
}

/* ------------------------------------------------------------------ *
 * 终局清单
 * ------------------------------------------------------------------ */

/** 一个目标覆盖的 5 个格子：列＝竖线，色＝斜线，行＝横线。 */
function goalCells(goal, wallColor) {
  const cells = [];
  if (goal.kind === 'col') {
    for (let r = 0; r < 5; r += 1) cells.push([r, goal.idx]);
  } else if (goal.kind === 'row') {
    for (let c = 0; c < 5; c += 1) cells.push([goal.idx, c]);
  } else {
    for (let r = 0; r < 5; r += 1) {
      const c = colOfColor(wallColor, r, goal.idx);
      if (c >= 0) cells.push([r, c]);
    }
  }
  return cells;
}

function goalKey(goal) {
  return `${goal.kind}${goal.idx}`;
}

/**
 * 一个目标还要多少砖、还差几格，以及每格已经憋了多少（图案行进度）。
 * step 是这一格剩余砖耗：行号 +1，正在憋的行按八成折扣减。
 */
function goalStats(goal, wall, pattern, wallColor) {
  const cells = goalCells(goal, wallColor);
  let open = 0;
  let cost = 0;
  const items = [];
  for (const [r, c] of cells) {
    if (wall[r][c] !== EMPTY) continue;
    const color = wallColor[r][c];
    const pat = pattern[r];
    const prog = pat && pat.count > 0 && pat.color === color ? pat.count / CAP[r] : 0;
    const step = (r + 1) * (1 - prog * 0.8);
    open += 1;
    cost += step;
    items.push({ r, c, step, weight: r + 1 });
  }
  return { open, cost, items };
}

/**
 * 这个目标如果填完，大概能顺带连出多少即时分。
 * 做法：把目标自己的格子当成「一定会填」，按「先填最连的那块」贪心走一遍，
 * 每步用真实 wallScore 记账——于是竖线（列）自然算出 15，斜线（色）只有 5 上下。
 */
function goalImmediate(goal, wall, wallColor) {
  const rest = goalCells(goal, wallColor).filter(([r, c]) => wall[r][c] === EMPTY);
  const virt = wall.map((row) => row.slice());
  let total = 0;
  while (rest.length) {
    let bi = 0;
    let bs = -1;
    for (let i = 0; i < rest.length; i += 1) {
      const s = wallScore(virt, rest[i][0], rest[i][1]);
      if (s > bs) {
        bs = s;
        bi = i;
      }
    }
    const [r, c] = rest[bi];
    virt[r][c] = wallColor[r][c];
    total += bs;
    rest.splice(bi, 1);
  }
  return total;
}

/**
 * 选清单：按「(奖励 + 连块估值) ÷ 新增砖耗」贪心，最多 MAX_GOALS 个目标。
 * 已经填过的格子免费、正憋着的格子半价，所以每轮重排会自然转向「快成了」的那条。
 */
function planGoals(view, previous) {
  const me = view.seats[view.mySeat];
  const wall = me.wall;
  const wallColor = view.wallColor || DEFAULT_WALL;
  const filled = countFilled(wall);
  const bCells = budgetCells(filled);
  const bTiles = budgetTiles(filled);
  const prevSet = new Set((previous || []).map(goalKey));

  const candidates = [];
  for (let c = 0; c < 5; c += 1) {
    if (colFilled(wall, c) < 5) candidates.push({ kind: 'col', idx: c, bonus: BONUS_COL });
  }
  for (let k = 0; k < 5; k += 1) {
    if (colorFilled(wall, k) < 5) candidates.push({ kind: 'color', idx: k, bonus: BONUS_COLOR });
  }
  // 行只做「临门一脚」：差 1~2 格才值得顺手拿 +2，绝不为 +2 去铺 5 格。
  for (let r = 0; r < 5; r += 1) {
    const rem = 5 - rowFilled(wall, r);
    if (rem > 0 && rem <= 2) candidates.push({ kind: 'row', idx: r, bonus: BONUS_ROW });
  }

  const stats = new Map();
  for (const cand of candidates) {
    const st = goalStats(cand, wall, me.pattern, wallColor);
    st.combo = goalImmediate(cand, wall, wallColor);
    stats.set(goalKey(cand), st);
  }

  const chosen = [];
  const covered = new Set();

  for (let step = 0; step < MAX_GOALS; step += 1) {
    let best = null;
    let bestRatio = -Infinity;
    let bestFresh = null;

    for (const cand of candidates) {
      if (chosen.some((g) => goalKey(g) === goalKey(cand))) continue;
      const st = stats.get(goalKey(cand));
      if (st.open === 0) continue;

      let freshCost = 0;
      let freshCells = 0;
      const fresh = [];
      for (const item of st.items) {
        if (covered.has(keyOf(item.r, item.c))) continue;
        freshCost += item.step;
        freshCells += 1;
        fresh.push(keyOf(item.r, item.c));
      }

      // 格子和砖耗都已付清的目标＝白送，直接要
      let ratio = freshCells === 0
        ? 1e6
        : (cand.bonus + COMBO_W * st.combo) / freshCost;

      if (st.open > bCells || st.cost > bTiles) ratio *= FEAS_PEN;     // 做不完
      if (covered.size + freshCells > bCells) ratio *= OVER_PEN;       // 超出配额
      if (prevSet.has(goalKey(cand))) ratio *= 1.12;                    // 上一轮已认定，轻微粘住
      if (cand.kind === 'row') ratio *= 0.9;

      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = cand;
        bestFresh = fresh;
      }
    }

    if (!best) break;
    chosen.push(best);
    for (const k of bestFresh) covered.add(k);
    if (bestRatio < 1.05 && step > 0) break;
  }

  return chosen;
}

/**
 * 给清单里的每一格定价：奖励 × 该格砖耗 ÷ 目标总剩余砖耗。
 * 差得越少、行越贵，这一格越值钱；最后一格就是满额悬赏。
 * 不可行的账打折，免得为一个永不开张的 +10 把整个中盘搭进去。
 */
function priceCells(view, goals) {
  const me = view.seats[view.mySeat];
  const wall = me.wall;
  const wallColor = view.wallColor || DEFAULT_WALL;
  const filled = countFilled(wall);
  const bCells = budgetCells(filled);
  const bTiles = budgetTiles(filled);
  const prices = new Map();

  for (const goal of goals) {
    const st = goalStats(goal, wall, me.pattern, wallColor);
    if (st.open === 0) continue;
    const feas = st.open <= bCells && st.cost <= bTiles ? 1 : 0.35;
    const unit = goal.bonus / Math.max(1, st.cost);

    for (const item of st.items) {
      let price = unit * item.weight * feas;
      // 连块：紧邻已有砖的格子会顺手多拿分
      let nb = 0;
      if (item.r > 0 && wall[item.r - 1][item.c] !== EMPTY) nb += 1;
      if (item.r < 4 && wall[item.r + 1][item.c] !== EMPTY) nb += 1;
      if (item.c > 0 && wall[item.r][item.c - 1] !== EMPTY) nb += 1;
      if (item.c < 4 && wall[item.r][item.c + 1] !== EMPTY) nb += 1;
      price += nb * W.chain;

      const k = keyOf(item.r, item.c);
      prices.set(k, (prices.get(k) || 0) + price);
    }
  }

  return prices;
}

/* ------------------------------------------------------------------ *
 * 单步估价
 * ------------------------------------------------------------------ */

function takenCount(view, move) {
  const pool = move.source === 'center' ? view.center : (view.factories[move.index] || []);
  let n = 0;
  for (const tile of pool) if (tile === move.color) n += 1;
  return n;
}

function evaluate(view, move, prices) {
  const me = view.seats[view.mySeat];
  const wall = me.wall;
  const wallColor = view.wallColor || DEFAULT_WALL;
  const taken = takenCount(view, move);
  const getsFirst = move.source === 'center' && view.centerFirst === true;

  let value = 0;
  let floorAdd = getsFirst ? 1 : 0;

  if (move.line >= 0) {
    const row = move.line;
    const cap = CAP[row];
    const pattern = me.pattern[row];
    const room = cap - pattern.count;
    const placed = Math.min(room, taken);
    const spill = taken - placed;
    const col = colOfColor(wallColor, row, move.color);
    const price = col >= 0 ? (prices.get(keyOf(row, col)) || 0) : 0;
    const completes = pattern.count + placed === cap;

    if (completes) {
      const immediate = col >= 0 ? wallScore(wall, row, col) : 1;
      value += immediate * W.immediate;
      value += price * W.cell;
      value += W.complete;
    } else {
      // 投资：还没兑现，按完成度折旧计入
      value += price * (placed / cap) * W.progress;
      value += placed * W.place;

      // 开线税：空行里塞一个清单外的颜色，这条行就被堵住，
      // 越长的行堵得越久——按「这一行原本能挣到的最高格子价」收税。
      if (pattern.count === 0 && price <= 0) {
        let rowBest = 0;
        for (let c = 0; c < 5; c += 1) {
          if (wall[row][c] !== EMPTY) continue;
          const p = prices.get(keyOf(row, c)) || 0;
          if (p > rowBest) rowBest = p;
        }
        if (rowBest > 0) value -= rowBest * (room / cap) * W.openLine;
      }
    }

    floorAdd += spill;
    value -= spill * W.spill;
  } else {
    // 整批倒地板：只有所有合法行都更糟时才会被选中
    value -= 0.9 + taken * 0.12;
    floorAdd += taken;
  }

  value -= floorDelta(me.floor.length, floorAdd) * W.floor;

  // 4 人局 9 个工厂、轮转慢，先手能先挑整盘，价值被放大。
  if (getsFirst) value += W.first;

  // 断供摊到 3 个对手，收益最低；只留一点「不留好料给别人」的直觉。
  if (move.source === 'factory' && taken >= 2) value += (taken - 2) * W.deny;

  return value;
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

const COLOR_NAME = ['蓝', '黄', '红', '黑', '白'];

export default {
  id: 'deepseekv41flash',
  name: '终局账房',
  tag: '专精',
  model: 'deepseek v4.1flash',
  modes: [4],
  strategy: '终局收割',
  description: '四人局布局流：开局锁定两列一色，每步核算离 +7/+10 还差几格，肯为终局奖励吃地板、让小上墙，末轮全力收割。',

  create(ctx) {
    const rng = typeof ctx.rng === 'function' ? ctx.rng : () => 0.5;
    const log = typeof ctx.log === 'function' ? ctx.log : () => {};

    let goals = [];
    let lastRound = 0;

    function describe(list) {
      return list.map((g) => {
        if (g.kind === 'col') return `第${g.idx + 1}列`;
        if (g.kind === 'row') return `第${g.idx + 1}行`;
        return `${COLOR_NAME[g.idx]}色`;
      }).join(' + ');
    }

    return {
      chooseMove(view, moves) {
        try {
          if (!Array.isArray(moves) || moves.length === 0) return null;

          if (view.round !== lastRound || goals.length === 0) {
            lastRound = view.round;
            goals = planGoals(view, goals);

            if (goals.length) {
              const wall = view.seats[view.mySeat].wall;
              const wallColor = view.wallColor || DEFAULT_WALL;
              const open = new Set();
              for (const goal of goals) {
                for (const [r, c] of goalCells(goal, wallColor)) {
                  if (wall[r][c] === EMPTY) open.add(keyOf(r, c));
                }
              }
              log(`第 ${view.round} 轮｜终局清单：${describe(goals)}｜还差 ${open.size} 格`);
            }
          }

          const prices = priceCells(view, goals);

          let best = moves[0];
          let bestValue = -Infinity;
          for (const move of moves) {
            const value = evaluate(view, move, prices) + rng() * 1e-4;
            if (value > bestValue) {
              bestValue = value;
              best = move;
            }
          }
          return best || moves[0];
        } catch (_error) {
          return moves[0];
        }
      },
    };
  },
};
