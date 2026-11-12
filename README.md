# 花砖物语 · 观战台

《花砖物语》(Azul) 的电子版对局模拟器。**玩家不操作棋子，只写脚本**：给每个座位挑一个 AI，坐下来看它们互相掐。

- 2 / 3 / 4 人对局，规则按官方规则书实现
- 脚本即文件，扔进 `agents/` 就能被识别，不用改引擎
- 观战界面常驻实时推送，可暂停、单步、调速、随时换阵容重开
- 同一 seed 完全可复现，方便做 A/B 对比与回归测试
- 零依赖：只用 Node 内置模块，不需要 `npm install`

---

## 快速开始

```bash
cd azul-arena

node server.mjs          # 默认 4297 端口
# 或者
npm start
```

浏览器打开 <http://localhost:4297> 即可。刷新页面不会丢局面——状态在服务端。

批量跑对局（命令行，不开界面）：

```bash
node cli.mjs --list                                  # 看看有哪些脚本
node cli.mjs --games 1 --verbose                     # 单局逐手打印
node cli.mjs --games 24 --players 4 \
  --agents tactician,wallbuilder,denier,greedy       # 24 局统计胜率
```

跑测试：

```bash
npm test        # 12 项引擎断言
```

---

## 一、规则实现中真正容易错的地方

写之前先把这几条钉死。它们每一条都能让「看起来能跑」的实现悄悄算错分。

| 规则点 | 正确做法 | 常见错法 |
|---|---|---|
| 图案行能放什么颜色 | 只能放**该行墙面尚未出现过的颜色**（`wall[row].includes(color)` 为假） | 以为每行有固定颜色；其实墙每行都含五色，玩家可以把同一颜色放到多条不同行 |
| 图案行怎么填 | 从**右往左**填，砖贴着墙那一侧堆 | 从左往右填，导致「最右一块上墙」时位置对不上 |
| 上墙后剩余砖 | 完整行的砖只上墙 1 块，其余 `cap-1` 块**退回盒盖** | 直接把行清空 —— 账面每结算一行就凭空蒸发几块砖 |
| 地板罚分 | 7 格，`-1 -1 -2 -2 -2 -3 -3`；超出 7 格的部分直接丢盒盖，**不再额外扣分** | 抄成 `-1 -2 -3 -4 -5 -6 -7`（那是别的游戏） |
| 起始玩家标记 | 放下时**立刻**占掉地板区下一个空格并吃这一格的罚分；持有者成为**下一轮**首玩家 | 忘记占格，或直接让它本轮先手 |
| 墙面计分 | 横竖两段分别数：`h>1` 计 `h`，`v>1` 计 `v`，两者都是 1 才计 1 分 | 累加成 `1+h+v`，十字交叉时会多算 2 分 |
| 终局判定 | 有人**补满一整行墙**时，把这一轮走完再结束 | 立刻中断，漏掉同轮其他人的结算 |
| 终局奖励 | 每完整行 +2、每完整列 +7、每集齐一色 +10；平分看完整行数 | 漏掉同色奖励（每行每列都含五色，用 `row.includes(color)` 判断即可） |
| 袋子用完 | 把盒盖上的弃砖洗回袋里继续抽 | 直接返回空，工厂铺不满 |

引擎对「砖块总数恒为 100」有硬校验（`auditTiles`），测试里每一步都会跑一遍。任何一处漏算，测试立刻红。

---

## 二、整体架构

```text
┌───────────────────────────────────────────────────────────────┐
│ 浏览器 · 观战界面                                                │
│   index.html / app.js / styles.css                            │
│   EventSource ←──────────────────────────┐                    │
└──────────────────────────────────────────┼────────────────────┘
                                           │ SSE (text/event-stream)
┌──────────────────────────────────────────┼────────────────────┐
│ server.mjs   HTTP + SSE 广播              │                     │
│   GET  /api/state    全量快照（首屏/重连）  │                     │
│   GET  /api/stream   增量推送 ────────────┘                     │
│   POST /api/new      换阵容重开                                 │
│   POST /api/control  暂停 / 单步 / 调速                          │
│                                                                │
│ runner.js  对局循环：问脚本 → 校验 → 落子 → 广播 → 控节奏           │
│   ├── engine.js        纯函数规则引擎（唯一的真相来源）             │
│   └── sandbox.js       每个座位一个 worker_threads                │
│         └── agents/*.mjs   用户可替换的 AI 脚本                    │
└────────────────────────────────────────────────────────────────┘
```

四层各自的边界，是这套东西能扩展的关键：

**1. 引擎（`src/engine.js`）—— 只认数据，不认人**

