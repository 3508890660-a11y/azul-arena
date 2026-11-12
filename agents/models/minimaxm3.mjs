/**
 * minimaxm3 —— 3 人局「中线平衡」专精脚本（MiniMax M3）。
 * 3 人局最尴尬：断供摊给两个对手、all-in 布局来不及、终局奖励又不能压过即时分。
 * 三条具名权重的线按分差动态调权：A 即时得分 W_IMMEDIATE（连线即时分 + 图案行效率）、
 * B 终局布局 W_LAYOUT（整行+2 / 整列+7 / 集齐整色+10 的折让，硬压在即时分之下）、
 * C 断供对手 W_DENY（按最危险的那个对手计价，再乘 3 人摊薄系数）；
 * 另有防守线 W_DEFENSE / W_FLOOR：地板罚分 + 别给对手喂颜色。
 */

// —— 规则常量（本地重定义，不 import 任何文件）——
const WALL_COLOR = [
  [0, 1, 2, 3, 4], [4, 0, 1, 2, 3], [3, 4, 0, 1, 2], [2, 3, 4, 0, 1], [1, 2, 3, 4, 0],
];
const PATTERN_CAP = [1, 2, 3, 4, 5];
const FLOOR_PENALTY = [-1, -1, -2, -2, -2, -3, -3];
const FLOOR_SIZE = 7;
const EMPTY = -1;
const ROW = 0, COL = 1, COLOR = 2;
// —— 三条主线 + 防守线的具名权重 ——
const W_IMMEDIATE = 3.2;   // A 即时得分线
const W_LAYOUT = 1.5;      // B 终局布局线
const W_DENY = 2.4;        // C 断供对手线
const W_DEFENSE = 1.6;     // 防守：把砖喂给对手的惩罚
const W_FLOOR = 1.3;       // 地板罚分
// —— 动态调权参数 ——
const TUNE = { immediate: 0.45, layout: 0.30, deny: 0.55, defense: 0.45, floor: 0.6 };
const GAP_SCALE = 15;         // 分差多大算「完全落后 / 完全领先」
const LAYOUT_CAP_RATIO = 0.8; // 布局线权重上限 = 即时分 × 本系数
const LATE_ROUND_SPAN = 7;    // 第几轮算进入后期
// —— 即时得分线子权重 ——
const IMM_PROGRESS = 1.0;   // 图案行推进度（placed / cap）
const IMM_WALL = 1.6;       // 上墙连线的即时分
const IMM_COMPLETE = 1.2;   // 填满一行的额外奖励
// —— 终局布局线子权重（终局奖励打折计入）——
const LAY_ROW_FULL = 1.0, LAY_ROW_NEAR = 0.4;   // 补满整行(+2) / 差一块成行
const LAY_COL_FULL = 2.8, LAY_COL_NEAR = 0.7;   // 补满整列(+7) / 差一块成列
const LAY_SET_FULL = 4.0, LAY_SET_NEAR = 1.0;   // 集齐整色(+10) / 差一块集齐
const LAY_ROW_PULL = 0.6, LAY_COL_PULL = 1.0, LAY_SET_PULL = 1.4; // 未满行的走向潜力
// —— 断供线子权重 ——
const DENY_DILUTION = 0.6;   // 3 人局摊薄：断供收益要分给两个对手
const DENY_SET_NEAR = 5.0;   // 对手再拿一块就集齐整色
const DENY_PAT = 1.0;        // 对手图案行的缺口
const THREAT_ROW_NEAR = 2.2; // 对手再补一块就补满整行（直接终局）
const THREAT_SCORE = 0.04;   // 对手分数逼近带来的威胁
// —— 其它 ——
const TOKEN_VALUE = 2.8, TOKEN_FACTOR = 0.4; // 抢到起始玩家标记
const FEED_W = 0.35;        // 每块「被推进中央区喂给对手」的砖
const DISPOSAL_W = 1.2;     // 整批倒进地板区的额外浪费

