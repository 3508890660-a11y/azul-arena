/**
 * minimaxm31flash —— 《花砖物语》(Azul) 3 人局「地板压制」专精 AI。
 *
 * ─────────────────────────────────────────────────────────────────
 * 3 人局为什么是「地板」的战场
 * ─────────────────────────────────────────────────────────────────
 * 100 块砖 5 色各 20，7 个工厂每轮 28 块，三人分。人均每轮取 9~10 块，
 * 而图案行总容量只有 1+2+3+4+5 = 15 块，并且：
 *   - 一条行只能放一种颜色；
 *   - 该色不能已经出现在这一行对应的墙面上（不能回头）。
 * 于是「这批砖放不进任何一条行」在 3 人局里是家常便饭。实测一局均值：
 * 上墙约 51 分、地板罚分约 14 分、终局奖励约 6 分——地板那一块占了总分
 * 的三分之一，是三个可控项里最大的一个。
 *
 * 所以 3 人局的胜负手是：
 *     「我把自己的地板守住，同时把对手逼上地板。」
 *
 * ─────────────────────────────────────────────────────────────────
 * 核心打法：地板压制（Floor Suppression）
 * ─────────────────────────────────────────────────────────────────
 * 1. 抽配套色（断供）：对手图案行囤到 N 块、只差 1~2 块就补齐时，把桌面
 *    上这种颜色整个拿走。他那条行永远补不齐 → 攒的砖全部作废；而且那条
 *    行被占死，将来别的颜色也塞不进去，只能往地板上倒。
 *    断供不平均用力：只断更危险的那一家（分数领先、墙面快补满整行的），
 *    两人同时缺同一种颜色时收益被摊薄，价值打折。
 *
 * 2. 逼溢出（压迫）：从工厂取走一种颜色后，该工厂剩下的砖全部滑进中央。
 *    对手日后从中央一次抓到的批量就越大，超出图案行容量的部分直接倒地
 *    板。反过来，若中央剩下的全是对手放不下的颜色，他就只能看着地板越
 *    吃越深。中央区是 3 人局的主要压迫战场。
 *
 * 3. 自己地板必须干净：压制别人却自己吃 -3 是净亏。所以宁可从工厂小批
 *    量取，也不从中央一次抓一大把；地板越深越不碰中央区。
 *
 * ─────────────────────────────────────────────────────────────────
 * 怎么把「对手被迫溢出的砖数」算成我的收益
 * ─────────────────────────────────────────────────────────────────
 * 这一笔不靠估，靠算：每一轮决策后，把这一轮剩下的砖按一套稳定的贪心
 * 策略打完（推演），直接读出对手在轮末地板上有几块砖、因此被扣掉多少分。
 * 对手的这块失分就是我的收益——同一笔账的两面，直接进同一个式子：
 *
 *     我的净收入 = 我的上墙分 − 我的地板罚分
 *     对手的净收入 = 他的上墙分 − 他的地板罚分   ← 他被迫溢出的砖就落在这里
 *
 * 推演用的是与决策同一套评估逻辑，所以它量到的是「真会发生的溢出」，
 * 而不是「估计他会溢出多少」。危险度加权让压制只落在更危险的那一家头上。
 *
 * ─────────────────────────────────────────────────────────────────
 * 砌墙也不能输：选行 = 选列
 * ─────────────────────────────────────────────────────────────────
 * 上墙得分全靠横竖相邻（h+v），砖摆得散就只值 1 分，摆成团才值钱。
 * 而颜色 c 放进第 r 条图案行，最终落到墙面第 (c+r)%5 列——所以
 * 「放哪条行」就是在选墙面上的哪一列。脚本每轮挑 2 条最有希望的列 +
 * 2 行死追，把每块砖都往能连成串的位置走。
 *
 * 纯 ESM、单文件自包含（不 import 任何其它文件）、不用 Math.random。
 */

/* ------------------------------------------------------------------ *
 * 规则常量（与引擎一致，本地重定义）
 * ------------------------------------------------------------------ */
