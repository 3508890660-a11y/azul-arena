/**
 * 观战界面。
 *
 * 职责边界：
 *   服务端 → 每一步推一个 snapshot + 一句 label
 *   前端   → 把 snapshot 铺成桌面，把 label 追加到记录
 *
 * 前端不跑规则、不算分、不做预测，只做「显示 + 控制」。
 * 这样任何时候按 F5 刷新，看到的都是服务端的真实状态。
 */

const S = {
  snapshot: null,
  prev: null,
  agents: [],
  config: null,
  status: 'idle',
  log: [],
  result: null,
  speed: 1,
  pickCount: 4,
};

const $ = (id) => document.getElementById(id);

const el = {
  hudRound: $('hud-round'),
  hudPhase: $('hud-phase'),
  hudBag: $('hud-bag'),
  hudDiscard: $('hud-discard'),
  hud: $('hud'),
  ring: $('ring'),
  centerDisc: $('center-disc'),
  centerTiles: $('center-tiles'),
  centerCount: $('center-count'),
  boards: $('boards'),
  hint: $('table-hint'),
  log: $('log'),
  logMeta: $('log-meta'),
  btnPause: $('btn-pause'),
  btnStep: $('btn-step'),
  btnSetup: $('btn-setup'),
  speed: $('speed-select'),
  dialog: $('setup-dialog'),
  setupForm: $('setup-form'),
  segPlayers: $('seg-players'),
  seatPickers: $('seat-pickers'),
  seedInput: $('seed-input'),
  toast: $('toast'),
};

const COLOR_NAMES = ['蓝', '黄', '红', '黑', '白'];
const PHASE_NAMES = { draft: '选砖', tiling: '结算', prepare: '备砖', over: '终局' };

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const tile = (color, extra = '') => `<span class="tile c${color} ${extra}"></span>`;

function sameColor(a, b) {
  return a === b;
}

function boardOf(snapshot, seat) {
  return snapshot.seats.find((item) => item.seat === seat);
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.toast.hidden = true;
  }, 3200);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

let paintQueued = false;

function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paint();
  });
}

function paint() {
  paintHud();
  paintRing();
  paintBoards();
  paintLog();
  paintControls();
}

function paintHud() {
  const snap = S.snapshot;
  if (!snap) {
    el.hudRound.textContent = '—';
    el.hudPhase.textContent = '—';
    el.hudBag.textContent = '—';
    el.hudDiscard.textContent = '—';
    return;
  }
  el.hudRound.textContent = `第 ${snap.round} 轮`;
  el.hudPhase.textContent = PHASE_NAMES[snap.phase] || snap.phase;
  el.hudBag.textContent = snap.bagCount;
  el.hudDiscard.textContent = snap.discardCount;
  el.hud.classList.toggle('hot', snap.phase === 'draft');
}

function paintRing() {
  const snap = S.snapshot;
  el.ring.querySelectorAll('.factory').forEach((node) => node.remove());
  if (!snap) return;

  const count = snap.factories.length;
  const radius = count <= 5 ? 37 : count <= 7 ? 38.5 : 39.5;

  snap.factories.forEach((tiles, index) => {
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const node = document.createElement('div');
    node.className = 'factory';
    node.style.left = `${50 + Math.cos(angle) * radius}%`;
    node.style.top = `${50 + Math.sin(angle) * radius}%`;

    if (!tiles.length) {
      node.classList.add('empty');
    } else {
      const inner = document.createElement('div');
      inner.className = 'factory-tiles';
      for (const color of tiles) inner.insertAdjacentHTML('beforeend', tile(color));
      node.append(inner);
    }

    node.title = tiles.length
      ? `工厂 #${index + 1}：${tiles.map((c) => COLOR_NAMES[c]).join(' ')}`
      : `工厂 #${index + 1}：空`;
    el.ring.append(node);
  });

  el.centerTiles.innerHTML = snap.center.map((color) => tile(color, 'small')).join('');
  el.centerCount.textContent = snap.center.length;
  el.centerDisc.classList.toggle('first-token', Boolean(snap.centerFirst));

  if (snap.over) {
    const winner = snap.seats.find((seat) => seat.seat === snap.ranking?.[0]?.seat);
    el.hint.textContent = winner
      ? `对局结束 · ${winner.name} 以 ${winner.score} 分获胜`
      : '对局结束';
  } else if (snap.phase === 'tiling') {
    el.hint.textContent = '工厂与中央区已取空，正在结算墙面…';
  } else if (snap.phase === 'prepare') {
    el.hint.textContent = '重新铺砖…';
  } else {
    const actor = snap.seats[snap.turn];
    el.hint.textContent = actor ? `轮到 ${actor.name} 选砖` : '';
  }
}

