# 12 模型对战脚本清单

生成时间：2026-11-12　契约：`agents/models/_CONTRACT.md`

每个脚本由不同模型独立生成，单文件自包含，只依赖契约里定义的接口。
`modes` 声明它负责的对战人数——2/3/4 人各 4 个脚本。

## 清单

| # | 模型 | 请求 modelId | 脚本 | id | 策略 | 模式 | 战绩 |
|---|---|---|---|---|---|---|---|
| 1 | hy3 | `hy3` | `hy3.mjs` | `hy3` | 先手锁喉 | 2 人 | 22/36 胜（61%，均分 52.1） |
| 2 | GLM5.3flash | `glm-5.3-flash` | `glm53flash.mjs` | `glm53flash` | 速攻终局 | 2 人 | 19/36 胜（53%，均分 53.9） |
| 3 | hy4 | `hy4std` | `hy4.mjs` | `hy4` | 零溢效率流 | 2 人 | 16/36 胜（44%，均分 56.4） |
| 4 | GLM5.3 | `glm-5.3` | `glm53.mjs` | `glm53` | 颜色垄断 | 2 人 | 15/36 胜（42%，均分 51.5） |
| 5 | MiniMax M3.1flash | `minimax-m3.1-flash` | `minimaxm31flash.mjs` | `minimaxm31flash` | 地板压制 | 3 人 | 22/36 胜（61%，均分 61.9） |
| 6 | KIMI 2.8preview | `kimi-k2.8-preview` | `kimi28preview.mjs` | `kimi28preview` | 嗅探捡漏 | 3 人 | 15/36 胜（42%，均分 56.8） |
| 7 | KIMI 3.1pro | `kimi-k3.1-pro` | `kimi31pro.mjs` | `kimi31pro` | 双线交叉 | 3 人 | 7/36 胜（19%，均分 51.4） |
| 8 | MiniMax M3 | `minimax-m3-pay` | `minimaxm3.mjs` | `minimaxm3` | 中线平衡 | 3 人 | 4/36 胜（11%，均分 47.6） |
| 9 | MIMO-v2.6-pro | `mimo-v2.6-pro` | `mimov26pro.mjs` | `mimov26pro` | 反制搅局流 | 4 人 | 16/40 胜（40%，均分 64.8） |
| 10 | deepseek v4.1flash | `deepseek-v4.1-flash` | `deepseekv41flash.mjs` | `deepseekv41flash` | 终局收割 | 4 人 | 11/40 胜（28%，均分 62.4） |
| 11 | step5preview | `step-5-preview` | `step5preview.mjs` | `step5preview` | 节奏控制 | 4 人 | 9/40 胜（23%，均分 61） |
| 12 | deepseek v4pro | `deepseek-v4-pro` | `deepseekv4pro.mjs` | `deepseekv4pro` | 全局估值 | 4 人 | 4/40 胜（10%，均分 57.3） |

## 按模式分组

**2 人局**（4 个）

| 模型 | 脚本 | 策略名 | 说明 |
|---|---|---|---|
| hy3 | `hy3.mjs` | 先手锁喉 | 2人局专攻回合控制：抢起始标记保先手，断供对手并严控地板罚分。 |
| GLM5.3flash | `glm53flash.mjs` | 速攻终局 | 以最短图案行最快上墙压缩轮次，抢断对手急需砖色，严控地板罚分；领先或对手未铺开时果断补满整行触发终局。 |
| hy4 | `hy4.mjs` | 零溢效率流 | 两人局极简效率流：算清取砖数与行容量，零溢出、避地板，短行快速上墙，浅地板时抢先手断供，宁可少取绝不浪费。 |
| GLM5.3 | `glm53.mjs` | 颜色垄断 | 两人局砖源极稀缺：锁定两三种专精色，铺墙集色的同时吃干场上该色，断对手供给。 |

**3 人局**（4 个）

| 模型 | 脚本 | 策略名 | 说明 |
|---|---|---|---|
| MiniMax M3.1flash | `minimaxm31flash.mjs` | 地板压制 | 3 人局专攻地板压制：抽走对手图案行的配套色断其补齐，把无家可归的砖逼他吃下，自己死守地板不踩 -3，锁列追终局奖励。 |
| KIMI 2.8preview | `kimi28preview.mjs` | 嗅探捡漏 | 三人局机会主义：嗅探布局/抢分/收尾三期动态换权重，盯最危险对手的补行信号切阻断，专捡中央区大份同色漏。 |
| KIMI 3.1pro | `kimi31pro.mjs` | 双线交叉 | 长期锁定双列与双行，优先抢占交叉砖位，并按最危险对手实施定向断供与中央控制。 |
| MiniMax M3 | `minimaxm3.mjs` | 中线平衡 | 3人局专用：即时得分、终局布局、断供对手三条线显式加权，按分差动态调权，落后抢分断供，领先压地板防喂色。 |

**4 人局**（4 个）

| 模型 | 脚本 | 策略名 | 说明 |
|---|---|---|---|
| MIMO-v2.6-pro | `mimov26pro.mjs` | 反制搅局流 | 四人局反制专家：按危险度锁定领先者，抢其待补之色、以死色污染中央；自己领先即转保守布局，兼顾终局行列色奖励。 |
| deepseek v4.1flash | `deepseekv41flash.mjs` | 终局收割 | 四人局布局流：开局锁定两列一色，每步核算离 +7/+10 还差几格，肯为终局奖励吃地板、让小上墙，末轮全力收割。 |
| step5preview | `step5preview.mjs` | 节奏控制 | 四人局专精：每手先估算本轮剩余手数，轮初激进抢工厂、短行快变现追终局连击，轮末保守小口取砖拖轮，留垃圾砖在中央区逼三对手吃地板。 |
| deepseek v4pro | `deepseekv4pro.mjs` | 全局估值 | 四人局全局估值：每手拆成上墙即时分、未来上墙概率乘终局奖励份额、地板扣分与阻塞收益，重列重色、控溢出、抢先手。 |

## 接口约定

```js
export default {
  id: 'hy4',                 // 唯一标识
  name: '粒粒归仓',           // 观战界面显示
  tag: '专精',
  model: 'hy4',             // 产出它的模型
  modes: [2],               // 负责的对战人数
  strategy: '零溢效率流',
  description: '一句话说明',
  create(ctx) {             // ctx: seat / playerCount / seed / rng / log
    return {
      chooseMove(view, moves) { return moves[0]; },   // 返回 moves 里的一项
    };
  },
};
```

合法性由引擎保证：`moves` 里出现的一定合法，不出现的一定非法。脚本不需要自己判规则。

## 复现方式

```bash
# 单个脚本自检（会真的打完整局）
node tools/check-agent.mjs agents/models/hy4.mjs 2

# 同模式循环赛
node tools/roundrobin.mjs --players 2 --games 12 --ids hy4,hy3,glm53,glm53flash
node tools/roundrobin.mjs --players 3 --games 12 --ids minimaxm3,minimaxm31flash,kimi31pro,kimi28preview
node tools/roundrobin.mjs --players 4 --games 40 --ids deepseekv41flash,deepseekv4pro,step5preview,mimov26pro
```
