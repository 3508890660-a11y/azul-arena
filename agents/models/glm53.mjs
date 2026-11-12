/**
 * GLM5.3 —— 颜色垄断型·两人局专用 AI
 *
 * 核心思路（针对 2 人局砖源极度稀缺设计）：
 *  1. 尽早锁定 2~3 种「专精色」：优先墙上已有进度、对手投入少的颜色；
 *  2. 专精色的每一块砖都有双重价值（我上墙 + 对手拿不到），权重最高；
 *  3. 对手正在囤的颜色（图案行/墙面多行）按「断供价值」单独加权；
 *  4. 中立颜色只作为顺手填充，权重最低；
 *  5. 地板罚分在低分局里比重极高，溢出惩罚按边际罚分严格计算；
 *  6. 起始玩家标记在两人局里等于下一轮的先挑权，估值随局面动态调整。
 *
 * 单文件自包含，不 import 任何其它文件。
 */

const FLOOR_PEN = [-1, -1, -2, -2, -2, -3, -3];
const COLOR_NAMES = ['蓝', '黄', '红', '黑', '白'];
const EMPTY = -1;

/** 墙面 (row, color) 对应的列号。 */
function wallColOf(wallColor, row, color) {
  const col = wallColor[row].indexOf(color);
  return col >= 0 ? col : (color + row) % 5;
}

/** 模拟把一块砖放上墙后的立刻得分（与引擎公式一致）。 */
function placeScore(wall, row, col) {
  let h = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c -= 1) h += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c += 1) h += 1;
  let v = 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r -= 1) v += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r += 1) v += 1;
  if (h === 1 && v === 1) return 1;
  return (h > 1 ? h : 0) + (v > 1 ? v : 0);
}

/** 从地板第 len 格起再压 count 块砖的边际罚分（超过 7 格进盒盖、不计罚）。 */
function floorPenaltyAt(len, count) {
  let pen = 0;
  for (let i = 0; i < count; i += 1) {
    const idx = len + i;
    pen += idx < 7 ? Math.abs(FLOOR_PEN[idx]) : 0;
  }
  return pen;
}

function filledCount(row) {
  return row.filter((cell) => cell !== EMPTY).length;
}

