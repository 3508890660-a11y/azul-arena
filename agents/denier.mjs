import { evaluateOutcome, opponentNeed, takenCount } from './_lib.mjs';

/**
 * 搅局型：花砖物语的胜负常常不由「你拿了多少」决定，而由「你让对手拿不到什么」决定。
 * 它会为了断掉对手正在憋的大行，去吃自己并不需要的颜色，甚至白扣几分。
 */
export default {
  id: 'denier',
  name: '断供者',
  tag: '进攻',
  description: '主动吃掉对手正在囤的颜色，宁可自己吃点亏也要掐断别人的大行。',
  modes: [2, 3, 4],
  create({ rng }) {
    return {
      chooseMove(view, moves) {
        if (!moves.length) return null;

        let best = moves[0];
        let bestValue = -Infinity;

        for (const move of moves) {
          const outcome = evaluateOutcome(view, move);
          const taken = takenCount(view, move);

          // 抓得越多、对手越渴，断供效果越强；从中央抓等于全场通吃
          const need = opponentNeed(view, move.color);
          const scope = move.source === 'center' ? 1.35 : 1;
          let value = outcome.gain + need * taken * 0.42 * scope;

          // 自己完全用不上的颜色还硬吃，是被支配的行为，轻罚一下
          if (move.line === -1) value -= 1.2;

          // 拿到首标记顺带赚一点先手权（下轮第一个挑工厂）
          if (move.source === 'center' && view.centerFirst) value += 0.55;

          if (value > bestValue + 1e-9) {
            bestValue = value;
            best = move;
          } else if (Math.abs(value - bestValue) < 1e-9 && rng() < 0.35) {
            best = move;
          }
        }

        return best;
      },
    };
  },
};
