/**
 * step5preview —— 《花砖物语》4 人局「节奏控制」专精 AI
 *
 * 4 人局的牌理（本脚本全部决策都建立在这几条上）：
 *  - 每轮 36 块砖、9 个工厂四人分，砖最充裕，几乎不会「没砖可取」，
 *    纯断供摊薄到三个对手身上收益最低，不做断供执念；
 *  - 一局 5~6 轮，终局 +2/+7/+10 权重最高，布局型打法占优，
 *    轮次也够把一条列/一色慢慢养大；
 *  - 地板 7 格罚分 -1/-1/-2/-2/-2/-3/-3，四人局砖多，
 *    死因往往是「砖太多放不下」而不是没砖用——防的是自己；
 *  - 四人轮转慢，先手优势被放大：浅地板时值得抢起始标记。
 *
 * 节奏控制是核心：每一手先显式估计「本轮还剩几手」——
 *     estMovesLeft = (工厂剩余砖数 + 中央区砖数) / 平均每手取砖数(2.6)
 * 再据此在激进 / 保守两套权重间插值：
 *  - 激进（轮初，还剩手数多）：抢最好的工厂，短行快速变现，
 *    重仓终局连击（列 +7、集色 +10 的进度加权最高），
 *    地板浅时抢中央区起始标记，放大下一轮先手优势；
 *  - 保守（轮末，还剩手数少）：地板罚分权重拉满，宁可小口取砖
 *    拖长本轮，并优先把「没人要的剩砖」留在工厂滑进中央区，
 *    让三个对手在越堆越多的中央区里被迫连标记带垃圾砖吃地板。
 *
 * 单文件自包含，不 import 任何其它文件；随机只用 ctx.rng()。
 */

const PATTERN_CAP = [1, 2, 3, 4, 5];
const FLOOR_PENALTY = [-1, -1, -2, -2, -2, -3, -3];
const EMPTY = -1;

// 4 人局每轮 36 块砖；平均每手约取 2.6 块 → 全轮约 14 手
const AVG_TAKE = 2.6;

// 引擎 wallColor 缺失时的兜底（官方拉丁方：每行相对上一行右移一格）
const DEFAULT_WALL = Array.from({ length: 5 }, (_, r) =>
  Array.from({ length: 5 }, (_, c) => (c - r + 5) % 5));

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function countColor(arr, color) {
  let n = 0;
  for (let i = 0; i < arr.length; i += 1) if (arr[i] === color) n += 1;
  return n;
}

/** 与引擎 scorePlacement 完全一致：目标格放下去能得几分 */
function placementScore(wall, row, col) {
  let h = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c -= 1) h += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c += 1) h += 1;
  let v = 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r -= 1) v += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r += 1) v += 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

/**
 * 终局潜力：这一格上墙后，行/列/集色三条终局线的进度价值。
 * 4 人局终局 +2/+7/+10 是最高权重，列与集色的单格潜力远大于行，
 * 所以布局型策略（养列、养色）在这里得到回报。
 */
function endgameDelta(wall, row, col, color) {
  let d = 0;
  let rc = 1;
  for (let c = 0; c < 5; c += 1) if (wall[row][c] !== EMPTY) rc += 1;
  d += rc >= 5 ? 2 : rc * 0.4;
  let cc = 1;
  for (let r = 0; r < 5; r += 1) if (wall[r][col] !== EMPTY) cc += 1;
  d += cc >= 5 ? 7 : cc * 1.3;
  let kc = 1;
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) if (wall[r][c] === color) kc += 1;
  }
  d += kc >= 5 ? 10 : kc * 1.6;
  return d;
}

/** 与引擎一致：地板只罚前 7 格，装不下的砖直接丢弃（不罚分，但白亏） */
function floorPenaltyDelta(floorLen, add) {
  let pen = 0;
  for (let i = 0; i < add; i += 1) {
    const idx = floorLen + i;
    if (idx < FLOOR_PENALTY.length) pen += -FLOOR_PENALTY[idx];
  }
  return pen;
}

