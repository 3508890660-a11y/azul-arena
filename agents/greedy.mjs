import { evaluateOutcome } from './_lib.mjs';

/**
 * 只看眼前的算法：把每一步的「上墙分 − 地板罚分」算出来，取最大值。
 * 没有终局概念，也不管对手。强于随机，但会被长线布局型玩家反超。
 */
export default {
  id: 'greedy',
  name: '即时收益',
  tag: '入门',
  description: '逐步最大化「上墙得分 − 地板扣分」，不看终局也不看对手。',
  modes: [2, 3, 4],
  create({ rng }) {
    return {
      chooseMove(view, moves) {
        if (!moves.length) return null;

        let best = moves[0];
        let bestValue = -Infinity;
        for (const move of moves) {
          const { gain } = evaluateOutcome(view, move);
          if (gain > bestValue + 1e-9) {
            bestValue = gain;
            best = move;
          } else if (Math.abs(gain - bestValue) < 1e-9 && rng() < 0.4) {
            best = move;
          }
        }
        return best;
      },
    };
  },
};