const COLORS = 5;
const EMPTY = -1;
const PATTERN_CAP = [1, 2, 3, 4, 5];
const FLOOR_PENALTY = [-1, -1, -2, -2, -2, -3, -3];
const FLOOR_SIZE = FLOOR_PENALTY.length;
const WALL_COLOR = [
  [0, 1, 2, 3, 4],
  [4, 0, 1, 2, 3],
  [3, 4, 0, 1, 2],
  [2, 3, 4, 0, 1],
  [1, 2, 3, 4, 0],
];
const BONUS_ROW = 2;
const BONUS_COL = 7;
const BONUS_COLOR = 10;

/* ------------------------------------------------------------------ *
 * 权重（单位统一为「最终得分分」）
 * ------------------------------------------------------------------ */
const W_WALL = 1.0;        // 上墙得分
const W_EV = 1.0;          // 未补满图案行的存量进度：期望上墙价值
const W_COMMIT = 1.7;      // 往已开好的同色行续砖（补齐概率更高）
const W_FRESH = 0.75;      // 往空行开新坑（补齐概率更低）
const W_LINE_BONUS = 1.0;  // 补满一条图案行（该行腾空重来）
const W_END = 0.9;         // 终局奖励（整行 +2 / 整列 +7 / 整色 +10）折现
const W_END_GROW = 1.0;    // 终局奖励随局面推进的加成
const W_FLOOR = 1.2;       // 自己地板罚分——宁可少拿也不踩 -3
const W_SPILL = 0.12;      // 每块溢出的额外浪费（砖白拿了，位置也废了）
const W_TOKEN = 4.0;       // 起始玩家标记（下一轮先挑工厂）
const W_TOKEN_DEEP = 0.2;  // 地板已深时抢标记的折损系数
const W_DENY = 0.5;        // 断供：让对手补不齐一条图案行
const W_DENY_NEAR = 1.0;   // 对手只差 1 块就补齐时的额外断供价值
const W_DENY_WIN = 4.0;    // 掐掉对手即将补满整行（＝对手即将终局）
const W_DENY_SHARE = 0.4;  // 两名对手抢同一种颜色时的摊薄折扣
const W_EXPOSE = 0.15;     // 把对手正缺的颜色留在中央的代价
const W_PLAN_COL = 1.2;    // 往目标列走（整列 +7 的折现）
const W_PLAN_ROW = 0.4;    // 往目标行走（整行 +2 的折现）
const W_END_LEAD = 10.0;   // 补满整行提前终局：我领先就该收手
const W_END_LAG = 5.0;     // 我落后时不该替别人收摊
const W_THREAT_LEAD = 0.55; // 对手分数领先越多，断供价值越高
const W_THREAT_WALL = 1.0;  // 对手墙面越接近补满，断供价值越高
const W_SIM_FLOOR = 1.2;   // 推演里我自己的地板罚分
const W_SIM_RIVAL = 0.1;   // 推演里对手的上墙得分（他上墙就等于我落后）
const W_SIM_PRESS = 1.5;   // 推演里对手的地板罚分（＝他的损失＝我的收益）
const W_SIM_AVOID = 0.7;   // 推演里对手躲避地板的力度（越大，量到的越是「被迫」溢出）

const LAMBDA = 1.0;        // 启发式在最终排序里的权重
const TOP_K = 8;           // 进入整轮推演的候选数
const TIME_BUDGET_MS = 30; // 单步时间预算，超时退化成纯启发式

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 地板里 n 块砖的罚分绝对值（只与数量有关，与是否含起始标记无关）。 */
function floorPenalty(count) {
  let pen = 0;
  const n = Math.min(count, FLOOR_SIZE);
  for (let i = 0; i < n; i += 1) pen += Math.abs(FLOOR_PENALTY[i]);
  return pen;
}

/**
 * 引擎同款上墙计分：横向 h + 纵向 v。
 * 传进来的 wall 里 (row,col) 仍是空的，按「这一格马上填上」来算。
 */
function wallPoints(wall, row, col) {
  let h = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c -= 1) h += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c += 1) h += 1;
  let v = 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r -= 1) v += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r += 1) v += 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

