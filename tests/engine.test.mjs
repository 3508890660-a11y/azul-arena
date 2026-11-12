import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMove,
  auditTiles,
  canPlaceInLine,
  createGame,
  legalMoves,
  resolveRound,
  snapshot,
  startNextRound,
} from '../src/engine.js';
import { EMPTY, FACTORY_COUNT_BY_PLAYERS, PATTERN_CAP, TOTAL_TILES } from '../src/rules.js';

function blankState(playerCount = 4) {
  return {
    playerCount,
    seed: 1,
    rng: 1,
    bag: [],
    discard: [],
    factories: [],
    center: [],
    centerFirst: true,
    seats: Array.from({ length: playerCount }, (_, seat) => ({
      seat,
      name: `P${seat + 1}`,
      score: 0,
      floor: [],
      pattern: PATTERN_CAP.map(() => ({ color: null, count: 0 })),
      wall: Array.from({ length: 5 }, () => Array(5).fill(EMPTY)),
      bonus: null,
    })),
    turn: 0,
    firstSeat: 0,
    nextFirst: null,
    round: 1,
    phase: 'tiling',
    moveCount: 0,
    over: false,
    ranking: [],
  };
}

function fillPattern(state, seat, line, color, count) {
  const pattern = state.seats[seat].pattern[line];
  pattern.color = color;
  pattern.count = count;
}

/* ------------------------------------------------------------------ */

test('建局：工厂数量与用砖数符合人数规则', () => {
  for (const playerCount of [2, 3, 4]) {
    const { state } = createGame({ playerCount, seed: 7 });
    const factories = FACTORY_COUNT_BY_PLAYERS[playerCount];
    assert.equal(state.factories.length, factories);
    for (const tiles of state.factories) assert.equal(tiles.length, 4);
    assert.equal(state.bag.length, TOTAL_TILES - factories * 4);
    assert.equal(state.turn, state.firstSeat);
    assert.equal(state.phase, 'draft');
    auditTiles(state);
  }
});

test('取砖：工厂剩余砖全部滑入中央区', () => {
  const { state } = createGame({ playerCount: 4, seed: 11 });
  const first = state.factories[0];
  const color = first[0];
  const sameColor = first.filter((tile) => tile === color).length;
  const rest = first.length - sameColor;

  const before = state.center.length;
  const next = applyMove(state, { source: 'factory', index: 0, color, line: -1 }).state;

  assert.equal(next.factories[0].length, 0);
  assert.equal(next.center.length, before + rest);
  assert.equal(next.seats[0].floor.length, sameColor);
  auditTiles(next);
});

test('首次从中央取砖会拿到起始玩家标记并压在地板区首格', () => {
  let { state } = createGame({ playerCount: 3, seed: 5 });
  state = { ...state, center: [0, 0, 1], centerFirst: true };
  const next = applyMove(state, { source: 'center', index: -1, color: 0, line: -1 }).state;

  assert.equal(next.centerFirst, false);
  assert.equal(next.nextFirst, 0);
  // 标记占首格，随后 2 块蓝砖依次压上去
  assert.deepEqual(next.seats[0].floor, [-1, 0, 0]);
  assert.equal(next.center.length, 1);
});

test('图案行三条硬约束', () => {
  const state = blankState(2);
  const seat = state.seats[0];

  // 空行可放
  assert.equal(canPlaceInLine(seat, 0, 2), true);

  // 混色不可放
  fillPattern(state, 0, 2, 1, 1);
  assert.equal(canPlaceInLine(seat, 2, 2), false);
  assert.equal(canPlaceInLine(seat, 2, 1), true);

  // 墙面已有该色则不可放
  seat.wall[2][2] = 2;
  assert.equal(canPlaceInLine(seat, 2, 2), false);

  // 行满则不可放
  fillPattern(state, 0, 0, 3, 1);
  assert.equal(canPlaceInLine(seat, 0, 3), false);
});

test('放置：多余砖块溢出到地板区', () => {
  const state = blankState(2);
  state.phase = 'draft';
  state.factories = [[1, 1, 1, 1]];

  const next = applyMove(state, { source: 'factory', index: 0, color: 1, line: 1 }).state;
  assert.deepEqual(next.seats[0].pattern[1], { color: 1, count: 2 });
  assert.equal(next.seats[0].floor.length, 2);
  assert.equal(next.seats[0].floor.every((tile) => tile === 1), true);
});

