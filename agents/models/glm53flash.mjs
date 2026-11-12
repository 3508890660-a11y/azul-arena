// GLM5.3flash — Azul 2人局「速攻终局」专精 AI
// 核心思路：用最短图案行最快上墙、压缩轮次；砖稀缺下抢断对手所需颜色；
// 地板罚分权重极高；领先或对手未铺开时果断补满整行触发终局。

const FLOOR_PEN = [1, 1, 2, 2, 2, 3, 3];

function floorPenalty(count) {
  let p = 0;
  const n = Math.min(count, 7);
  for (let i = 0; i < n; i++) p += FLOOR_PEN[i];
  return p;
}

function rowFilled(wall, r) {
  let n = 0;
  for (let c = 0; c < 5; c++) if (wall[r][c] >= 0) n++;
  return n;
}

function bonusOf(wall, wallColor) {
  let rows = 0, cols = 0, colors = 0;
  for (let r = 0; r < 5; r++) if (rowFilled(wall, r) === 5) rows++;
  for (let c = 0; c < 5; c++) {
    let full = true;
    for (let r = 0; r < 5; r++) if (wall[r][c] < 0) full = false;
    if (full) cols++;
  }
  for (let k = 0; k < 5; k++) {
    let full = true;
    for (let r = 0; r < 5 && full; r++) {
      for (let c = 0; c < 5; c++) {
        if (wallColor[r][c] === k && wall[r][c] < 0) { full = false; break; }
      }
    }
    if (full) colors++;
  }
  return rows * 2 + cols * 7 + colors * 10;
}

function pendingFullLines(s) {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const pl = s.pattern[i];
    if (pl && pl.count === i + 1) n++;
  }
  return n;
}

// 估计「距离游戏结束还有几轮」：以双方墙上最接近补满的行距为准，
// 2 人局每轮每人约上墙 2 块（短行节奏）。
function estRoundsLeft(view) {
  let minGap = 5;
  for (const s of view.seats) {
    for (let r = 0; r < 5; r++) {
      const gap = 5 - rowFilled(s.wall, r);
      if (gap < minGap) minGap = gap;
    }
  }
  return Math.max(1, Math.min(6, Math.ceil(minGap / 2)));
}

function evalMove(view, mv, me, opp, roundsLeft, wallColor) {
  const wImm = 1 + (6 - roundsLeft) * 0.1; // 轮次越少，即时分权重越高
  let sc = 0;
  const fromCenter = mv.source === 'center';
  let taken;
  if (fromCenter) taken = view.center.filter((c) => c === mv.color).length;
  else taken = (view.factories[mv.index] || []).filter((c) => c === mv.color).length;
  if (!taken) return -1e9;

  const hasLine = mv.line >= 0;
  let placed = 0;
  let overflow = taken;
  let cur = 0;
  if (hasLine) {
    const pl = me.pattern[mv.line];
    cur = pl && pl.color === mv.color ? pl.count : 0;
    const space = mv.line + 1 - cur;
    placed = Math.min(taken, space);
    overflow = taken - placed;
  }
  const marker = fromCenter && view.centerFirst ? 1 : 0;
  const fp = floorPenalty(me.floor.length + overflow + marker);
  sc -= fp * 3.2; // 地板罚分在低分局里比重极高

  if (hasLine && placed > 0 && cur + placed === mv.line + 1) {
    // 本步立刻上墙：计算横向/纵向连块即时分
    const col = wallColor[mv.line].indexOf(mv.color);
    let h = 1;
    for (let c = col - 1; c >= 0 && me.wall[mv.line][c] >= 0; c--) h++;
    for (let c = col + 1; c < 5 && me.wall[mv.line][c] >= 0; c++) h++;
    let v = 1;
    for (let r = mv.line - 1; r >= 0 && me.wall[r][col] >= 0; r--) v++;
    for (let r = mv.line + 1; r < 5 && me.wall[r][col] >= 0; r++) v++;
    sc += (h + v) * 2.2 * wImm;
    sc -= mv.line * 0.3; // 长行用多块砖只换 1 块上墙，效率低
    const nw = me.wall.map((row) => row.slice());
    nw[mv.line][col] = mv.color;
    const bd = bonusOf(nw, wallColor) - bonusOf(me.wall, wallColor);
    sc += bd * (0.8 + roundsLeft * 0.1); // 轮次越少终局奖励权重越低
    if (rowFilled(nw, mv.line) === 5) {
      // 补满整行 → 本轮结束游戏触发终局
      const oppProj = bonusOf(opp.wall, wallColor) + pendingFullLines(opp) * 2.5;
      const lead = me.score + bonusOf(nw, wallColor) - (opp.score + oppProj);
      sc += 12 + (lead > 0 ? 10 : -18);
    }
  } else if (hasLine && placed > 0) {
    // 不能立刻上墙：惩罚锁住的砖；只差 1 块就能满的行几乎不罚
    const remaining = mv.line + 1 - (cur + placed);
    sc -= placed * (remaining <= 1 ? 0.15 : 0.45);
    const col = wallColor[mv.line].indexOf(mv.color);
    let adj = 0;
    if (col > 0 && me.wall[mv.line][col - 1] >= 0) adj++;
    if (col < 4 && me.wall[mv.line][col + 1] >= 0) adj++;
    if (mv.line > 0 && me.wall[mv.line - 1][col] >= 0) adj++;
    if (mv.line < 4 && me.wall[mv.line + 1][col] >= 0) adj++;
    sc += adj * 0.35; // 预埋十字交叉
    sc += (2 - mv.line) * 0.15; // 偏好第 1、2 行
  } else {
    sc -= 2; // 整批弃地板，尽量避免
  }

  // 断供：对手图案行正需要这个颜色时，拿走的每一块都是相对优势
  let oppNeed = 0;
  for (let i = 0; i < 5; i++) {
    const pl = opp.pattern[i];
    if (pl && pl.color === mv.color && pl.count > 0) {
      oppNeed = Math.max(oppNeed, i + 1 - pl.count);
    }
  }
  sc += taken * oppNeed * 0.3;

  if (marker) sc += roundsLeft <= 2 ? 1.5 : 1.0; // 先手节奏价值
  if (!fromCenter) sc += 0.15; // 优先清工厂，少给中央区堆积喂对手
  return sc;
}

export default {
  id: 'glm53flash',
  name: '疾风快墙',
  tag: '专精',
  model: 'GLM5.3flash',
  modes: [2],
  strategy: '速攻终局',
  description:
    '以最短图案行最快上墙压缩轮次，抢断对手急需砖色，严控地板罚分；领先或对手未铺开时果断补满整行触发终局。',

  create(ctx) {
    return {
      chooseMove(view, moves) {
        if (!moves || moves.length === 0) return moves ? moves[0] : null;
        try {
          if (!view.myTurn) return moves[0];
          const me = view.seats[view.mySeat];
          const opp = view.seats[view.mySeat === 0 ? 1 : 0];
          const wallColor = view.wallColor;
          const roundsLeft = estRoundsLeft(view);
          let best = null;
          let bestSc = -Infinity;
          for (const mv of moves) {
            let s;
            try {
              s = evalMove(view, mv, me, opp, roundsLeft, wallColor);
            } catch (e) {
              s = -1e9;
            }
            s += ctx.rng() * 0.05; // 同分微小扰动，保证可复现
            if (s > bestSc) {
              bestSc = s;
              best = mv;
            }
          }
          return best || moves[0];
        } catch (e) {
          return moves[0];
        }
      },
    };
  },
};