/** 颜色 color 落在第 row 行墙面的哪一列。 */
function wallColOf(row, color) {
  return WALL_COLOR[row].indexOf(color);
}

/** 这一格补上之后，整行是否就满了（补满＝提前终局）。 */
function rowFullAfter(wall, row, col) {
  for (let c = 0; c < 5; c += 1) {
    if (c === col) continue;
    if (wall[row][c] === EMPTY) return false;
  }
  return true;
}

/** 这一格补上之后，整列是否就满了（终局 +7）。 */
function colFullAfter(wall, row, col) {
  for (let r = 0; r < 5; r += 1) {
    if (r === row) continue; // 这一格马上要填上了
    if (wall[r][col] === EMPTY) return false;
  }
  return true;
}

/** 这一格补上之后，这一色是否集齐（终局 +10）。 */
function colorFullAfter(wall, row, color) {
  for (let r = 0; r < 5; r += 1) {
    if (r === row) continue; // 这一行马上就有这个颜色了
    let hit = false;
    for (let c = 0; c < 5; c += 1) {
      if (wall[r][c] === color) { hit = true; break; }
    }
    if (!hit) return false;
  }
  return true;
}

/** 补上这一格带来的终局奖励增量。 */
function endBonusDelta(wall, row, col, color) {
  let bonus = 0;
  if (rowFullAfter(wall, row, col)) bonus += BONUS_ROW;
  if (colFullAfter(wall, row, col)) bonus += BONUS_COL;
  if (colorFullAfter(wall, row, color)) bonus += BONUS_COLOR;
  return bonus;
}

function countByColor(tiles) {
  const counts = new Array(COLORS).fill(0);
  for (const tile of tiles) {
    if (tile >= 0 && tile < COLORS) counts[tile] += 1;
  }
  return counts;
}

