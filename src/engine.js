/**
 * 《花砖物语》规则引擎。
 *
 * 设计约束：
 *  1. 纯数据 state，可 structuredClone，可 JSON 序列化 —— 便于存档、回放、送进 Worker。
 *  2. 所有随机都走 state 内部的 rng 游标，同一 seed 可复现整局。
 *  3. 引擎只产出「事实事件」，不做任何叙事；观战界面负责把事件翻译成人话。
 *  4. 状态变更只有 applyMove / resolveRound / startNextRound 三个入口，别处一律只读。
 *
 * 回合状态机：
 *   draft  --(工厂与中央全部取空)-->  tiling  --(结算完)-->  draft（下一轮）
 *                                              └--(有人补满整行墙面)--> over
 */

import {
  BONUS,
  COLORS,
  EMPTY,
  FACTORY_COUNT_BY_PLAYERS,
  FIRST_TOKEN,
  FLOOR_PENALTY,
  FLOOR_SIZE,
  PATTERN_CAP,
  PLAYER_COUNTS,
  TILES_PER_COLOR,
  TILES_PER_FACTORY,
  TOTAL_TILES,
  WALL_COLOR,
} from './rules.js';

const clone = typeof structuredClone === 'function'
  ? (value) => structuredClone(value)
  : (value) => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ *
 * 随机数：mulberry32，游标存在 state 里，保证 state 完全可序列化
 * ------------------------------------------------------------------ */