function paintBoards() {
  const snap = S.snapshot;
  if (!snap) {
    el.boards.innerHTML = '<p class="empty-hint">等待开局…</p>';
    return;
  }
  const prev = S.prev;

  const html = snap.seats.map((seat) => {
    const old = prev ? boardOf(prev, seat.seat) : null;
    const active = !snap.over && snap.phase === 'draft' && snap.turn === seat.seat;
    const isWinner = snap.over && snap.ranking?.[0]?.seat === seat.seat;
    const bump = old && old.score !== seat.score;

    const patterns = seat.pattern
      .map((pattern, line) => {
        const cap = line + 1;
        const ghostCount = 5 - cap;
        const oldCount = old ? old.pattern[line].count : 0;

        let cells = '';
        for (let i = 0; i < ghostCount; i += 1) cells += '<span class="slot ghost"></span>';
        for (let i = 0; i < cap; i += 1) {
          // 图案行从右往左填：砖贴着墙面那一侧堆，和实体板子一致
          const filled = i >= cap - pattern.count;
          const isNew = pattern.count > oldCount && i >= cap - pattern.count && i < cap - oldCount;
          const inner = filled && pattern.color !== null
            ? tile(pattern.color, isNew ? 'pop' : '')
            : '';
          cells += `<span class="slot ${filled ? 'filled' : ''}">${inner}</span>`;
        }
        return `<div class="prow">${cells}</div>`;
      })
      .join('');

    let wallCells = '';
    for (let row = 0; row < 5; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const color = seat.wall[row][col];
        const target = snap.wallColor[row][col];
        const filled = color !== -1;
        const wasFilled = old ? old.wall[row][col] !== -1 : false;
        const isNew = filled && !wasFilled;
        wallCells += `<span class="wall-cell c${target} ${filled ? 'filled' : ''}">${
          filled ? tile(color, isNew ? 'pop' : '') : ''
        }</span>`;
      }
    }

    const floor = seat.floor
      .map((value, index) => {
        const isToken = value === -1;
        const penalty = [-1, -1, -2, -2, -2, -3, -3][index] ?? -4;
        return `<span class="floor-slot filled" title="${isToken ? '起始玩家标记' : `${COLOR_NAMES[value]}砖`} ${penalty} 分">${
          isToken ? '<span class="token">首</span>' : tile(value)
        }</span>`;
      })
      .join('') + Array.from({ length: Math.max(0, 7 - seat.floor.length) }, (_, i) => {
        const index = seat.floor.length + i;
        const penalty = [-1, -1, -2, -2, -2, -3, -3][index] ?? -4;
        return `<span class="floor-slot">${penalty}</span>`;
      }).join('');

    return `
      <article class="board seat-${seat.seat} ${active ? 'active' : ''} ${isWinner ? 'winner' : ''}"
               style="--seat: var(--seat-${seat.seat})">
        <div class="board-head">
          <span class="seat-dot"></span>
          <span class="board-name">${seat.name}</span>
          <span class="board-tag">P${seat.seat + 1}</span>
          <span class="board-score ${bump ? 'bump' : ''}">${seat.score}</span>
        </div>
        <div class="board-body">
          <div class="patterns">${patterns}</div>
          <div class="wall">${wallCells}</div>
        </div>
        <div class="floor">${floor}</div>
      </article>`;
  }).join('');

  el.boards.innerHTML = html;
}

let renderedLogCount = 0;

function logLine(entry, index) {
  const seat = Number.isInteger(entry.seat) ? entry.seat : null;
  const who = seat === null
    ? ''
    : `<span class="who" style="--seat: var(--seat-${seat})">${S.snapshot?.seats[seat]?.name ?? `P${seat + 1}`}</span>`;
  return `<div class="log-line ${entry.kind || 'move'}"><span class="turn">${index}</span>${who}<span>${entry.text}</span></div>`;
}