`state` 是纯数据（可 `structuredClone`、可 JSON 落盘），所有变更只走三个入口：

```js
applyMove(state, move)      // 取砖 + 放置，返回 { state, events }
resolveRound(state)         // 轮末结算，返回 { state, events }
startNextRound(state)       // 补砖开轮，返回 { state, events }
```

随机数走 `state.rng` 游标而不是 `Math.random`，所以 `seed=42` 永远长成同一局。引擎不碰计时器、不碰网络、不碰 DOM —— 所以它能被测试、被 CLI、被服务端同时使用。

**2. 沙箱（`src/sandbox.js`）—— 把「用户代码」关进笼子**

AI 脚本是人写的代码，一次 `while(true)` 就能毁掉整场观战。所以每个座位起一个常驻 `worker_threads`：

- 主进程发 `{ type:'decide', view, moves }`，worker 里调脚本的 `chooseMove`，回 `{ move }`
- 超过 900ms 没回 → 直接 `terminate()`，该座位后续走兜底，**对局不中断**
- 脚本抛异常、返回乱码、返回不存在的行动，同样只影响自己

**3. 驱动器（`src/runner.js`）—— 把回合制变成一条可暂停的流**

它不是「算完一整局再回放」，而是每落一子就推一次快照。所以暂停、单步、调速都只是循环里的一个闸门（`#gate()`），不需要录像、不需要重算。

**4. 界面（`app.js`）—— 只显示，不计算**

前端不算分、不判合法、不做预测。它拿到什么画什么，所以按 F5 刷新永远看到服务端的真实状态，不会出现「界面和引擎各算各的」这种经典事故。

---

## 三、脚本接口设计

### 3.1 契约

一个脚本就是一个 ES 模块，默认导出：

```js
export default {
  id: 'my-agent',            // 唯一标识
  name: '我的脚本',           // 观战界面显示的名字
  tag: '进阶',                // 可选：基线/入门/稳健/进攻/进阶（决定面板排序）
  description: '一句话说明',   // 可选：显示在选人面板

  create(ctx) {              // 每局调用一次，返回决策器
    return {
      chooseMove(view, moves) {
        return moves[0];     // 必须返回 moves 里的一项
      },
    };
  },
};
```

### 3.2 `ctx`（整局不变）

| 字段 | 说明 |
|---|---|
| `seat` | 自己的座位号 `0..n-1` |
| `playerCount` | 2 / 3 / 4 |
| `seed` | 本局种子 |
| `rng()` | 种子化的 `[0,1)` 随机数，同 seed 可复现 |
| `log(...)` | 往观战界面写一行日志（别刷屏） |

### 3.3 `view`（每次决策重新给）

花砖物语是**完全信息游戏**（除袋中顺序外没有隐藏信息），所以 `view` 给的是一个「记性好的玩家能掌握的一切」：

```js
{
  mySeat, myTurn,
  phase,            // 'draft' | 'tiling' | 'over'
  round, turn, firstSeat,
  factories,        // [[颜色号…], …] 空盘是 []
  center,           // [颜色号…]
  centerFirst,      // 起始玩家标记是否还在中央
  bagCount,         // 袋中砖数
  bagColors,        // [5] 袋中各色数量（可以数出来的）
  discardCount,
  wallColor,        // [5][5] 墙面布局，wallColor[row][col] 是颜色号
  seats,            // [{ seat, name, score, floor, pattern, wall, bonus }]
  moves,            // 当前合法行动（轮到自己时非空）
}
```

`seats[i].pattern[row]` 是 `{ color, count }`，`wall[row][col]` 是颜色号，`-1` 表示空。
`floor` 里 `-1` 表示起始玩家标记（颜色号是 0~4，不会撞）。

### 3.4 `move`（行动）

```js
{ source: 'factory' | 'center', index, color, line }
```

| 字段 | 说明 |
|---|---|
| `source` | 从工厂圆盘取，还是从中央区取 |
| `index` | 工厂下标；从中央取时固定 `-1` |
| `color` | 颜色号 `0..4`（蓝 黄 红 黑 白） |
| `line` | 图案行 `0..4`；`-1` 表示整批弃到地板区 |

引擎已经算好了合法性，脚本不需要自己判「这行还能不能放这个色」——`moves` 里出现的一定合法，不出现的一定非法。

### 3.5 兜底与容错

| 情况 | 处理 |
|---|---|
| 返回 `null` / 乱码 / 非法行动 | 从「真正放进行里」的合法行动里随机挑一个，记一条警告 |
| 抛异常 | 同上，警告里写明原因 |
| 超过 900ms 没返回 | 终止该 worker，后续全部走兜底 |
| 脚本文件加载失败 | 该座位标记为不可用，仍可开局（只有它会被兜底） |