function clamp(value, low, high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/* ------------------------------------------------------------------ *
 * 座位分析
 * ------------------------------------------------------------------ */

/**
 * need[color]    补齐最紧迫那条该色行还差几块
 * urgent[color]  最紧迫那条行已经囤了多少块
 * rowNeed[color] 墙面某行只差这一色就满（＝他即将补满整行）
 */
function analyzeSeat(seat) {
  const need = new Array(COLORS).fill(0);
  const urgent = new Array(COLORS).fill(0);
  const rowNeed = new Array(COLORS).fill(0);

  for (let r = 0; r < 5; r += 1) {
    const pat = seat.pattern[r];
    const cap = PATTERN_CAP[r];
    for (let color = 0; color < COLORS; color += 1) {
      if (seat.wall[r].includes(color)) continue; // 该行墙面已有此色，不能回头
      if (pat.count >= cap) continue;
      if (pat.count > 0 && pat.color !== color) continue;
      if (pat.count > 0 && pat.color === color) {
        const space = cap - pat.count;
        if (space > need[color]) need[color] = space;
        if (pat.count > urgent[color]) urgent[color] = pat.count;
      }
    }
  }

  for (let r = 0; r < 5; r += 1) {
    let filled = 0;
    let emptyCol = -1;
    for (let c = 0; c < 5; c += 1) {
      if (seat.wall[r][c] === EMPTY) emptyCol = c;
      else filled += 1;
    }
    if (filled === 4 && emptyCol >= 0) rowNeed[WALL_COLOR[r][emptyCol]] += 1;
  }

  let filled = 0;
  let rowFill = 0;
  for (let r = 0; r < 5; r += 1) {
    let rowCount = 0;
    for (let c = 0; c < 5; c += 1) if (seat.wall[r][c] !== EMPTY) rowCount += 1;
    filled += rowCount;
    if (rowCount > rowFill) rowFill = rowCount;
  }

  return { need, urgent, rowNeed, filled, rowFill, score: seat.score };
}

/** 危险度：断供要挑人下手。 */
function threatWeight(info, myScore) {
  const theirScore = Number.isFinite(info.score) ? info.score : 0;
  let w = 1 + clamp((theirScore - myScore) / 30, -0.3, 1) * W_THREAT_LEAD;
  w *= 1 + (info.rowFill / 5) * W_THREAT_WALL;
  return w;
}

/* ------------------------------------------------------------------ *
 * 长期布局：目标列 / 目标行
 *
 * 整列 +7 是终局奖励里最值钱的一项。颜色 c 放进第 r 条图案行，最终落到
 * 墙面第 (c+r)%5 列——所以「放哪条行」就是在选列。挑 2 条最有希望的列
 * + 2 行死追，就能同时吃到整列 +7 与整行 +2。
 * ------------------------------------------------------------------ */

function planTargets(seat) {
  const cols = [];
  for (let k = 0; k < 5; k += 1) {
    let progress = 0;
    let cost = 0;
    let reachable = 0;
    for (let r = 0; r < 5; r += 1) {
      if (seat.wall[r][k] !== EMPTY) { progress += 1; continue; }
      // WALL_COLOR[r][k] = (k - r + 5) % 5，即这一格该填的颜色
      const color = (k - r + 5) % 5;
      const pat = seat.pattern[r];
      const cap = PATTERN_CAP[r];
      if (pat.count === 0) { cost += cap; reachable += 1; }
      else if (pat.color === color) { cost += cap - pat.count; reachable += 1; }
      else { cost += 3; reachable -= 1; } // 这行已被别的颜色占死
    }
    if (reachable <= 0) continue;
    cols.push({ col: k, progress, cost, value: progress * BONUS_COL - cost * 0.5 });
  }
  cols.sort((a, b) => b.value - a.value);
  const targetCols = new Set(cols.slice(0, 2).map((entry) => entry.col));

  const rows = [];
  for (let r = 0; r < 5; r += 1) {
    let count = 0;
    for (let c = 0; c < 5; c += 1) if (seat.wall[r][c] !== EMPTY) count += 1;
    rows.push({ row: r, count });
  }
  rows.sort((a, b) => b.count - a.count);
  const targetRows = new Set(rows.slice(0, 2).map((entry) => entry.row));

  return { targetCols, targetRows };
}

/* ------------------------------------------------------------------ *
 * 局面表示
 * ------------------------------------------------------------------ */

function viewToBoard(view) {
  return {
    n: view.seats.length,
    turn: view.mySeat,
    factories: view.factories.map((factory) => factory.slice()),
    center: view.center.slice(),
    centerFirst: view.centerFirst === true,
    filled: view.seats[view.mySeat].wall.flat().filter((cell) => cell !== EMPTY).length,
    round: view.round,
    bag: (view.bagColors || new Array(COLORS).fill(0)).slice(),
    seats: view.seats.map((seat) => ({
      pattern: seat.pattern.map((pat) => ({ color: pat.color, count: pat.count })),
      wall: seat.wall.map((row) => row.slice()),
      floorLen: seat.floor.length,
      score: seat.score,
    })),
  };
}

function cloneBoard(board) {
  return {
    n: board.n,
    turn: board.turn,
    factories: board.factories.map((factory) => factory.slice()),
    center: board.center.slice(),
    centerFirst: board.centerFirst,
    filled: board.filled,
    round: board.round,
    bag: board.bag.slice(),
    seats: board.seats.map((seat) => ({
      pattern: seat.pattern.map((pat) => ({ color: pat.color, count: pat.count })),
      wall: seat.wall.map((row) => row.slice()),
      floorLen: seat.floorLen,
      score: seat.score,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 局面上下文
 * ------------------------------------------------------------------ */

function analyzeBoard(board) {
  const pool = new Array(COLORS).fill(0);
  const factoryCounts = board.factories.map((factory) => countByColor(factory));
  factoryCounts.forEach((counts) => {
    for (let c = 0; c < COLORS; c += 1) pool[c] += counts[c];
  });
  const centerCounts = countByColor(board.center);
  for (let c = 0; c < COLORS; c += 1) pool[c] += centerCounts[c];

  let total = 0;
  for (let c = 0; c < COLORS; c += 1) total += pool[c];

  const seats = board.seats.map((seat) => {
    const info = analyzeSeat(seat);
    info.score = seat.score;
    info.plan = planTargets(seat);
    return info;
  });

  // 每种颜色有几个对手同时缺（缺的人越多，这一色被断供的价值越被摊薄）
  const demandCount = new Array(COLORS).fill(0);
  for (const info of seats) {
    for (let c = 0; c < COLORS; c += 1) if (info.need[c] > 0) demandCount[c] += 1;
  }

  return { pool, factoryCounts, centerCounts, seats, demandCount, total, bag: board.bag };
}

function batchSize(ctx, move) {
  if (move.source === 'center') return ctx.centerCounts[move.color] || 0;
  const counts = ctx.factoryCounts[move.index];
  return counts ? (counts[move.color] || 0) : 0;
}

/* ------------------------------------------------------------------ *
 * 第一层：启发式
 *
 * 座位 seat 采取行动 move 的即时价值。全部以「最终得分分」为单位：
 * 地板一格 -1 分就是 -1 分；对手地板上多一块砖，就等于我多赚一分。
 * ------------------------------------------------------------------ */

function evaluate(board, ctx, seat, move) {
  const me = board.seats[seat];
  const myInfo = ctx.seats[seat];
  const k = batchSize(ctx, move);
  if (k <= 0) return -Infinity;

  const token = move.source === 'center' && board.centerFirst;
  let spill = k;
  let value = 0;

  if (move.line >= 0) {
    const cap = PATTERN_CAP[move.line];
    const pat = me.pattern[move.line];
    const room = cap - pat.count;
    const placed = Math.min(room, k);
    spill = k - placed;
    const col = wallColOf(move.line, move.color);
    let points = 1;
    if (col >= 0) points = wallPoints(me.wall, move.line, col);
    const endWeight = 1 + Math.min(1.25, Math.max(0, board.filled - 6) / 12
      + (board.round - 1) * 0.035) * W_END_GROW;

    if (placed === room) {
      // 补满这条行 → 一块砖上墙，得分按它将来的横竖相邻算
      value += points * W_WALL;
      value += W_LINE_BONUS;
      if (col >= 0) {
        value += endBonusDelta(me.wall, move.line, col, move.color) * W_END * endWeight;
        if (rowFullAfter(me.wall, move.line, col)) {
          // 补满整行＝立刻终局。我领先就该收手，我不领先就别替人收摊。
          let leader = -Infinity;
          for (let i = 0; i < board.n; i += 1) {
            if (i === seat) continue;
            if (board.seats[i].score > leader) leader = board.seats[i].score;
          }
          const projected = me.score + points - floorPenalty(me.floorLen + spill);
          value += projected >= leader ? W_END_LEAD : -W_END_LAG;
        }
        if (myInfo.plan.targetCols.has(col)) value += W_PLAN_COL;
        if (myInfo.plan.targetRows.has(move.line)) value += W_PLAN_ROW;
      }
    } else {
      // 存量进度：这一行攒满只上墙 1 块，行越短效率越高（摊到每块砖上）。
      // 已经开了头的同色行补齐概率更高，空行开新坑则更可能半途而废。
      const commit = pat.count > 0 ? W_COMMIT : W_FRESH;
      const perTile = (W_EV * (points + W_LINE_BONUS) / cap) * commit;
      value += placed * perTile;
      if (col >= 0 && myInfo.plan.targetCols.has(col)) value += placed * W_PLAN_COL * 0.4;
    }
  }

  // 自己地板：精确按格子算罚分（含起始标记占位），越深越疼
  value -= (floorPenalty(me.floorLen + (token ? 1 : 0) + spill) - floorPenalty(me.floorLen)) * W_FLOOR;
  value -= spill * W_SPILL;
  if (token) value += W_TOKEN * (me.floorLen >= 4 ? W_TOKEN_DEEP : 1);

  // ── 断供：抽走对手正缺的那种颜色 ──
  // 断供只有在「这种颜色真的拿不到了」时才值钱：袋（bag）里还留着这色，
  // 下一轮他就补回来了，我只是拖他一轮；袋里也见底了，才是真断死。
  // 这也是「他们唯一还能放下的那种颜色」——他唯一缺、且再也补不上的那种。
  const after = Math.max(0, ctx.pool[move.color] - k);
  for (let i = 0; i < board.n; i += 1) {
    if (i === seat) continue;
    const opp = ctx.seats[i];
    const need = opp.need[move.color];
    if (need <= 0 || after >= need) continue;
    // 断供能维持多久：袋里这块色越多，价值越低（下一轮他就回来了）
    const bagLeft = ctx.bag[move.color] || 0;
    const supply = bagLeft + after + 1;
    const lasting = clamp(1 - bagLeft / supply, 0.15, 1);
    let deny = W_DENY * (1 + opp.urgent[move.color] * 0.4) * lasting;
    if (need === 1) deny += W_DENY_NEAR * lasting; // 只差一块：断掉这一块他就上不了墙
    if (opp.rowNeed[move.color] > 0) deny += W_DENY_WIN * lasting; // 掐掉他即将补满的整行
    if (ctx.demandCount[move.color] > 1) deny *= W_DENY_SHARE; // 摊给两个对手
    value += deny * threatWeight(opp, me.score);
  }

  // ── 暴露：把对手正缺的颜色留在中央，等于把手伸给他 ──
  // 从工厂取走一种颜色后，该工厂剩下的砖全部滑进中央。若剩下的砖里正好
  // 有对手正缺的颜色，就等于替他把手伸好，等他把砖补齐。
  if (move.source === 'factory') {
    const leftovers = countByColor(board.factories[move.index]);
    leftovers[move.color] = 0;
    for (let i = 0; i < board.n; i += 1) {
      if (i === seat) continue;
      const opp = ctx.seats[i];
      for (let c = 0; c < COLORS; c += 1) {
        if (leftovers[c] > 0 && opp.need[c] > 0) {
          value -= W_EXPOSE * leftovers[c] * threatWeight(opp, me.score);
        }
      }
    }
  }

  return value;
}

/* ------------------------------------------------------------------ *
 * 合法行动与落子（与引擎规则逐条对齐）
 * ------------------------------------------------------------------ */

function canPlaceInLine(seat, line, color) {
  const pat = seat.pattern[line];
  if (pat.count >= PATTERN_CAP[line]) return false;
  if (pat.count > 0 && pat.color !== color) return false;
  if (seat.wall[line].includes(color)) return false;
  return true;
}

function legalMoves(board, seat) {
  const moves = [];
  const player = board.seats[seat];

  const addSource = (source, index, tiles) => {
    if (!tiles.length) return;
    const counts = countByColor(tiles);
    for (let color = 0; color < COLORS; color += 1) {
      if (!counts[color]) continue;
      for (let line = 0; line < 5; line += 1) {
        if (canPlaceInLine(player, line, color)) {
          moves.push({ source, index, color, line, k: counts[color] });
        }
      }
      moves.push({ source, index, color, line: -1, k: counts[color] });
    }
  };

  for (let i = 0; i < board.factories.length; i += 1) addSource('factory', i, board.factories[i]);
  addSource('center', -1, board.center);
  return moves;
}

function applyMove(board, move) {
  const player = board.seats[board.turn];
  const k = move.k;

  if (move.source === 'factory') {
    const rest = [];
    for (const tile of board.factories[move.index]) {
      if (tile !== move.color) rest.push(tile);
    }
    board.factories[move.index] = [];
    for (const tile of rest) board.center.push(tile);
  } else {
    const kept = [];
    for (const tile of board.center) {
      if (tile !== move.color) kept.push(tile);
    }
    board.center = kept;
    if (board.centerFirst) {
      board.centerFirst = false;
      player.floorLen = Math.min(FLOOR_SIZE, player.floorLen + 1); // 起始标记占一格
    }
  }

  if (move.line >= 0) {
    const pat = player.pattern[move.line];
    const room = PATTERN_CAP[move.line] - pat.count;
    const placed = Math.min(room, k);
    pat.color = move.color;
    pat.count += placed;
    player.floorLen = Math.min(FLOOR_SIZE, player.floorLen + (k - placed));
  } else {
    player.floorLen = Math.min(FLOOR_SIZE, player.floorLen + k);
  }

  board.turn = (board.turn + 1) % board.n;
}

function roundOver(board) {
  if (board.center.length) return false;
  for (const factory of board.factories) if (factory.length) return false;
  return true;
}

/** 轮末结算：上墙计分 → 地板罚分 →（补满整行则）终局奖励。 */
function resolveRound(board) {
  let over = false;
  const wallGain = new Array(board.n).fill(0);
  const floorLoss = new Array(board.n).fill(0);

  for (let i = 0; i < board.n; i += 1) {
    const player = board.seats[i];
    for (let r = 0; r < 5; r += 1) {
      const pat = player.pattern[r];
      if (pat.count < PATTERN_CAP[r]) continue;
      const col = wallColOf(r, pat.color);
      if (col < 0 || player.wall[r][col] !== EMPTY) continue;
      player.wall[r][col] = pat.color;
      const points = wallPoints(player.wall, r, col);
      player.score += points;
      wallGain[i] += points;
      pat.color = null;
      pat.count = 0;
    }
    const pen = floorPenalty(player.floorLen);
    player.score = Math.max(0, player.score - pen);
    floorLoss[i] += pen;
    player.floorLen = 0;
    for (let r = 0; r < 5; r += 1) {
      let full = true;
      for (let c = 0; c < 5; c += 1) {
        if (player.wall[r][c] === EMPTY) { full = false; break; }
      }
      if (full) { over = true; break; }
    }
  }

  if (over) {
    for (let i = 0; i < board.n; i += 1) {
      const wall = board.seats[i].wall;
      let rows = 0;
      let cols = 0;
      let colors = 0;
      for (let r = 0; r < 5; r += 1) {
        let full = true;
        for (let c = 0; c < 5; c += 1) {
          if (wall[r][c] === EMPTY) { full = false; break; }
        }
        if (full) rows += 1;
      }
      for (let c = 0; c < 5; c += 1) {
        let full = true;
        for (let r = 0; r < 5; r += 1) {
          if (wall[r][c] === EMPTY) { full = false; break; }
        }
        if (full) cols += 1;
      }
      for (let c = 0; c < COLORS; c += 1) {
        let full = true;
        for (let r = 0; r < 5; r += 1) {
          if (!wall[r].includes(c)) { full = false; break; }
        }
        if (full) colors += 1;
      }
      const bonus = rows * BONUS_ROW + cols * BONUS_COL + colors * BONUS_COLOR;
      board.seats[i].score += bonus;
      wallGain[i] += bonus;
    }
  }

  return { over, wallGain, floorLoss };
}

/* ------------------------------------------------------------------ *
 * 第二层：本轮整局推演
 *
 * 把这一轮剩下的砖按一套稳定的贪心策略打完，然后直接读出：
 *   - 对手轮末地板上有几块砖（＝他的分数惩罚＝我的收益）
 *   - 我自己轮末地板上有几块砖（＝我的分数惩罚）
 * 这一层是「地板压制」真正的落点：对手被迫溢出的砖数直接按收益计入，
 * 而不是靠系数去估。
 * ------------------------------------------------------------------ */

/**
 * 推演里的贪心策略：对手会拼命躲开地板——只有真的没处可去时才倒。
 * 这样推演量到的溢出才是「被迫」的，而不是对手自己犯蠢倒的。
 */
function simPolicyScore(sim, seat, move) {
  const player = sim.seats[seat];
  const token = move.source === 'center' && sim.centerFirst;
  let value = 0;
  let spill = move.k;

  if (move.line >= 0) {
    const pat = player.pattern[move.line];
    const room = PATTERN_CAP[move.line] - pat.count;
    const placed = Math.min(room, move.k);
    spill = move.k - placed;
    const col = wallColOf(move.line, move.color);
    let points = 1;
    if (col >= 0) points = wallPoints(player.wall, move.line, col);
    if (pat.count + placed === PATTERN_CAP[move.line]) {
      value += points * W_WALL + W_LINE_BONUS;
      if (col >= 0) value += endBonusDelta(player.wall, move.line, col, move.color) * W_END;
    } else {
      const commit = pat.count > 0 ? W_COMMIT : W_FRESH;
      value += placed * (W_EV * (points + W_LINE_BONUS) / PATTERN_CAP[move.line]) * commit;
    }
  }

  value -= (floorPenalty(player.floorLen + (token ? 1 : 0) + spill) - floorPenalty(player.floorLen)) * W_SIM_AVOID;
  value -= spill * W_SPILL;
  if (token) value += W_TOKEN;
  return value;
}

function rollout(board, firstMove, mySeat) {
  const sim = cloneBoard(board);
  applyMove(sim, firstMove);

  let guard = 0;
  while (!roundOver(sim) && guard < 80) {
    guard += 1;
    const seat = sim.turn;
    const moves = legalMoves(sim, seat);
    if (!moves.length) break;
    let best = moves[0];
    let bestScore = -Infinity;
    for (const move of moves) {
      const value = simPolicyScore(sim, seat, move);
      if (value > bestScore) {
        bestScore = value;
        best = move;
      }
    }
    applyMove(sim, best);
  }

  const result = resolveRound(sim);
  // 这一轮我的净收入 = 我的上墙分 − 我的地板罚分。
  //
  // 对手那边同样算净收入：他的上墙分是他的收益，他的地板罚分是他的损失。
  // 其中「被迫溢出」的那部分（无处可去、只能倒地板的那些）才是我逼出来
  // 的——它以地板罚分的形式扣在他头上，也就是我的收益。
  // 危险度加权：只对更危险的那家算得更足。
  let value = result.wallGain[mySeat] - result.floorLoss[mySeat] * W_SIM_FLOOR;
  for (let i = 0; i < sim.n; i += 1) {
    if (i === mySeat) continue;
    const opp = analyzeSeat(sim.seats[i]);
    const weight = threatWeight(opp, sim.seats[mySeat].score);
    // 对手这一轮的地板罚分＝他被迫溢出（无处可去、只能倒地板）的砖的价钱。
    // 这是他的损失，也就是我的收益——「地板压制」要算的那笔账就在这里。
    const oppLoss = result.floorLoss[i] * W_SIM_PRESS;
    const oppNet = result.wallGain[i] - oppLoss;
    value -= weight * oppNet * W_SIM_RIVAL;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * 决策
 * ------------------------------------------------------------------ */

function decide(view, moves) {
  const started = Date.now();
  const board = viewToBoard(view);
  const ctx = analyzeBoard(board);
  const mySeat = view.mySeat;

  const scored = [];
  for (const move of moves) {
    scored.push({ move, h: evaluate(board, ctx, mySeat, move) });
  }
  scored.sort((a, b) => b.h - a.h);

  const top = scored.slice(0, TOP_K);
  let bestMove = top[0].move;
  let bestValue = -Infinity;

  for (const candidate of top) {
    const first = {
      source: candidate.move.source,
      index: candidate.move.index,
      color: candidate.move.color,
      line: candidate.move.line,
      k: batchSize(ctx, candidate.move),
    };
    const value = rollout(board, first, mySeat) * LAMBDA + candidate.h;
    if (value > bestValue) {
      bestValue = value;
      bestMove = candidate.move;
    }
    if (Date.now() - started > TIME_BUDGET_MS) break;
  }

  return bestMove;
}

export default {
  id: 'minimaxm31flash',
  name: '地板铁砧',
  tag: '专精',
  model: 'MiniMax M3.1flash',
  modes: [3],
  strategy: '地板压制',
  description:
    '3 人局专攻地板压制：抽走对手图案行的配套色断其补齐，把无家可归的砖逼他吃下，自己死守地板不踩 -3，锁列追终局奖励。',

  create(ctx) {
    let reported = false;
    return {
      chooseMove(view, moves) {
        const legal = Array.isArray(moves) && moves.length ? moves : view.moves;
        if (!legal || legal.length === 0) return null;
        if (legal.length === 1) return legal[0];
        try {
          const answer = decide(view, legal);
          if (answer) return answer;
        } catch (error) {
          if (!reported) {
            reported = true;
            ctx.log(`推演异常，改用启发式：${error.message}`);
          }
        }
        return legal[0];
      },
    };
  },
};
