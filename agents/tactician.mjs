import {
  colFilled,
  colorPlaced,
  evaluateOutcome,
  floorDamage,
  opponentNeed,
  rowFilled,
  targetCol,
  takenCount,
} from './_lib.mjs';

/**
 * 综合型：把「自己得分 / 终局布局 / 断供对手 / 先手权 / 浪费」压成一条式子。
 * 思路接近熟练人类玩家——先算这一手值多少，再算它给对手留下什么。
 */
export default {
  id: 'tactician',
  name: '棋手',
  tag: '进阶',
  description: '同时权衡即时得分、终局布局、断供价值与先手权，风格最接近熟练人类。',
  modes: [2, 3, 4],
  create({ rng }) {
    const WEIGHTS = {
      layoutRow: 0.5,
      layoutCol: 0.8,
      layoutColor: 0.45,
      nearRow: 1.5,
      nearCol: 2.2,
      deny: 0.34,
      firstToken: 0.7,
      waste: 0.42,
      longLine: 0.4,
    };

    function actionValue(view, move) {
      const me = view.seats[view.mySeat];
      const outcome = evaluateOutcome(view, move);
      let value = outcome.gain;

      if (move.line === -1) {
        // 全丢地板只在「反正放不进去」时才可接受
        return value - 1.5 - WEIGHTS.waste * outcome.taken;
      }

      const col = targetCol(view.wallColor, move.line, move.color);
      const emptySlot = col >= 0 && me.wall[move.line][col] === -1;

      if (emptySlot) {
        const rowsDone = rowFilled(me, move.line);
        const colsDone = colFilled(me, col);
        const colorsDone = colorPlaced(me, move.color);

        value += rowsDone * WEIGHTS.layoutRow + (rowsDone >= 3 ? WEIGHTS.nearRow : 0);
        value += colsDone * WEIGHTS.layoutCol + (colsDone >= 3 ? WEIGHTS.nearCol : 0);
        value += colorsDone * WEIGHTS.layoutColor;
      }

      if (outcome.completes) {
        value += WEIGHTS.longLine * (move.line + 1);
        // 补满第 5 行还意味着逼对手替你把这一轮拖长
        if (move.line === 4) value += 0.5;
      }

      // 断供：抓走对手正在囤的色
      const taken = takenCount(view, move);
      const scope = move.source === 'center' ? 1.3 : 1;
      value += opponentNeed(view, move.color) * taken * WEIGHTS.deny * scope;

      // 首手标记：-1 分的代价换下轮先挑，通常在 0.5~1 分之间划算
      if (move.source === 'center' && view.centerFirst) {
        value += WEIGHTS.firstToken;
        value -= Math.abs(floorDamage(me.floor.length, 0));
      }

      return value;
    }

    return {
      chooseMove(view, moves) {
        if (!moves.length) return null;

        let best = moves[0];
        let bestValue = -Infinity;

        for (const move of moves) {
          let value = actionValue(view, move);

          // 同分时优先「抓得多」和「行更长」，让行为更稳定可读
          if (move.line >= 0) value += 0.02 * (move.line + 1);
          value += 0.01 * takenCount(view, move);

          if (value > bestValue + 1e-9) {
            bestValue = value;
            best = move;
          } else if (Math.abs(value - bestValue) < 1e-9 && rng() < 0.25) {
            best = move;
          }
        }

        return best;
      },
    };
  },
};