export default {
  id: 'glm53',
  name: '垄断者',
  tag: '专精',
  model: 'GLM5.3',
  modes: [2],
  strategy: '颜色垄断',
  description: '两人局砖源极稀缺：锁定两三种专精色，铺墙集色的同时吃干场上该色，断对手供给。',
  create(ctx) {
    const mem = { ownColors: [], loggedRound: 0 };

    return {
      chooseMove(view, moves) {
        try {
          if (!moves || moves.length === 0) return null;
          if (moves.length === 1) return moves[0];
          if (view.playerCount !== 2) return moves[0];

          const me = view.seats[view.mySeat];
          const opp = view.seats[1 - view.mySeat];
          const WC = view.wallColor;

          /* ---------- 每色统计 ---------- */
          const myRows = Array(5).fill(0); // 我墙上已放该色的行数（集齐 5 行 +10）
          const oppRows = Array(5).fill(0);
          for (let r = 0; r < 5; r += 1) {
            for (let cc = 0; cc < 5; cc += 1) {
              const v = me.wall[r][cc];
              if (v !== EMPTY && v >= 0) myRows[v] += 1;
              const o = opp.wall[r][cc];
              if (o !== EMPTY && o >= 0) oppRows[o] += 1;
            }
          }
          const myPat = Array(5).fill(0); // 我图案行里囤的该色砖数
          const oppPat = Array(5).fill(0); // 对手囤的（「对手正在囤的颜色」）
          for (let l = 0; l < 5; l += 1) {
            const p = me.pattern[l];
            if (p && p.count > 0 && p.color != null) myPat[p.color] += p.count;
            const q = opp.pattern[l];
            if (q && q.count > 0 && q.color != null) oppPat[q.color] += q.count;
          }

          /* ---------- 专精色选择（带惯性，避免反复摇摆） ---------- */
          const aff = Array(5).fill(0);
          for (let c = 0; c < 5; c += 1) {
            aff[c] = 3 * myRows[c] + 0.7 * myPat[c]
              + 0.05 * (view.bagColors ? view.bagColors[c] || 0 : 0)
              - 1.1 * oppRows[c] - 0.5 * oppPat[c]
              + (mem.ownColors.includes(c) ? 1.2 : 0);
          }
          const ranked = [0, 1, 2, 3, 4].slice().sort((a, b) => aff[b] - aff[a]);
          const ownSet = new Set([ranked[0], ranked[1]]);
          if (aff[ranked[2]] >= 1.0) ownSet.add(ranked[2]); // 形势好时扩到第三色
          mem.ownColors = Array.from(ownSet);
          if (view.round !== mem.loggedRound) {
            mem.loggedRound = view.round;
            ctx.log(`第${view.round}轮 专精色锁定：${mem.ownColors.map((c) => COLOR_NAMES[c]).join('/')}`);
          }

          /* ---------- 对手囤积色与威胁（断供目标） ---------- */
          const rivalSet = new Set();
          for (let c = 0; c < 5; c += 1) {
            if (ownSet.has(c)) continue;
            if (oppRows[c] >= 2 || oppPat[c] >= 3 || (oppRows[c] >= 1 && oppPat[c] >= 2)) rivalSet.add(c);
          }
          const threat = Array(5).fill(0); // 对手图案行即将凑满的颜色
          for (let l = 0; l < 5; l += 1) {
            const q = opp.pattern[l];
            if (!q || q.count <= 0 || q.color == null) continue;
            const need = (l + 1) - q.count;
            if (need === 1) threat[q.color] += 2.0;
            else if (need === 2) threat[q.color] += 0.9;
            else if (need === 3) threat[q.color] += 0.35;
          }
          // 对手墙面只差一格补满整行的缺口色：让他拿到就收官，狠狠断供
          const oppRowGap = Array(5).fill(0);
          for (let r = 0; r < 5; r += 1) {
            if (filledCount(opp.wall[r]) === 4) {
              for (let cc = 0; cc < 5; cc += 1) {
                if (opp.wall[r][cc] === EMPTY) { oppRowGap[WC[r][cc]] += 1; break; }
              }
            }
          }
          for (let c = 0; c < 5; c += 1) threat[c] += 1.2 * oppRowGap[c];

          /* ---------- 场上砖与终局判断 ---------- */
          const onBoard = Array(5).fill(0);
          for (const f of view.factories) for (const t of f) onBoard[t] += 1;
          for (const t of view.center) onBoard[t] += 1;

          let nearEnd = false;
          for (const seat of [me, opp]) {
            for (let r = 0; r < 5; r += 1) if (filledCount(seat.wall[r]) >= 4) nearEnd = true;
          }

          /* ---------- 颜色效用权重：我需要的 > 对手囤的 > 中立 ---------- */
          const w = Array(5).fill(0.55);
          for (const c of ownSet) w[c] = 1.5;
          for (const c of rivalSet) w[c] = 1.15;
          for (let c = 0; c < 5; c += 1) w[c] += Math.min(threat[c], 2.5) * 0.18;

          /* ---------- 逐行动打分 ---------- */
          let best = moves[0];
          let bestScore = -Infinity;

          for (const m of moves) {
            const pool = m.source === 'center' ? view.center : (view.factories[m.index] || []);
            let n = 0;
            for (const t of pool) if (t === m.color) n += 1;
            if (n <= 0) continue;

            const c = m.color;
            const isOwn = ownSet.has(c);
            const isRival = rivalSet.has(c);
            let s = 0;

            // 起始玩家标记：先挑权 + 终局临近时贬值
            let floorLen = me.floor.length;
            if (m.source === 'center' && view.centerFirst) {
              const tokenCost = floorLen < 7 ? Math.abs(FLOOR_PEN[floorLen]) : 0;
              s += (nearEnd ? 0.9 : 2.2) - tokenCost * 1.1;
              if (floorLen < 7) floorLen += 1; // 标记先占一格，溢出砖顺延
            }

            if (m.line === -1) {
              // 整批弃地板：纯断供（价值减半计），除非威胁极大，否则强烈回避
              s += n * w[c] * 0.5;
              s -= floorPenaltyAt(floorLen, n) * 1.55 + 0.8;
            } else {
              const p = me.pattern[m.line];
              const cap = m.line + 1;
              const room = cap - p.count;
              const placed = Math.min(room, n);
              const spill = n - placed;
              const col = wallColOf(WC, m.line, c);

              // 进图案行的砖全额计获取+断供；溢出砖只剩断供价值（打折）
              s += placed * w[c] + spill * w[c] * 0.4;

              if (p.count + placed === cap) {
                // 本轮就能上墙：按墙位真实得分估值
                const ws = placeScore(me.wall, m.line, col);
                s += ws * (nearEnd ? 1.2 : 1.0) + 2.5;
                const rowFilled = filledCount(me.wall[m.line]);
                const colFilled = me.wall.filter((row) => row[col] !== EMPTY).length;
                s += 0.45 * colFilled + 0.3 * rowFilled;
                if (colFilled === 4) s += 4.0; // 补满一列 +7
                if (rowFilled === 4) s += 2.5; // 补满一行 +2 且触发收官
                if (isOwn) s += 0.6 * myRows[c]; // 集齐同色 +10 的进度收益
                if (isOwn && myRows[c] === 4) s += 5.0; // 这一放就集齐
              } else {
                // 攒进度：行越短效率越高，专精色另加成
                s += placed * (1.9 / cap) * (isOwn ? 1.25 : isRival ? 0.9 : 0.7);
                if (p.count > 0 && p.color === c) s += 0.35 * placed;
              }

              // 用中立色新开长行：低效，压分
              if (p.count === 0 && cap >= 4 && !isOwn) s -= 0.45 * (cap - 3);

              // 溢出罚分：按边际罚分严格计（低分局 -3 就是白干一轮）
              if (spill > 0) s -= floorPenaltyAt(floorLen, spill) * 1.6 + spill * 0.5;
            }

            if (s > bestScore) { bestScore = s; best = m; }
          }

          return best;
        } catch (error) {
          return moves && moves.length ? moves[0] : null;
        }
      },
    };
  },
};
