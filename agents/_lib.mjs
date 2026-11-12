/**
 * 脚本公用工具。下划线开头，不会被注册成可选脚本。
 *
 * 这里放的是「一个人类玩家在脑子里算的东西」：
 * 取几块、溢出几块、扣几分、上墙拿几分、离整行整列还差多少。
 */

export const FLOOR_PENALTY = [-1, -1, -2, -2, -2, -3, -3];
export const PATTERN_CAP = [1, 2, 3, 4, 5];
export const EMPTY = -1;
export const FIRST_TOKEN = -1;

export const COLOR_NAMES = ['蓝', '黄', '红', '黑', '白'];

/** 这次行动会从来源里抓走几块砖。 */
export function takenCount(view, move) {
  const pool = move.source === 'center'
    ? view.center
    : view.factories[move.index] || [];
  let count = 0;
  for (const tile of pool) if (tile === move.color) count += 1;
  return count;
}

/**
 * 地板区再落 spill 块砖，要扣多少分（返回正数）。
 * 超过 7 格的部分直接丢回盒盖，不额外扣分 —— 这里如实返回 0。
 */
export function floorDamage(floorLen, spill) {
  let damage = 0;
  for (let i = 0; i < spill; i += 1) {
    const index = floorLen + i;
    if (index < FLOOR_PENALTY.length) damage += Math.abs(FLOOR_PENALTY[index]);
  }
  return damage;
}

/** 在 (row, col) 落一块砖能拿几分（含横竖两段）。 */
export function wallScore(wall, row, col) {
  let horizontal = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c -= 1) horizontal += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c += 1) horizontal += 1;

  let vertical = 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r -= 1) vertical += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r += 1) vertical += 1;

  if (horizontal === 1 && vertical === 1) return 1;
  return (horizontal > 1 ? horizontal : 0) + (vertical > 1 ? vertical : 0);
}

/** 某颜色在某行墙面上的列号。 */
export function targetCol(wallColor, row, color) {
  return wallColor[row].indexOf(color);
}

/** 把该色补进该行能立刻拿到的分数；墙面已占则返回 0。 */
export function placementValue(seat, wallColor, row, color) {
  const col = targetCol(wallColor, row, color);
  if (col < 0 || seat.wall[row][col] !== EMPTY) return 0;
  return wallScore(seat.wall, row, col);
}

/** 该行墙面已经填了几格。 */
export function rowFilled(seat, row) {
  return seat.wall[row].filter((cell) => cell !== EMPTY).length;
}

/** 该列墙面已经填了几格。 */
export function colFilled(seat, col) {
  let count = 0;
  for (let row = 0; row < 5; row += 1) if (seat.wall[row][col] !== EMPTY) count += 1;
  return count;
}

/** 该色已经上墙几块。 */
export function colorPlaced(seat, color) {
  let count = 0;
  for (let row = 0; row < 5; row += 1) if (seat.wall[row].includes(color)) count += 1;
  return count;
}

/**
 * 一次行动的结构化结果。
 *   gain      即时净收益（分数口径，已把地板扣分折算进去）
 *   completes 本次是否补满图案行（补满才会上墙）
 */
export function evaluateOutcome(view, move) {
  const me = view.seats[view.mySeat];
  const taken = takenCount(view, move);

  let floorBase = me.floor.length;
  let gain = 0;

  if (move.source === 'center' && view.centerFirst) {
    // 首标记立刻压在地板区下一个空格，先吃这一格的罚分
    gain -= Math.abs(FLOOR_PENALTY[floorBase] ?? 0);
    floorBase += 1;
  }

  if (move.line === -1) {
    return {
      gain: gain - floorDamage(floorBase, taken) - 0.5,
      taken,
      placed: 0,
      spill: taken,
      completes: false,
    };
  }

  const pattern = me.pattern[move.line];
  const cap = PATTERN_CAP[move.line];
  const room = cap - pattern.count;
  const placed = Math.min(room, taken);
  const spill = taken - placed;
  const completes = pattern.count + placed === cap;

  gain -= floorDamage(floorBase, spill);
  if (completes) {
    gain += placementValue(me, view.wallColor, move.line, move.color);
  } else {
    // 没补满的砖只是进度，按七折左右的贴现给分
    gain += 0.18 * placed;
  }
  // 抓太多用不掉是实打实的浪费
  gain -= 0.3 * spill;

  return { gain, taken, placed, spill, completes };
}

/** 该行动取走后，对手还能不能拿到这种颜色。用于「断供」评估。 */
export function scarcityAfter(view, move) {
  const remaining = move.source === 'center'
    ? view.center.filter((tile) => tile !== move.color).length
    : 0; // 从工厂取走后剩余砖进中央，颜色并未消失，这里只关心从中央取
  return remaining;
}

/**
 * 对手对这个颜色的渴求程度 0~1+。
 * 图案行里同色砖越多、行越长，说明越可能正在憋一条大行。
 */
export function opponentNeed(view, color) {
  let need = 0;
  for (const seat of view.seats) {
    if (seat.seat === view.mySeat) continue;
    for (let row = 0; row < 5; row += 1) {
      const pattern = seat.pattern[row];
      if (pattern.count > 0 && pattern.color === color) {
        need += (pattern.count / PATTERN_CAP[row]) * 0.8;
      }
      // 墙面上还留着这个颜色的空位，说明将来一定还要
      if (seat.wall[row].includes(color) === false) need += 0.06;
    }
  }
  return need;
}