export function nextRandom(state) {
  let a = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle(state, array) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRandom(state) * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/* ------------------------------------------------------------------ *
 * 建局
 * ------------------------------------------------------------------ */

export function createGame({ playerCount = 4, seed = 1, names = [] } = {}) {
  if (!PLAYER_COUNTS.includes(playerCount)) {
    throw new Error(`人数必须是 ${PLAYER_COUNTS.join('/')}，收到 ${playerCount}`);
  }

  const state = {
    playerCount,
    seed: seed >>> 0 || 1,
    rng: (seed >>> 0 || 1) | 0,
    bag: [],
    discard: [],
    factories: [],
    center: [],
    centerFirst: true,
    seats: [],
    turn: 0,
    firstSeat: 0,
    nextFirst: null,
    round: 0,
    phase: 'draft',
    moveCount: 0,
    over: false,
    ranking: [],
  };

  for (let color = 0; color < COLORS; color += 1) {
    for (let i = 0; i < TILES_PER_COLOR; i += 1) state.bag.push(color);
  }
  shuffle(state, state.bag);

  for (let seat = 0; seat < playerCount; seat += 1) {
    state.seats.push({
      seat,
      name: names[seat] || `玩家 ${seat + 1}`,
      score: 0,
      floor: [],
      pattern: PATTERN_CAP.map(() => ({ color: null, count: 0 })),
      wall: Array.from({ length: 5 }, () => Array(5).fill(EMPTY)),
      bonus: null,
    });
  }

  const events = [{ type: 'game-start', playerCount, seed: state.seed, bagSize: state.bag.length }];
  const opened = startNextRound(state);
  return { state: opened.state, events: [...events, ...opened.events] };
}

/* ------------------------------------------------------------------ *
 * 补砖与开轮
 * ------------------------------------------------------------------ */

function drawTile(state) {
  if (state.bag.length === 0) {
    if (state.discard.length === 0) return null;
    state.bag = state.discard;
    state.discard = [];
    shuffle(state, state.bag);
  }
  return state.bag.pop();
}

/** 把盒盖上的弃砖洗回袋里。返回是否发生过回收。 */
export function refillBag(state) {
  if (state.bag.length > 0 || state.discard.length === 0) return false;
  state.bag = state.discard;
  state.discard = [];
  shuffle(state, state.bag);
  return true;
}

export function startNextRound(state) {
  const next = clone(state);
  const events = [];

  next.round += 1;
  next.firstSeat = next.nextFirst ?? next.firstSeat;
  next.nextFirst = null;
  next.center = [];
  next.centerFirst = true;
  next.phase = 'draft';
  next.turn = next.firstSeat;

  const factoryCount = FACTORY_COUNT_BY_PLAYERS[next.playerCount];
  next.factories = [];
  for (let index = 0; index < factoryCount; index += 1) {
    const tiles = [];
    for (let i = 0; i < TILES_PER_FACTORY; i += 1) {
      const tile = drawTile(next);
      if (tile !== null) tiles.push(tile);
    }
    next.factories.push(tiles);
  }

  events.push({
    type: 'round-start',
    round: next.round,
    firstSeat: next.firstSeat,
    factories: next.factories.map((tiles) => [...tiles]),
    bagSize: next.bag.length,
  });

  return { state: next, events };
}

/* ------------------------------------------------------------------ *
 * 合法性
 * ------------------------------------------------------------------ */

/**
 * 一条图案行能否接收某颜色。
 * 三条硬约束，全部来自官方规则书：
 *   a) 行未满；
 *   b) 行内不得混色；
 *   c) 该行对应的墙面尚未出现这种颜色（"cannot revisit a color"）。
 */
export function canPlaceInLine(seat, line, color) {
  const pattern = seat.pattern[line];
  const cap = PATTERN_CAP[line];
  if (pattern.count >= cap) return false;
  if (pattern.count > 0 && pattern.color !== color) return false;
  if (seat.wall[line].includes(color)) return false;
  return true;
}

/**
 * 生成当前玩家的全部合法行动。
 *
 * 行动形如 { source, index, color, line }：
 *   source  'factory' | 'center'
 *   index   工厂下标；中央区固定 -1
 *   color   颜色号
 *   line    图案行 0~4；-1 表示整批弃到地板区
 *
 * line = -1 是官方允许的行动（"you may even choose to place them in the
 * floor line"）。尽管它在策略上恒被「放进任意合法行」弱支配，引擎仍然
 * 如实提供——规则完整性和策略简洁性是两件事，前者不该被后者牺牲。
 */
export function legalMoves(state) {
  if (state.over || state.phase !== 'draft') return [];
  const seat = state.seats[state.turn];
  const moves = [];

  const sources = [];
  state.factories.forEach((tiles, index) => {
    if (tiles.length) sources.push({ source: 'factory', index, tiles });
  });
  if (state.center.length) sources.push({ source: 'center', index: -1, tiles: state.center });

  for (const source of sources) {
    const colors = Array.from(new Set(source.tiles)).sort((a, b) => a - b);
    for (const color of colors) {
      for (let line = 0; line < 5; line += 1) {
        if (canPlaceInLine(seat, line, color)) {
          moves.push({ source: source.source, index: source.index, color, line });
        }
      }
      moves.push({ source: source.source, index: source.index, color, line: -1 });
    }
  }

  return moves;
}

export function moveKey(move) {
  return `${move.source}:${move.index}:${move.color}:${move.line}`;
}

export function isLegalMove(state, move) {
  if (!move || typeof move !== 'object') return false;
  const wanted = moveKey({
    source: String(move.source),
    index: Number(move.index),
    color: Number(move.color),
    line: Number(move.line),
  });
  return legalMoves(state).some((candidate) => moveKey(candidate) === wanted);
}

/* ------------------------------------------------------------------ *
 * 行动执行
 * ------------------------------------------------------------------ */

function pushFloor(state, seat, tiles) {
  const room = FLOOR_SIZE - seat.floor.length;
  const fit = Math.min(room, Math.max(0, tiles.length));
  for (let i = 0; i < fit; i += 1) seat.floor.push(tiles[i]);
  for (let i = fit; i < tiles.length; i += 1) state.discard.push(tiles[i]);
}

function takeTiles(state, move, events) {
  const color = move.color;
  let taken;

  if (move.source === 'factory') {
    const factory = state.factories[move.index];
    if (!Array.isArray(factory) || factory.length === 0) {
      throw new Error(`工厂 #${move.index + 1} 已经空了`);
    }
    taken = factory.filter((tile) => tile === color);
    if (taken.length === 0) throw new Error('该工厂没有这种颜色的砖');
    const rest = factory.filter((tile) => tile !== color);
    state.factories[move.index] = [];
    state.center.push(...rest);
    events.push({ type: 'factory-drain', factory: move.index, moved: rest.length });
  } else {
    taken = state.center.filter((tile) => tile === color);
    if (taken.length === 0) throw new Error('中央区没有这种颜色的砖');
    state.center = state.center.filter((tile) => tile !== color);
    if (state.centerFirst) {
      state.centerFirst = false;
      state.nextFirst = state.turn;
      events.push({ type: 'first-token', seat: state.turn });
      // 标记立刻压在地板区最左空位
      pushFloor(state, state.seats[state.turn], [FIRST_TOKEN]);
    }
  }

  return taken;
}

export function applyMove(state, move) {
  if (!isLegalMove(state, move)) {
    throw new Error(`非法行动：${JSON.stringify(move)}`);
  }

  const next = clone(state);
  const events = [];
  const seatIndex = next.turn;
  const seat = next.seats[seatIndex];

  const tiles = takeTiles(next, move, events);
  const color = move.color;
  const count = tiles.length;

  if (move.line === -1) {
    pushFloor(next, seat, tiles);
    events.push({ type: 'place', seat: seatIndex, line: -1, color, count, placed: 0, spill: count, complete: false });
  } else {
    const pattern = seat.pattern[move.line];
    const cap = PATTERN_CAP[move.line];
    const room = cap - pattern.count;
    const placed = Math.min(room, count);
    pattern.color = color;
    pattern.count += placed;
    const spill = count - placed;
    if (spill > 0) pushFloor(next, seat, tiles.slice(placed));
    events.push({
      type: 'place',
      seat: seatIndex,
      line: move.line,
      color,
      count,
      placed,
      spill,
      complete: pattern.count === cap,
    });
  }

  next.moveCount += 1;
  next.turn = (seatIndex + 1) % next.playerCount;

  const drained = next.center.length === 0 && next.factories.every((factory) => factory.length === 0);
  if (drained) {
    next.phase = 'tiling';
    events.push({ type: 'phase', phase: 'tiling' });
  }

  return { state: next, events };
}

/* ------------------------------------------------------------------ *
 * 轮末结算
 * ------------------------------------------------------------------ */

function scorePlacement(wall, row, col) {
  let horizontal = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== EMPTY; c -= 1) horizontal += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== EMPTY; c += 1) horizontal += 1;

  let vertical = 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== EMPTY; r -= 1) vertical += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== EMPTY; r += 1) vertical += 1;

  if (horizontal === 1 && vertical === 1) return 1;
  return (horizontal > 1 ? horizontal : 0) + (vertical > 1 ? vertical : 0);
}

