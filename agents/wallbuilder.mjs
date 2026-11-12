import {
  colFilled,
  colorPlaced,
  evaluateOutcome,
  rowFilled,
  targetCol,
} from './_lib.mjs';

/**
 * 布局型：不追单步最高分，而是把砖往「能连成整行整列」的位置上推。
 * 它眼里真正的分数是终局那 +2/+7/+10，即时分只是路费。
 */
export default {
  id: 'wallbuilder',
  name: '墙面建筑师',
  tag: '稳健',
  description: '以完整行/列/同色为目标铺路，愿意为终局奖励吃一点即时亏损。',
  modes: [2, 3, 4],
  create({ rng }) {
    return {
      chooseMove(view, moves) {
        if (!moves.length) return null;
        const me = view.seats[view.mySeat];

        let best = moves[0];
        let bestValue = -Infinity;

        for (const move of moves) {
          const outcome = evaluateOutcome(view, move);
          let value = outcome.gain;

          if (move.line >= 0) {
            const col = targetCol(view.wallColor, move.line, move.color);
            const emptySlot = col >= 0 && me.wall[move.line][col] === -1;

            if (emptySlot) {
              const rowDone = rowFilled(me, move.line);
              const colDone = colFilled(me, col);
              // 行列越接近完工，这块砖越值钱；差一格时给足溢价
              value += rowDone * 0.55 + (rowDone >= 3 ? 1.6 : 0);
              value += colDone * 0.85 + (colDone >= 3 ? 2.4 : 0);

              // 同色集齐：+10 是全场最大的单笔奖励
              const placed = colorPlaced(me, move.color);
              value += placed * 0.5 + (placed >= 3 ? (placed - 2) * 1.4 : 0);
            }

            // 长行优先：把砖塞进第 4、5 行是通往终局的正路
            if (outcome.completes) value += 0.35 * (move.line + 1);
          } else {
            // 布局型极端厌恶把砖倒进地板
            value -= 1.8 + 0.4 * outcome.taken;
          }

          if (value > bestValue + 1e-9) {
            bestValue = value;
            best = move;
          } else if (Math.abs(value - bestValue) < 1e-9 && rng() < 0.3) {
            best = move;
          }
        }

        return best;
      },
    };
  },
};