/**
 * 单个行动估值。W 为按「本轮剩余手数」插值出的权重组；
 * appetite[c] = 还有几个对手吃得下颜色 c（剩砖是不是垃圾的判据）；
 * hoard[c] = 对手图案行里囤着的颜色 c 砖数（轻度争抢）。
 */
function evaluate(view, move, W, appetite, hoard) {
  const me = view.seats[view.mySeat];
  const wallColor = view.wallColor || DEFAULT_WALL;
  const pool = move.source === 'center' ? view.center : view.factories[move.index];
  if (!Array.isArray(pool)) return -1e9;

  const color = move.color;
  const taken = countColor(pool, color);
  if (taken <= 0) return -1e9;

  // 从中央区取砖且标记还在 → 标记压一格地板，并成为下一轮首玩家
  const getsFirst = move.source === 'center' && view.centerFirst === true;
  const markerFloor = getsFirst ? 1 : 0;

  let v = 0;

  if (move.line >= 0) {
    const cap = PATTERN_CAP[move.line];
    const have = me.pattern[move.line].count;
    const room = cap - have;
    const placed = Math.min(room, taken);
    const spill = taken - placed;
    const complete = have + placed === cap;

    if (complete) {
      // 本轮结束这张牌一定上墙：即时连击分 + 终局进度，双重大权重
      const col = wallColor[move.line].indexOf(color);
      const gain = col >= 0 ? placementScore(me.wall, move.line, col) : 1;
      const end = col >= 0 ? endgameDelta(me.wall, move.line, col, color) : 0;
      v += gain * W.complete + end * W.end;
      // 激进期偏好短行变现：用更少的砖换一次上墙，节奏快
      v += (5 - cap) * 0.15 * (1 - W.cons);
    } else {
      // 部分入库：按「距填满的比例」给终局潜力记投资分
      const col = wallColor[move.line].indexOf(color);
      let pot = 0;
      if (col >= 0) {
        pot = placementScore(me.wall, move.line, col) + endgameDelta(me.wall, move.line, col, color);
      }
      const total = have + placed;
      // 这个色还凑得齐吗：袋里 + 桌面 + 中央区，扣掉本手拿走的
      let avail = (view.bagColors[color] || 0) + countColor(view.center, color) - taken;
      for (const f of view.factories) avail += countColor(f, color);
      if (avail < 0) avail = 0;
      const need = cap - total;
      // 四个人抢，打七五折估算自己能拿到的那份
      const viability = need <= 0 ? 1 : clamp((avail * 0.75) / need, 0.05, 1);
      v += pot * (total / cap) * W.stash * viability;
    }
    v -= floorPenaltyDelta(me.floor.length + markerFloor, spill) * W.floor;
  } else {
    // 整批弃地板：只在地板装得下、且实在没处放时才考虑
    v -= floorPenaltyDelta(me.floor.length + markerFloor, taken) * W.floor;
    v -= taken * 0.15;
  }

  if (getsFirst) v += W.first;

  // 节奏控制·进攻面：从工厂取砖，剩下的砖会全部滑进中央区。
  // 轮末这些「没人要的剩砖」就是逼对手吃地板的弹药——对手越吃不下的越值钱。
  if (move.source === 'factory') {
    const rest = pool.length - taken;
    if (rest > 0) {
      let junk = 0;
      const seen = new Set();
      for (const tile of pool) {
        if (tile === color || tile < 0 || seen.has(tile)) continue;
        seen.add(tile);
        const n = countColor(pool, tile);
        junk += n * (appetite[tile] <= 0 ? 1 : 0.3);
      }
      v += junk * W.deny;
    }
  }

  // 节奏控制·防守面：保守期刻意少取砖，把本轮拖长，
  // 让中央区在对手回合之间继续膨胀。
  v -= taken * W.drag;

  // 轻度争抢：对手图案行里囤积的同色，拿走即打断其布局
  if (color >= 0) v += Math.min(hoard[color], 4) * W.contest;

  return v;
}