function paintLog() {
  // 增量追加：整片重建会让所有行同时重播入场动画，
  // 观战时日志就会一半时间处于全透明 —— 这里只补新增的行。
  if (S.log.length < renderedLogCount) {
    el.log.innerHTML = '';
    renderedLogCount = 0;
  }

  const near = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 80;

  if (S.log.length > renderedLogCount) {
    const batch = [];
    for (let i = renderedLogCount; i < S.log.length; i += 1) {
      batch.push(logLine(S.log[i], i + 1));
    }
    el.log.insertAdjacentHTML('beforeend', batch.join(''));
    renderedLogCount = S.log.length;
  }

  while (el.log.childElementCount > 400) el.log.firstElementChild.remove();

  el.logMeta.textContent = `${S.log.length} 条`;
  if (near) el.log.scrollTop = el.log.scrollHeight;
}

function paintControls() {
  const running = S.status === 'running';
  el.btnPause.textContent = running ? '暂停' : '继续';
  el.btnPause.disabled = S.status === 'done' || S.status === 'idle';
  el.btnStep.disabled = running || S.status === 'idle' || S.status === 'done';
  el.speed.value = String(S.speed);
}

/* ------------------------------------------------------------------ *
 * 数据流
 * ------------------------------------------------------------------ */

function addLog(entry) {
  S.log.push(entry);
  if (S.log.length > 400) S.log.splice(0, S.log.length - 400);
}

function handle(message) {
  switch (message.type) {
    case 'hello': {
      S.agents = message.agents || S.agents;
      S.config = message.config || null;
      S.status = message.status || 'idle';
      S.log = Array.isArray(message.log) ? message.log.slice() : [];
      el.log.innerHTML = '';
      renderedLogCount = 0;
      S.snapshot = message.snapshot || null;
      S.prev = null;
      S.result = message.result || null;
      if (message.snapshot) S.pickCount = message.snapshot.playerCount;
      schedulePaint();
      break;
    }

    case 'new': {
      S.agents = message.agents || S.agents;
      S.config = message.config || null;
      S.status = 'running';
      S.log = [];
      el.log.innerHTML = '';
      renderedLogCount = 0;
      S.snapshot = null;
      S.prev = null;
      S.result = null;
      schedulePaint();
      break;
    }

    case 'step': {
      S.prev = S.snapshot;
      S.snapshot = message.snapshot;
      S.status = message.paused ? 'paused' : 'running';

      if (message.label && message.actor !== null && message.actor !== undefined) {
        addLog({ kind: 'move', seat: message.actor, text: message.label });
      } else if (message.label) {
        addLog({ kind: 'phase', text: message.label });
      }
      for (const problem of message.problems || []) {
        addLog({ kind: 'warn', seat: problem.seat, text: problem.message });
      }
      schedulePaint();
      break;
    }

    case 'done': {
      S.prev = S.snapshot;
      S.snapshot = message.snapshot;
      S.status = 'done';
      S.result = message;
      addLog({ kind: 'done', text: '对局结束' });
      schedulePaint();
      showResult(message.ranking);
      break;
    }

    case 'control': {
      S.status = message.status;
      if (message.speed) S.speed = message.speed;
      schedulePaint();
      break;
    }

    case 'agent-log': {
      addLog({ kind: 'agent', seat: message.seat, text: message.message });
      schedulePaint();
      break;
    }

    case 'error': {
      toast(message.message || '对局异常');
      break;
    }

    default:
      break;
  }
}

function showResult(ranking) {
  document.querySelector('.result-banner')?.remove();
  if (!ranking || !ranking.length) return;

  const top = ranking[0];
  const banner = document.createElement('div');
  banner.className = 'result-banner';
  banner.innerHTML = `
    <span>对局结束</span>
    <strong>${top.name} 获胜 · ${top.score} 分</strong>
    <span class="rank">${ranking
      .map((row) => `${row.place}. ${row.name} ${row.score}`)
      .join('　')}</span>`;
  document.body.append(banner);
  setTimeout(() => banner.remove(), 12000);
}

const stream = new EventSource('/api/stream');
stream.onmessage = (event) => {
  try {
    handle(JSON.parse(event.data));
  } catch (error) {
    console.error('消息解析失败', error);
  }
};
stream.onerror = () => {
  // EventSource 会自动重连，这里只在状态栏提示
  el.logMeta.textContent = '连接中断，正在重连…';
};

/* ------------------------------------------------------------------ *
 * 控制
 * ------------------------------------------------------------------ */

async function control(action, extra = {}) {
  try {
    const response = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    const payload = await response.json();
    if (!payload.ok) toast(payload.message || '操作失败');
  } catch (error) {
    toast(`请求失败：${error.message}`);
  }
}