test('计分：孤立 1 分，水平连成 3 分', () => {
  const lonely = blankState(2);
  fillPattern(lonely, 0, 1, 0, 2);
  const lonelyResult = resolveRound(lonely).state;
  // WALL_COLOR[1] = [白, 蓝, 黄, 红, 黑] → 蓝在 col 1
  assert.equal(lonelyResult.seats[0].wall[1][1], 0);
  assert.equal(lonelyResult.seats[0].score, 1);

  const linked = blankState(2);
  linked.seats[0].wall[1][0] = 4;
  linked.seats[0].wall[1][2] = 1;
  fillPattern(linked, 0, 1, 0, 2);
  const linkedResult = resolveRound(linked).state;
  assert.equal(linkedResult.seats[0].score, 3);
});

test('计分：十字交叉按横竖两段相加', () => {
  const state = blankState(2);
  // (2,2) 是蓝；先铺上下左右，再放中心 → 横 3 + 竖 3 = 6
  state.seats[0].wall[2][1] = 4;
  state.seats[0].wall[2][3] = 1;
  state.seats[0].wall[1][2] = 3;
  state.seats[0].wall[3][2] = 2;
  fillPattern(state, 0, 2, 0, 3);

  const result = resolveRound(state).state;
  assert.equal(result.seats[0].wall[2][2], 0);
  assert.equal(result.seats[0].score, 6);
});

test('地板罚分：-1 -1 -2 -2 -2 -3 -3，且总分不为负', () => {
  const state = blankState(2);
  state.seats[0].floor = [0, 1, 2, 3, 4, 0, 1];
  state.seats[0].score = 3;
  const result = resolveRound(state).state;
  // 1+1+2+2+2+3+3 = 14
  assert.equal(result.seats[0].score, 0);
  assert.equal(result.seats[0].floor.length, 0);
  assert.equal(result.discard.length, 7);
});

test('整行补满即终局，并追加行/列/同色奖励', () => {
  const state = blankState(2);
  const wall = state.seats[0].wall;
  // 第 0 行补最后一块：先填 col 1..4
  for (let col = 1; col < 5; col += 1) wall[0][col] = [1, 2, 3, 4][col - 1];
  fillPattern(state, 0, 0, 0, 1);
  state.seats[0].score = 0;

  const result = resolveRound(state).state;
  assert.equal(result.over, true);
  assert.equal(result.phase, 'over');

  const seat = result.seats[0];
  // 放置瞬间：整行 5 连 = 5 分
  // 终局：1 行 ×2，0 列，调色板未齐（只 1 色齐？第 0 行恰好五色，但其他行为空，不算列/同色）
  assert.equal(seat.wall[0].every((cell) => cell !== EMPTY), true);
  assert.equal(seat.bonus.rows, 1);
  assert.equal(seat.bonus.columns, 0);
  assert.equal(seat.score, 5 + 2);
});

test('随机跑完整局：全程砖块守恒 100 块', () => {
  let rngState = 12345;
  const rand = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };

  const tally = Array(5).fill(0);
  for (let game = 0; game < 6; game += 1) {
    const playerCount = 2 + (game % 3);
    let { state } = createGame({ playerCount, seed: 1000 + game });
    let guard = 0;

    while (!state.over && guard < 4000) {
      guard += 1;
      if (state.phase === 'draft') {
        const moves = legalMoves(state);
        assert.ok(moves.length > 0, '轮到自己时必须有合法行动');
        const move = moves[Math.floor(rand() * moves.length)];
        state = applyMove(state, move).state;
      } else if (state.phase === 'tiling') {
        state = resolveRound(state).state;
      } else if (state.phase === 'prepare') {
        state = startNextRound(state).state;
      } else {
        break;
      }
      auditTiles(state);
    }

    assert.equal(state.over, true, `第 ${game} 局没有正常结束`);
    assert.ok(guard < 4000, '对局步数失控');
    for (const seat of state.seats) {
      assert.ok(seat.score >= 0, '分数不得为负');
      tally[seat.seat] += seat.score;
    }
  }

  assert.ok(tally.some((value) => value > 0), '对局应当产生正分');
});

test('快照不泄漏袋中顺序，只暴露数量', () => {
  const { state } = createGame({ playerCount: 4, seed: 21 });
  const snap = snapshot(state);
  assert.equal(typeof snap.bagCount, 'number');
  assert.equal(snap.bagColors, undefined);
  assert.equal(JSON.stringify(snap).includes('"bag":'), false);
});

test('同 seed 完全可复现', () => {
  const run = () => {
    let { state } = createGame({ playerCount: 3, seed: 999 });
    let guard = 0;
    while (!state.over && guard < 3000) {
      guard += 1;
      if (state.phase === 'draft') {
        const moves = legalMoves(state);
        state = applyMove(state, moves[0]).state;
      } else if (state.phase === 'tiling') {
        state = resolveRound(state).state;
      } else if (state.phase === 'prepare') {
        state = startNextRound(state).state;
      } else break;
    }
    return state.seats.map((seat) => seat.score).join(',');
  };

  assert.equal(run(), run());
});