export default {
  id: 'step5preview',
  name: '控流士',
  tag: '专精',
  model: 'step5preview',
  modes: [4],
  strategy: '节奏控制',
  description: '四人局专精：每手先估算本轮剩余手数，轮初激进抢工厂、短行快变现追终局连击，轮末保守小口取砖拖轮，留垃圾砖在中央区逼三对手吃地板。',

  create(ctx) {
    const rng = typeof ctx.rng === 'function' ? ctx.rng : () => 0;
    const log = typeof ctx.log === 'function' ? (line) => ctx.log(line) : () => {};
    let lastRound = -1;
    let lastMode = '';

    return {
      chooseMove(view, moves) {
        try {
          if (!moves || moves.length === 0) return null;

          // ---- 节奏估计：本轮还剩几手 ----
          let tilesLeft = view.center.length;
          for (const f of view.factories) tilesLeft += f.length;
          const estMovesLeft = tilesLeft / AVG_TAKE;
          // 保守度：还剩 ≤9 手开始转保守，≤3 手完全保守
          const cons = clamp((9 - estMovesLeft) / 6, 0, 1);

          // ---- 终局紧迫度：任何人一行越接近补满，+2/+7/+10 越临近 ----
          let maxRow = 0;
          for (const s of view.seats) {
            for (let r = 0; r < 5; r += 1) {
              let n = 0;
              for (let c = 0; c < 5; c += 1) if (s.wall[r][c] !== EMPTY) n += 1;
              if (n > maxRow) maxRow = n;
            }
          }
          const endUrgency = clamp(0.35 + 0.22 * maxRow, 0.35, 1.15);

          // ---- 激进 / 保守两套权重，按剩余手数插值 ----
          const W = {
            cons,
            complete: 1.35 + 0.45 * cons,                 // 上墙变现
            end: (0.85 + 0.45 * cons) * endUrgency,      // 终局连击（4 人局最高权重）
            floor: 0.55 + 1.05 * cons,                   // 地板罚分（保守期拉满）
            first: 3.0 * clamp(1.2 - endUrgency, 0, 1),  // 抢起始标记（四人轮转慢，先手优势被放大）
            deny: 0.10 + 0.32 * cons,                    // 留垃圾砖进中央区
            stash: 0.5,                                  // 图案行投资
            drag: 0.05 + 0.10 * cons,                    // 小口取砖拖轮
            contest: 0.12,                               // 打断对手囤色
          };

          // ---- 对手可行动信息：判断剩砖是不是垃圾 / 谁在囤什么色 ----
          const appetite = [0, 0, 0, 0, 0];
          const hoard = [0, 0, 0, 0, 0];
          for (const s of view.seats) {
            if (s.seat === view.mySeat) continue;
            for (let c = 0; c < 5; c += 1) {
              let ok = false;
              for (let line = 0; line < 5 && !ok; line += 1) {
                const p = s.pattern[line];
                if (p.count >= PATTERN_CAP[line]) continue;
                if (p.count > 0 && p.color !== c) continue;
                if (s.wall[line].includes(c)) continue;
                ok = true;
              }
              if (ok) appetite[c] += 1;
              else if (s.floor.length >= 4) appetite[c] += 0.5; // 地板深，被迫乱吃
              for (const p of s.pattern) if (p.color === c) hoard[c] += p.count;
            }
          }

          let best = moves[0];
          let bestValue = -Infinity;
          for (const mv of moves) {
            const value = evaluate(view, mv, W, appetite, hoard) + rng() * 1e-4;
            if (value > bestValue) {
              bestValue = value;
              best = mv;
            }
          }
          if (!best) best = moves[0];

          const mode = cons > 0.5 ? '慢' : '快';
          if (view.round !== lastRound || lastMode !== mode) {
            lastRound = view.round;
            lastMode = mode;
            log(`第${view.round}轮 估剩${estMovesLeft.toFixed(1)}手 切${mode}线`);
          }
          return best;
        } catch (_e) {
          return moves[0];
        }
      },
    };
  },
};