function finalScoring(state, events) {
  for (const seat of state.seats) {
    let rows = 0;
    let columns = 0;
    let colors = 0;

    for (let row = 0; row < 5; row += 1) {
      if (seat.wall[row].every((cell) => cell !== EMPTY)) rows += 1;
    }
    for (let col = 0; col < 5; col += 1) {
      if (seat.wall.every((row) => row[col] !== EMPTY)) columns += 1;
    }
    for (let color = 0; color < COLORS; color += 1) {
      if (seat.wall.every((row) => row.includes(color))) colors += 1;
    }

    const points = rows * BONUS.row + columns * BONUS.column + colors * BONUS.color;
    seat.score += points;
    seat.bonus = { rows, columns, colors, points };
    events.push({
      type: 'final-bonus',
      seat: seat.seat,
      rows,
      columns,
      colors,
      points,
      score: seat.score,
    });
  }

  const totalRows = (seat) => seat.wall.filter((row) => row.every((cell) => cell !== EMPTY)).length;
  state.ranking = [...state.seats]
    .sort((a, b) => b.score - a.score || totalRows(b) - totalRows(a) || a.seat - b.seat)
    .map((seat, index) => ({
      place: index + 1,
      seat: seat.seat,
      name: seat.name,
      score: seat.score,
      rows: totalRows(seat),
    }));

  state.over = true;
  state.phase = 'over';
  events.push({
    type: 'game-over',
    ranking: state.ranking,
    winner: state.ranking[0]?.seat ?? null,
  });
}

export function resolveRound(state) {
  if (state.phase !== 'tiling') throw new Error('当前不在结算阶段');

  const next = clone(state);
  const events = [];

  for (const seat of next.seats) {
    for (let row = 0; row < 5; row += 1) {
      const pattern = seat.pattern[row];
      const cap = PATTERN_CAP[row];
      if (pattern.count < cap) continue;

      const color = pattern.color;
      const col = WALL_COLOR[row].indexOf(color);
      if (col < 0 || seat.wall[row][col] !== EMPTY) {
        // 规则上不可达；真到了这里说明引擎状态被打坏，宁可报出来也别静默吞掉。
        throw new Error(`玩家 ${seat.seat + 1} 第 ${row + 1} 行结算异常：颜色 ${color} 无对应墙位`);
      }

      seat.wall[row][col] = color;
      const points = scorePlacement(seat.wall, row, col);
      seat.score += points;

      events.push({
        type: 'tile-wall',
        seat: seat.seat,
        row,
        col,
        color,
        points,
        score: seat.score,
      });

      // 完整行只把「最右那一块」送上墙，其余砖全部回到盒盖（discard）。
      // 少写这一句，账面上每结算一条完整行就会凭空蒸发 cap-1 块砖。
      for (let i = 1; i < cap; i += 1) next.discard.push(color);
      pattern.color = null;
      pattern.count = 0;
    }

    if (seat.floor.length > 0) {
      const tiles = [...seat.floor];
      const penalty = tiles.reduce((sum, _tile, index) => sum + Math.abs(FLOOR_PENALTY[index] ?? 0), 0);
      seat.score = Math.max(0, seat.score - penalty);
      next.discard.push(...tiles.filter((tile) => tile !== FIRST_TOKEN));
      seat.floor = [];
      events.push({ type: 'floor-penalty', seat: seat.seat, tiles, penalty, score: seat.score });
    }
  }

  const finished = next.seats.some((seat) => seat.wall.some((row) => row.every((cell) => cell !== EMPTY)));
  if (finished) {
    finalScoring(next, events);
    return { state: next, events };
  }

  next.phase = 'prepare';
  events.push({ type: 'round-end', round: next.round, nextFirstSeat: next.nextFirst ?? next.firstSeat });
  return { state: next, events };
}