兜底策略刻意优先选「放进行里」而不是「倒地板」，这样脚本写崩了也不会把整局变成垃圾时间。

### 3.6 写一个新脚本

复制 `agents/random.mjs` 改改就行。最短版本：

```js
import { evaluateOutcome } from './_lib.mjs';

export default {
  id: 'mine',
  name: '我的脚本',
  create() {
    return {
      chooseMove(view, moves) {
        let best = moves[0];
        let bestGain = -Infinity;
        for (const move of moves) {
          const { gain } = evaluateOutcome(view, move);
          if (gain > bestGain) { bestGain = gain; best = move; }
        }
        return best;
      },
    };
  },
};
```

`agents/_lib.mjs` 提供了常用工具：`takenCount`、`floorDamage`、`wallScore`、`rowFilled`、`colFilled`、`colorPlaced`、`evaluateOutcome`、`opponentNeed`。下划线开头的文件不会被注册成可选脚本。

---

## 四、对局流程

### 4.1 状态机

```text
        createGame
             │
             ▼
        ┌─────────┐   工厂与中央区全部取空    ┌──────────┐
        │  draft  │ ───────────────────────► │  tiling  │
        │  选砖    │                          │  轮末结算 │
        └─────────┘                          └──────────┘
             ▲                                    │
             │        startNextRound             │ 有人补满整行墙面
             └────────────────────────────────────┤
                                                  ▼
                                             ┌────────┐
                                             │  over  │
                                             └────────┘
```

一个 `draft` 阶段的内循环：

```text
while (工厂非空 或 中央区非空):
    seat = state.turn
    view  = viewFor(state, seat)
    moves = legalMoves(state)              // 合法性由引擎完全枚举
    move  = agent[seat].chooseMove(view, moves)   // 沙箱，900ms 超时
    state = applyMove(state, move).state   // 取砖 + 放行 + 溢出到地板
    emit(snapshot)
```

### 4.2 轮末结算（容易写成「同时」的地方）

规则书写的是「所有玩家同时结算」，但实现上必须**串行**，否则事件流没法看：

```text
for seat of seats:                  // 按座位顺序
    for row of 图案行:               // 从上到下
        if 行满:
            上墙 → 立刻计分 → 记录事件
            其余 cap-1 块退回盒盖
    if 地板非空:
        扣分（总分不低于 0）→ 清空地板
if 任一玩家有完整行: 终局奖励 → 排名 → over
else: phase = 'prepare'
```

### 4.3 驱动器的主循环

```js
while (!stopped && !state.over) {
  await gate();                     // 暂停 / 单步闸门

  if (phase === 'draft')  { 问脚本 → applyMove → 广播 → sleep(pace) }
  if (phase === 'tiling') { resolveRound → 广播 → sleep(pace*2) }
  if (phase === 'prepare'){ startNextRound → 广播 → sleep(pace) }
}
```

`sleep(pace)` 就是观战节奏。速度档位直接换算成 `pace = 480 / speed`，八档从 0.5×（960ms）到瞬时（20ms）。

---

## 五、观战界面的实现方案

### 5.1 传输：为什么用 SSE 而不是 WebSocket

观战是**单向广播**（服务端 → 浏览器），SSE 正好是单向的，而且：

- 零依赖，`http` 模块直接写 `text/event-stream` 就行
- 浏览器自带 `EventSource`，自动重连、自动续传
- 不需要握手协议、不需要心跳帧格式

唯一要注意的是关掉缓冲：

```js
response.writeHead(200, {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',       // 反向代理下必须
});
```

### 5.2 消息协议

| 消息 | 时机 | 内容 |
|---|---|---|
| `hello` | 新连接建立 | 全量：`status / snapshot / log / config / agents` |
| `new` | 换阵容重开 | `config / agents`（前端清空本地状态） |
| `step` | 每落一子 | `snapshot / actor / label / events / thinkMs / problems` |
| `done` | 对局结束 | `snapshot / ranking / warnings / agents` |
| `control` | 暂停/调速 | `status / speed` |
| `agent-log` | 脚本调 `log()` | `seat / message` |

`hello` 的存在让「刷新页面」变成了完整的状态恢复：不需要重放，也不会和引擎脱节。

### 5.3 渲染策略

**每步全量重建 DOM**（4 张板子约 400 个节点），8 步/秒完全扛得住，换来的是「永远不会渲染出幽灵状态」这种确定性。为了让重建不显得生硬：