el.btnPause.addEventListener('click', () => {
  control(S.status === 'running' ? 'pause' : 'resume');
});

el.btnStep.addEventListener('click', () => control('step'));

el.speed.addEventListener('change', () => {
  S.speed = Number(el.speed.value);
  control('speed', { speed: S.speed });
});

/* ------------------------------------------------------------------ *
 * 新对局对话框
 * ------------------------------------------------------------------ */

/** 当前人数下可用的脚本；若一个都没有（比如还没写专精脚本），退回全部。 */
function agentsForCount(count) {
  const usable = S.agents.filter((agent) => !agent.broken);
  const matched = usable.filter((agent) => !agent.modes || agent.modes.includes(count));
  return matched.length ? matched : usable;
}

function agentOptions(selected, playerCount) {
  return agentsForCount(playerCount)
    .map((agent) => {
      const parts = [agent.name];
      if (agent.tag) parts.push(agent.tag);
      if (agent.modes && agent.modes.length < 3) parts.push(`${agent.modes.join('/')} 人`);
      const disabled = agent.broken ? ' disabled' : '';
      return `<option value="${agent.id}"${agent.id === selected ? ' selected' : ''}${disabled}>${parts.join(' · ')}</option>`;
    })
    .join('');
}

function renderSeatPickers() {
  const defaults = ['tactician', 'glm53', 'kimi31pro', 'deepseekv4pro'];
  const previous = [...el.seatPickers.querySelectorAll('select')].map((node) => node.value);
  const pool = agentsForCount(S.pickCount).map((agent) => agent.id);

  const pickOne = (seat) => {
    for (const candidate of [previous[seat], S.config?.agents?.[seat], defaults[seat]]) {
      if (candidate && pool.includes(candidate)) return candidate;
    }
    return pool[0];
  };

  el.seatPickers.innerHTML = Array.from({ length: S.pickCount }, (_, seat) => `
      <div class="seat-pick" data-seat="${seat}" style="--seat: var(--seat-${seat})">
        <span class="seat-label"><span class="seat-dot"></span>P${seat + 1}</span>
        <select>${agentOptions(pickOne(seat), S.pickCount)}</select>
        <span class="seat-desc"></span>
      </div>`).join('');

  el.seatPickers.querySelectorAll('.seat-pick').forEach((row) => {
    const select = row.querySelector('select');
    const desc = row.querySelector('.seat-desc');
    const sync = () => {
      const agent = S.agents.find((item) => item.id === select.value);
      desc.textContent = agent?.description || '';
    };
    select.addEventListener('change', sync);
    sync();
  });
}

el.segPlayers.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-count]');
  if (!button) return;
  S.pickCount = Number(button.dataset.count);
  el.segPlayers.querySelectorAll('button').forEach((node) => {
    node.classList.toggle('active', node === button);
  });
  renderSeatPickers();
});

el.btnSetup.addEventListener('click', async () => {
  if (!S.agents.length) {
    try {
      const response = await fetch('/api/agents');
      const payload = await response.json();
      S.agents = payload.agents || [];
    } catch {
      /* ignore */
    }
  }
  S.pickCount = S.snapshot?.playerCount || S.pickCount || 4;
  el.segPlayers.querySelectorAll('button').forEach((node) => {
    node.classList.toggle('active', Number(node.dataset.count) === S.pickCount);
  });
  renderSeatPickers();
  el.dialog.showModal();
});

el.setupForm.addEventListener('submit', (event) => {
  // method="dialog" 会自己关窗，这里只处理「开始」
  if (event.submitter?.value !== 'start') return;

  const agents = [...el.seatPickers.querySelectorAll('select')].map((node) => node.value);
  const seed = Number(el.seedInput.value);
  const body = {
    playerCount: S.pickCount,
    agents: agents.slice(0, S.pickCount),
  };
  if (Number.isInteger(seed) && seed > 0) body.seed = seed;

  document.querySelector('.result-banner')?.remove();

  fetch('/api/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((response) => response.json())
    .then((payload) => {
      if (!payload.ok) toast('开局失败');
    })
    .catch((error) => toast(`开局失败：${error.message}`));
});

el.dialog.addEventListener('close', () => {
  el.seedInput.value = '';
});

/* 初次进入：拿一次状态，避免 SSE 尚未连上时白屏 */
fetch('/api/state')
  .then((response) => response.json())
  .then((payload) => {
    if (payload.snapshot || payload.agents) handle({ type: 'hello', ...payload });
  })
  .catch(() => {});