/* ------------------------------------------------------------------ *
 * 视图导出
 * ------------------------------------------------------------------ */

/** 供观战界面渲染的完整快照（花砖物语是完全信息游戏）。 */
export function snapshot(state) {
  return {
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    playerCount: state.playerCount,
    firstSeat: state.firstSeat,
    moveCount: state.moveCount,
    over: state.over,
    ranking: state.ranking,
    wallColor: WALL_COLOR,
    factories: state.factories.map((tiles) => [...tiles]),
    center: [...state.center],
    centerFirst: state.centerFirst,
    bagCount: state.bag.length,
    discardCount: state.discard.length,
    seats: state.seats.map((seat) => ({
      seat: seat.seat,
      name: seat.name,
      score: seat.score,
      floor: [...seat.floor],
      pattern: seat.pattern.map((pattern) => ({ color: pattern.color, count: pattern.count })),
      wall: seat.wall.map((row) => [...row]),
      bonus: seat.bonus,
    })),
  };
}

/** 袋内颜色分布（可数信息，脚本有权知道）。 */
function bagColorCounts(state) {
  const counts = Array(COLORS).fill(0);
  for (const tile of state.bag) counts[tile] += 1;
  return counts;
}

/**
 * 交给 AI 脚本的视图。花砖物语除袋中顺序外无隐藏信息，
 * 因此这里给的是「一个记性好的玩家能掌握的一切」。
 */
export function viewFor(state, seat) {
  return {
    ...snapshot(state),
    mySeat: seat,
    myTurn: state.turn === seat,
    bagColors: bagColorCounts(state),
    moves: state.turn === seat ? legalMoves(state) : [],
  };
}

/** 把行动翻译成人类可读的一句，用于事件日志。 */
export function describeMove(state, move) {
  const seat = state.seats[state.turn];
  const origin = move.source === 'center' ? '中央区' : `工厂 #${move.index + 1}`;
  const colorName = ['蓝', '黄', '红', '黑', '白'][move.color];
  const target = move.line === -1 ? '地板区' : `第 ${move.line + 1} 行`;
  return `${seat.name} 从${origin}取走全部${colorName}砖 → ${target}`;
}

/** 全量守恒校验：砖块总数必须恒为 100。测试与批量对局都用它兜底。 */
export function auditTiles(state) {
  const counter = Array(COLORS).fill(0);
  const add = (tile) => {
    if (tile === FIRST_TOKEN) return;
    if (!Number.isInteger(tile) || tile < 0 || tile >= COLORS) {
      throw new Error(`出现越界砖块值：${tile}`);
    }
    counter[tile] += 1;
  };

  state.bag.forEach(add);
  state.discard.forEach(add);
  state.factories.forEach((tiles) => tiles.forEach(add));
  state.center.forEach(add);
  for (const seat of state.seats) {
    seat.floor.forEach(add);
    for (const pattern of seat.pattern) {
      if (pattern.count > 0) {
        if (!Number.isInteger(pattern.color)) throw new Error('图案行有砖但没有颜色');
        for (let i = 0; i < pattern.count; i += 1) add(pattern.color);
      }
    }
    for (const row of seat.wall) {
      for (const cell of row) if (cell !== EMPTY) add(cell);
    }
  }

  const total = counter.reduce((sum, n) => sum + n, 0);
  if (total !== TOTAL_TILES) {
    throw new Error(`砖块总数 ${total} ≠ ${TOTAL_TILES}（分布 ${counter.join('/')}）`);
  }
  return counter;
}