- 对比上一步快照，只给**新出现的砖**加 `pop` 动画、给**变化的分数**加 `bump`
- 用 `requestAnimationFrame` 合并同一帧内的多次更新

**日志区是唯一做了增量更新的地方**。原因很实在：整片重建会让所有行同时重播入场动画，观战时日志有一半时间处于全透明——这个 bug 花了一轮截图才发现。

```js
if (S.log.length > renderedLogCount) {
  // 只补新增的行
  el.log.insertAdjacentHTML('beforeend', batch.join(''));
  renderedLogCount = S.log.length;
}
```

### 5.4 桌面摆法

工厂圆盘按真实桌面摆成环形：极坐标算位置，中央区固定在圆心。

```js
const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
node.style.left = `${50 + Math.cos(angle) * radius}%`;
node.style.top  = `${50 + Math.sin(angle) * radius}%`;
```

9 盘（4 人）、7 盘（3 人）、5 盘（2 人）自动适配，半径按盘数微调避免和中央区重叠。

玩家板左侧是图案行（靠右对齐的阶梯，和实体板一致），右侧是 5×5 墙，中间一条竖线分隔。墙面空格用该位置的**目标色**画一个淡色圆点——这样不用记布局也能一眼看出「这个颜色该往哪放」。

### 5.5 控制

| 操作 | 实现 |
|---|---|
| 暂停 / 继续 | 置 `paused` 标志，循环在 `gate()` 处挂起 |
| 单步 | `paused = true; stepOnce = true` 后唤醒，走一步再挂起 |
| 调速 | 改 `speed`，只影响下一次 `sleep` 的长度（不会打断当前步） |
| 新对局 | POST 阵容 → 服务端 `stop()` 旧 runner 再起新的 |

---

## 六、目录结构

```text
azul-arena/
├── server.mjs              HTTP + SSE 观战服务
├── cli.mjs                 批量对局 / 单局复盘
├── package.json            零依赖，只有 scripts 入口
├── LICENSE                 MIT
├── index.html              观战界面骨架
├── styles.css              深色陶土质感样式
├── app.js                  渲染 + 控制
├── src/
│   ├── rules.js            规则常量（墙布局、罚分表、工厂数）
│   ├── engine.js           纯函数规则引擎
│   ├── sandbox.js          脚本沙箱（worker_threads 客户端）
│   ├── sandbox-worker.mjs  沙箱内宿主
│   ├── runner.js           对局驱动器
│   └── agents.js           脚本注册表
├── agents/
│   ├── _lib.mjs            脚本公用工具（不注册）
│   ├── random.mjs          随机漫步 · 基线（全模式）
│   ├── greedy.mjs          即时收益 · 入门（全模式）
│   ├── wallbuilder.mjs     墙面建筑师 · 稳健（全模式）
│   ├── denier.mjs          断供者 · 进攻（全模式）
│   ├── tactician.mjs       棋手 · 进阶（全模式）
│   └── models/             12 个模型生成脚本
│       ├── _CONTRACT.md    生成契约（各模型共享）
│       ├── ROSTER.md       清单：模型 ↔ 脚本 ↔ 战绩
│       ├── roster.json     同上，机器可读
│       └── *.mjs           12 个专精脚本
├── tools/
│   ├── check-agent.mjs     单脚本自检（真的打完整局）
│   ├── roundrobin.mjs      同模式循环赛
│   └── gen-roster.mjs      重新生成清单
└── tests/
    └── engine.test.mjs     12 项引擎断言
```

---

## 七、内置脚本与基准

24 局 4 人对局（`node cli.mjs --games 24`）：

| 脚本 | 风格 | 胜率 | 均分 | 均名次 |
|---|---|---|---|---|
| 棋手 `tactician` | 综合权衡得分/布局/断供/先手 | 38% | 57.3 | 2.33 |
| 墙面建筑师 `wallbuilder` | 追终局行/列/同色奖励 | 29% | 56.1 | 2.33 |
| 即时收益 `greedy` | 只看单步净收益 | 21% | 53.8 | 2.71 |
| 断供者 `denier` | 主动掐对手的大行 | 13% | 55.6 | 2.63 |

断供者均分不低但胜率最低——典型的「搅乱牌桌但自己不赢」风格，符合它的设计意图。

样本只有 24 局，别当严谨结论看；把 `--games` 加到 200 会更稳。

---

## 八、12 模型生成脚本

`agents/models/` 下的 12 个脚本由 **12 个不同模型**分别生成，每个模型负责一种对战人数，
彼此看不到对方的代码——只共享 `agents/models/_CONTRACT.md` 这一份接口契约。