function countColor(pool, color) {
  let n = 0;
  for (let i = 0; i < pool.length; i += 1) if (pool[i] === color) n += 1;
  return n;
}
/** 与引擎 scorePlacement 同算法：这块砖上墙能立刻拿几分。 */
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

/** 某行 / 某列 / 某色已上墙的块数。 */
function filled(wall, kind, key) {
  let n = 0;
  if (kind === ROW) for (let c = 0; c < 5; c += 1) if (wall[key][c] !== EMPTY) n += 1;
  else if (kind === COL) for (let r = 0; r < 5; r += 1) if (wall[r][key] !== EMPTY) n += 1;
  else for (let r = 0; r < 5; r += 1) if (wall[r].includes(key)) n += 1;
  return n;
}
/** 本步会让地板额外背多少罚分（起始标记占位 + 溢出砖）。 */
function floorCost(floorLen, token, spill) {
  let cost = 0;
  let idx = floorLen;
  const total = (token ? 1 : 0) + spill;
  for (let i = 0; i < total && idx < FLOOR_SIZE; i += 1, idx += 1) {
    cost += Math.abs(FLOOR_PENALTY[idx] ?? 0); // 装不下的砖直接进盒子，不罚分
  }
  return cost;
}

/** 这个对手有多想要某颜色：图案行缺口 + 集齐整色的临门一脚。 */
function buildNeed(opp) {
  const need = [0, 0, 0, 0, 0];
  for (let r = 0; r < 5; r += 1) {
    const pat = opp.pattern[r];
    if (pat.color !== null && pat.count > 0) need[pat.color] += (r + 1 - pat.count) * DENY_PAT;
  }
  for (let color = 0; color < 5; color += 1) {
    const have = filled(opp.wall, COLOR, color);
    if (have === 4) need[color] += DENY_SET_NEAR;
    else if (have === 3) need[color] += DENY_SET_NEAR * 0.2;
  }
  return need;
}

/** 威胁度：离补满整行（直接终局）越近、分数越接近我，越该先断他的供。 */
function threatLevel(opp, myScore) {
  let t = 1;
  for (let r = 0; r < 5; r += 1) {
    if (filled(opp.wall, ROW, r) === 4) t += THREAT_ROW_NEAR;
  }
  return t + Math.max(0, opp.score - myScore) * THREAT_SCORE;
}

/** 终局布局价值：这块砖（若填满该行）离完整行 / 整列 / 集齐整色有多近。 */
function layoutGain(me, line, color, completes) {
  const col = WALL_COLOR[line].indexOf(color);
  const rowHave = filled(me.wall, ROW, line);
  const colHave = filled(me.wall, COL, col);
  const setHave = filled(me.wall, COLOR, color);
  let v = 0;
  if (completes) {
    if (rowHave + 1 >= 5) v += LAY_ROW_FULL;
    else if (rowHave + 1 === 4) v += LAY_ROW_NEAR;
    if (colHave + 1 >= 5) v += LAY_COL_FULL;
    else if (colHave + 1 === 4) v += LAY_COL_NEAR;
    if (setHave + 1 >= 5) v += LAY_SET_FULL;
    else if (setHave + 1 === 4) v += LAY_SET_NEAR;
  } else {
    v += LAY_ROW_PULL * ((rowHave + 1) / 5);
    v += LAY_COL_PULL * ((colHave + 1) / 5);
    v += LAY_SET_PULL * ((setHave + 1) / 5);
  }
  return v;
}

