/**
 * AI 脚本契约 v1
 * ============================================================================
 * 一个脚本就是一个 ES 模块，默认导出下面这个形状的对象：
 *
 *   export default {
 *     id: 'random',                 // 唯一标识（建议与文件名一致）
 *     name: '随机漫步',              // 观战界面显示的名字
 *     tag: '基线',                   // 可选：入门 / 稳健 / 进攻 / 进阶 / 基线
 *     description: '一句话说明',      // 可选：显示在选人面板
 *     modes: [2, 3, 4],             // 支持的对战人数（2/3/4）
 *     create(ctx) {                  // 每局调用一次，返回决策器
 *       return {
 *         chooseMove(view, moves) {
 *           return moves[0];         // 必须返回 moves 里的一项
 *         },
 *       };
 *     },
 *   };
 *
 * ctx（对局内不变）
 *   seat         自己的座位号 0..n-1
 *   playerCount  人数 2/3/4
 *   seed         本局种子
 *   rng()        [0,1) 随机数，种子化，同 seed 可复现
 *   log(...)     写一行日志到观战界面（别刷屏）
 *
 * view（每次决策都重新给，只读）
 *   mySeat, myTurn
 *   phase        'draft' | 'tiling' | 'over'
 *   round        当前轮次，从 1 开始
 *   turn         轮到谁
 *   firstSeat    本轮首玩家
 *   factories    [[颜色号...], ...] 每个工厂圆盘的砖，空盘是 []
 *   center       [颜色号...] 中央区
 *   centerFirst  起始玩家标记是否还在中央
 *   bagCount     袋中砖数
 *   bagColors    [5] 袋中各色数量（完全信息游戏，可数）
 *   discardCount 盒盖上的弃砖数
 *   wallColor    [5][5] 墙面颜色布局，wallColor[row][col] 是颜色号
 *   seats        [{ seat, name, score, floor, pattern, wall, bonus }]
 *                pattern[row] = { color, count }，count 是已放砖数
 *                wall[row][col] = 颜色号，-1 表示空
 *                floor = [颜色号...]，-1 表示起始玩家标记
 *   moves        当前合法行动（只有轮到自己时非空）
 *
 * move（行动）
 *   { source: 'factory' | 'center', index, color, line }
 *     index  工厂下标；从中央取时固定 -1
 *     color  颜色号 0..4（蓝 黄 红 黑 白）
 *     line   图案行 0..4；-1 表示整批弃到地板区
 *
 * 运行环境
 *   脚本跑在独立的 worker 线程里，看不见主进程，也改不了引擎状态。
 *   返回值非法、抛异常、超时（默认 900ms）都会触发兜底策略并记一条警告，
 *   对局不会中断。
 * ============================================================================
 */

export default {
  id: 'random',
  name: '随机漫步',
  tag: '基线',
  description: '在合法行动里均匀随机，作为其他策略的对照组。',
  modes: [2, 3, 4],
  create({ rng }) {
    return {
      chooseMove(_view, moves) {
        if (!moves.length) return null;
        return moves[Math.floor(rng() * moves.length)];
      },
    };
  },
};