完整清单见 **`agents/models/ROSTER.md`**（人读）与 **`agents/models/roster.json`**（机器读）。

### 分工与战绩

**2 人局**（duel，5 工厂 / 每轮 20 块砖）

| 脚本 | 产出模型 | 策略 | 循环赛 |
|---|---|---|---|
| 锁喉手 | hy3 | 先手锁喉：控制首标记与回合顺序 | 22/36（61%） |
| 疾风快墙 | GLM5.3flash | 速攻终局：用最短行压缩轮次 | 19/36（53%） |
| 粒粒归仓 | hy4 | 零溢效率流：一块砖都不许进地板 | 16/36（44%） |
| 垄断者 | GLM5.3 | 颜色垄断：锁定 2~3 色断供 | 15/36（42%） |

**3 人局**（trio，7 工厂 / 每轮 28 块砖）

| 脚本 | 产出模型 | 策略 | 循环赛 |
|---|---|---|---|
| 地板铁砧 | MiniMax M3.1flash | 地板压制：rollout 逼对手溢出 | 22/36（61%） |
| 拾荒猎手 | KIMI 2.8preview | 嗅探捡漏：按阶段切换权重 | 15/36（42%） |
| 双轨织墙 | KIMI 3.1pro | 双线交叉：同时推进行列 | 7/36（19%） |
| 三线平衡手 | MiniMax M3 | 中线平衡：三线显式加权 | 4/36（11%） |

**4 人局**（table，9 工厂 / 每轮 36 块砖）

| 脚本 | 产出模型 | 策略 | 循环赛 |
|---|---|---|---|
| 绊脚砖 | MIMO-v2.6-pro | 反制搅局：锁定领先者定向断供 | 16/40（40%） |
| 终局账房 | deepseek v4.1flash | 终局收割：为 +7/+10 牺牲即时分 | 11/40（28%） |
| 控流士 | step5preview | 节奏控制：按剩余手数切换攻守 | 9/40（23%） |
| 全局谋士 | deepseek v4pro | 全局估值：分项期望分相加 | 4/40（10%） |

3 人局的分差最大（61% vs 11%），4 人局最接近（40% vs 10%）——人数越多，单一策略能拉开的差距越小，
这个分布和 Azul 本身的性质一致。

### 脚本如何声明模式

```js
export default {
  id: 'hy4',
  name: '粒粒归仓',
  tag: '专精',
  model: 'hy4',
  modes: [2],            // 只支持 2 人局
  strategy: '零溢效率流',
  description: '…',
  create(ctx) { return { chooseMove(view, moves) { … } }; },
};
```

引擎、服务端、CLI、观战界面都会读 `modes`：

- 观战界面在选人时**按当前人数过滤**，只列出支持该人数的脚本，并标注「2 人 / 3 人 / 4 人」
- CLI 选了不匹配的脚本会警告并换成可用的
- 服务端 `/api/new` 会丢弃不支持该人数的座位

手写的那 5 个基线脚本声明的是 `modes: [2, 3, 4]`，所以任何人数下都能选。

### 复现

```bash
node tools/check-agent.mjs agents/models/hy4.mjs 2      # 单脚本自检，会真的打完整局
node tools/roundrobin.mjs --players 2 --games 12        # 2 人局循环赛
node tools/roundrobin.mjs --players 3 --games 12        # 3 人局
node tools/roundrobin.mjs --players 4 --games 40        # 4 人局
node tools/gen-roster.mjs                               # 重新生成清单
```

循环赛每局轮换座位，避免「先手座总是赢」这种由座位带来的假信号。

---

## 九、已知取舍

- **只实现基础版**。夏日凉亭、玻璃砖、巧克力等扩展没做；玩家板只做了 A 面。
- **不提供人类操作**。这个模拟器定位是「脚本对局 + 观战」，要人机对战得另加一层输入。
- **单进程单桌**。`server.mjs` 里的 `current` 是单个全局对象，要多桌改成 `Map<matchId, …>` 即可，其余不用动。
- **前端全量重建**。状态小（4 张板子）时这是最省心的方案；如果将来要做 8 人局或加动画补间，得换成 keyed diff。
- **脚本可信但不安全**。worker 隔离能挡住死循环和崩溃，但它挡不住脚本读文件、发网络请求——本地单机自己写脚本的场景下，这个边界是合适的；放到线上得多加一层权限沙箱。

---

## 十、许可

MIT，见 [LICENSE](LICENSE)。

《花砖物语》(Azul) 是 Plan B Games 的注册商标。本项目是非官方的规则实现，仅用于学习、研究与 AI 脚本对局实验，与权利方无关联。