export default {
  id: 'minimaxm3',
  name: '三线平衡手',
  tag: '专精',
  model: 'MiniMax M3',
  modes: [3],
  strategy: '中线平衡',
  description: '3人局专用：即时得分、终局布局、断供对手三条线显式加权，按分差动态调权，落后抢分断供，领先压地板防喂色。',

  create(ctx) {
    let lastRound = -1;

    return {
      chooseMove(view, moves) {
        if (!moves || moves.length === 0) return null;
        if (moves.length === 1) return moves[0];
        const me = view.seats[view.mySeat];
        const opponents = view.seats.filter((seat) => seat.seat !== view.mySeat);
        const needs = opponents.map((opp) => buildNeed(opp));
        const threats = opponents.map((opp) => threatLevel(opp, me.score));
        // 分差 → 三条线权重的动态调权（>0 落后，<0 领先）
        let oppTotal = 0;
        for (const opp of opponents) oppTotal += opp.score;
        const gap = opponents.length ? oppTotal / opponents.length - me.score : 0;
        const urgency = Math.max(-1, Math.min(1, gap / GAP_SCALE));
        const w = {
          immediate: W_IMMEDIATE * (1 + TUNE.immediate * urgency),
          layout: W_LAYOUT * (1 - TUNE.layout * urgency),
          deny: W_DENY * (1 + TUNE.deny * urgency),
          defense: W_DEFENSE * (1 - TUNE.defense * urgency),
          floor: W_FLOOR * (1 + TUNE.floor * Math.max(0, -urgency)),
        };
        // 轮次越深终局奖励越值钱——但硬压在即时分之下
        const late = Math.min(1, (view.round - 1) / LATE_ROUND_SPAN);
        w.layout *= 1 + 0.6 * late;
        w.layout = Math.min(w.layout, w.immediate * LAYOUT_CAP_RATIO);
        if (view.round !== lastRound) {
          lastRound = view.round;
          ctx.log(`第${view.round}轮 分差${gap.toFixed(1)}｜即时${w.immediate.toFixed(2)} 布局${w.layout.toFixed(2)} 断供${w.deny.toFixed(2)} 防守${w.defense.toFixed(2)}`);
        }
        let best = moves[0];
        let bestValue = -Infinity;
        for (const move of moves) {
          const pool = move.source === 'center' ? view.center : (view.factories[move.index] || []);
          const taken = countColor(pool, move.color);
          if (taken <= 0) continue;
          const token = move.source === 'center' && view.centerFirst === true;
          let placed = 0, spill = taken, cap = 1, completes = false;
          if (move.line >= 0) {
            cap = PATTERN_CAP[move.line];
            const room = cap - me.pattern[move.line].count;
            placed = Math.min(room, taken);
            spill = taken - placed;
            completes = placed === room;
          }

          // A 即时得分线：上墙连线 + 图案行推进效率
          let imm = 0;
          let layout = 0;
          if (move.line >= 0 && placed > 0) {
            imm += IMM_PROGRESS * (placed / cap);
            if (completes) {
              const col = WALL_COLOR[move.line].indexOf(move.color);
              imm += IMM_WALL * wallPoints(me.wall, move.line, col);
              imm += IMM_COMPLETE * (1 + move.line * 0.2);
            }
            // B 终局布局线：完整行 / 整列 / 集齐整色的折让潜力
            layout = layoutGain(me, move.line, move.color, completes);
          }

          // C 断供对手线：只认最危险的那个对手，再乘 3 人摊薄系数
          let deny = 0;
          const denyScale = Math.min(1.6, 0.7 + 0.3 * taken);
          for (let i = 0; i < opponents.length; i += 1) {
            const need = needs[i][move.color];
            if (need <= 0) continue;
            const value = need * threats[i] * denyScale;
            if (value > deny) deny = value;
          }
          deny *= DENY_DILUTION;

          // 防守：工厂里剩下的砖会被推进中央区，等于喂给对手
          let feed = 0;
          if (move.source === 'factory') {
            for (const tile of pool) {
              if (tile === move.color) continue;
              let worst = 0;
              for (let i = 0; i < opponents.length; i += 1) {
                if (needs[i][tile] > worst) worst = needs[i][tile];
              }
              feed += worst * FEED_W;
            }
          }

          const floorPen = floorCost(me.floor.length, token, spill);
          let value = w.immediate * imm
            + w.layout * layout
            + w.deny * deny
            - w.floor * floorPen
            - w.defense * feed;

          if (token) value += w.immediate * TOKEN_VALUE * TOKEN_FACTOR;
          if (move.line < 0) value -= w.immediate * DISPOSAL_W;

          if (value > bestValue) {
            bestValue = value;
            best = move;
          }
        }

        return best || moves[0];
      },
    };
  },
};
