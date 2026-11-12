const FLOOR_COST = [1, 1, 2, 2, 2, 3, 3];

function floorCost(count) {
  let cost = 0;
  const n = Math.min(7, Math.max(0, count));
  for (let i = 0; i < n; i += 1) cost += FLOOR_COST[i];
  return cost;
}

function colorCount(tiles, color) {
  let count = 0;
  for (const tile of tiles) if (tile === color) count += 1;
  return count;
}

function lineScore(wall, row, col) {
  let horizontal = 1;
  let vertical = 1;
  for (let c = col - 1; c >= 0 && wall[row][c] !== -1; c -= 1) horizontal += 1;
  for (let c = col + 1; c < 5 && wall[row][c] !== -1; c += 1) horizontal += 1;
  for (let r = row - 1; r >= 0 && wall[r][col] !== -1; r -= 1) vertical += 1;
  for (let r = row + 1; r < 5 && wall[r][col] !== -1; r += 1) vertical += 1;
  return (horizontal > 1 ? horizontal : 0) + (vertical > 1 ? vertical : 0) || 1;
}

export default {
  id: 'kimi31pro',
  name: '双轨织墙',
  tag: '专精',
  model: 'KIMI 3.1pro',
  modes: [3],
  strategy: '双线交叉',
  description: '长期锁定双列与双行，优先抢占交叉砖位，并按最危险对手实施定向断供与中央控制。',

  create(ctx) {
    // 长期计划只初始化一次；后续每步沿用，不随短期砖价摇摆。
    const plan = {
      ready: false,
      cols: [1, 3],
      rows: [0, 3],
      colOf: [],
      crosses: new Set(),
    };
    let decisions = 0;

    function initPlan(view) {
      plan.colOf = Array.from({ length: 5 }, () => Array(5).fill(-1));
      for (let row = 0; row < 5; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          plan.colOf[row][view.wallColor[row][col]] = col;
        }
      }
      for (const row of plan.rows) {
        for (const col of plan.cols) plan.crosses.add(`${row}:${col}`);
      }
      plan.ready = true;
    }

    function directionCount(row, col) {
      return (plan.rows.includes(row) ? 1 : 0) + (plan.cols.includes(col) ? 1 : 0);
    }

    function wallFilled(wall) {
      let filled = 0;
      for (const row of wall) {
        for (const cell of row) if (cell !== -1) filled += 1;
      }
      return filled;
    }

    function opponentThreat(player) {
      let threat = player.score;
      for (let row = 0; row < 5; row += 1) {
        let rowCount = 0;
        for (let col = 0; col < 5; col += 1) {
          if (player.wall[row][col] !== -1) {
            threat += 1.15;
            rowCount += 1;
          }
        }
        if (rowCount >= 3) threat += (rowCount - 2) * 2.2;
        const pattern = player.pattern[row];
        if (pattern.count > 0) threat += pattern.count / (row + 1) * 1.8;
      }
      for (let col = 0; col < 5; col += 1) {
        let count = 0;
        for (let row = 0; row < 5; row += 1) if (player.wall[row][col] !== -1) count += 1;
        if (count >= 2) threat += count * count * 0.75;
      }
      return threat;
    }

    function colorDemand(player, color) {
      let best = 0.1;
      for (let row = 0; row < 5; row += 1) {
        const col = plan.colOf[row][color];
        if (col < 0 || player.wall[row][col] !== -1) continue;
        const pattern = player.pattern[row];
        if (pattern.count > 0 && pattern.color !== color) continue;
        const capacity = row + 1;
        const missing = capacity - pattern.count;
        let value = 1 + 0.3 * missing;
        if (pattern.count > 0) value += 2.2 + pattern.count * 0.8;
        if (missing === 1) value += 3.8 + lineScore(player.wall, row, col) * 0.45;
        if (row >= 3 && pattern.count > 0) value += 0.8;
        if (value > best) best = value;
      }
      return best;
    }

    function bestDemand(player, tiles) {
      let best = 0;
      for (let color = 0; color < 5; color += 1) {
        if (colorCount(tiles, color) > 0) best = Math.max(best, colorDemand(player, color));
      }
      return best;
    }

    function finalBonus(wall, extraRow = -1, extraCol = -1) {
      const filled = (row, col) => wall[row][col] !== -1 || (row === extraRow && col === extraCol);
      let bonus = 0;
      for (let row = 0; row < 5; row += 1) {
        let full = true;
        for (let col = 0; col < 5; col += 1) if (!filled(row, col)) full = false;
        if (full) bonus += 2;
      }
      for (let col = 0; col < 5; col += 1) {
        let full = true;
        for (let row = 0; row < 5; row += 1) if (!filled(row, col)) full = false;
        if (full) bonus += 7;
      }
      for (let color = 0; color < 5; color += 1) {
        let count = 0;
        for (let row = 0; row < 5; row += 1) {
          const col = plan.colOf[row][color];
          if (col >= 0 && filled(row, col)) count += 1;
        }
        if (count === 5) bonus += 10;
      }
      return bonus;
    }

    function evaluateMove(view, move, me, rankedOpponents, nextSeat) {
      const sourceTiles = move.source === 'factory' ? view.factories[move.index] : view.center;
      const taken = colorCount(sourceTiles, move.color);
      const marker = move.source === 'center' && view.centerFirst ? 1 : 0;
      const oldFloorCost = floorCost(me.floor.length);
      let placed = 0;
      let overflow = taken;
      let completes = false;
      let wallRow = -1;
      let wallCol = -1;
      let immediate = 0;
      let newBonus = 0;
      let oldBonus = 0;

      if (move.line >= 0) {
        const pattern = me.pattern[move.line];
        const capacity = move.line + 1;
        const space = capacity - pattern.count;
        placed = Math.min(space, taken);
        overflow = Math.max(0, taken - placed);
        completes = pattern.count + placed === capacity;
        wallRow = move.line;
        wallCol = plan.colOf[wallRow][move.color];
        if (completes && wallCol >= 0) {
          immediate = lineScore(me.wall, wallRow, wallCol);
          oldBonus = finalBonus(me.wall);
          newBonus = finalBonus(me.wall, wallRow, wallCol);
        }
      }

      const floorDelta = floorCost(me.floor.length + overflow + marker) - oldFloorCost;
      const filled = wallFilled(me.wall);
      const endWeight = 1 + Math.min(1.25, Math.max(0, filled - 6) / 12 + (view.round - 1) * 0.035);
      let value = immediate * 11 + (newBonus - oldBonus) * 8 * endWeight - floorDelta * 12;
      value -= overflow * 1.35;

      if (move.line >= 0) {
        const pattern = me.pattern[move.line];
        const directions = wallCol >= 0 ? directionCount(wallRow, wallCol) : 0;
        let planValue = 0;
        if (plan.rows.includes(wallRow)) planValue += 2;
        if (plan.cols.includes(wallCol)) planValue += 7;
        // 单线用途打折，行列交叉点翻倍，避免只追逐眼前填行。
        if (directions === 1) planValue *= 0.65;
        if (directions === 2) planValue *= 2;
        value += placed * (0.45 + planValue * 0.075);
        if (pattern.count > 0) value += placed * 0.75;
        if (completes) {
          value += 2.5 + planValue * endWeight;
          if (directions === 2) value += 3;
          if (placed === taken) value += 1.5;
        }
        if (!completes && placed > 0) value += placed / (move.line + 1) * 1.2;
        if (placed === 0) value -= 4;
      } else {
        value -= taken * 0.45;
      }

      if (marker) {
        const orderPosition = (ctx.seat - view.firstSeat + 3) % 3;
        // 三人局中位最难控制节奏，起始标记对中位价值最高。
        value += orderPosition === 1 ? 23 : 18;
        if (view.round >= 5) value += 3;
      }
      if (move.source === 'center') {
        value += Math.min(3, taken * 0.55);
        if (view.center.length >= 10) value += 1.5;
      }

      const remaining = sourceTiles.filter((color) => color !== move.color);
      const centerPressure = 1 + Math.min(15, view.center.length) / 30;
      for (let i = 0; i < rankedOpponents.length; i += 1) {
        const opponent = rankedOpponents[i];
        // 主要压力集中于最危险者，另一名对手只保留少量权重。
        const pressure = i === 0 ? 1 : 0.18;
        const nextMultiplier = nextSeat === opponent.seat ? 1.25 : 0.7;
        const denial = colorDemand(opponent, move.color);
        value += denial * pressure * (move.source === 'center' ? 1.05 : 0.55);
        if (move.source === 'factory') {
          const exposed = remaining.concat(view.center);
          value -= bestDemand(opponent, exposed) * pressure * nextMultiplier * 0.85 * centerPressure;
        } else if (remaining.length > 0) {
          value -= bestDemand(opponent, remaining) * pressure * nextMultiplier * 0.22;
        }
      }
      if (move.source === 'factory' && remaining.length === 0) value += 1.8;

      if (completes && wallRow >= 0) {
        let rowCount = 0;
        for (let col = 0; col < 5; col += 1) if (me.wall[wallRow][col] !== -1) col === wallCol || (rowCount += 1);
        if (rowCount === 4) {
          const projected = me.score + immediate - floorDelta + newBonus;
          const leader = Math.max(...rankedOpponents.map((opponent) => opponent.score));
          value += projected >= leader ? 14 : -5;
        }
      }
      return value;
    }

    return {
      chooseMove(view, moves) {
        if (!moves || moves.length === 0) return undefined;
        if (!plan.ready) initPlan(view);
        const me = view.seats[ctx.seat];
        const rankedOpponents = view.seats
          .filter((player) => player.seat !== ctx.seat)
          .sort((a, b) => opponentThreat(b) - opponentThreat(a));
        const nextSeat = (view.turn + 1) % 3;
        let best = moves[0];
        let bestValue = -Infinity;
        for (let i = 0; i < moves.length; i += 1) {
          let value = evaluateMove(view, moves[i], me, rankedOpponents, nextSeat);
          // 稳定的微小时序 Tie-break，不改变主策略且保证同 seed 可复现。
          value += ((i * 17 + decisions * 7) % 23) * 0.000001;
          if (Number.isFinite(value) && value > bestValue) {
            bestValue = value;
            best = moves[i];
          }
        }
        decisions += 1;
        return best || moves[0];
      },
    };
  },
};
