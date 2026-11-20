/* 爆弾パス — クライアント */

const SKILLS = [
  { id: 'analyze', icon: '🔍', name: '解析', desc: '爆弾を手にした時、30%で残り時間が一瞬だけ見える' },
  { id: 'foresight', icon: '🔮', name: '予知', desc: '次に爆弾が自分に来るかわかる' },
  { id: 'accelerate', icon: '⚡', name: '加速', desc: '自分が持っている間、秒数が1.5倍速になる' },
  { id: 'decelerate', icon: '🧊', name: '減速', desc: '自分が持っている間、秒数が0.6倍速になる' },
  { id: 'block', icon: '⛓️', name: '妨害', desc: '渡す時、30%で相手に3秒のタップ不可を与える（1ゲーム1回）' },
  { id: 'dodge', icon: '🌀', name: '回避', desc: '受け取る時、30%でスキップして即座に次へ渡す' },
  { id: 'power', icon: '💥', name: '強化', desc: '自分が渡した相手が爆発すると2ライフ削る' },
];
const SKILL_MAP = Object.fromEntries(SKILLS.map((s) => [s.id, s]));
const SESSION_KEY = 'bombpass.session.v1';
const NAME_KEY = 'bombpass.name.v1';
const PROFILE_KEY = 'bombpass.profile.v1';
const MAX_LIVES = 3;

const $ = (sel) => document.querySelector(sel);

const S = {
  code: null,
  pid: null,
  view: null,
  offset: 0,
  pollTimer: null,
  polling: false,
  lastLogId: 0,
  playersSig: '',
  skillsBuilt: false,
  reveal: null,
  toastTimer: null,
  lastRound: 0,
  fuseTimer: null,
  holderId: null,
  holderSince: 0,
};

/* --------------------------------------------------------------- helpers */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function serverNow() {
  return Date.now() + S.offset;
}

/** 端末ごとの匿名ID (通算戦績のキー) */
function profileKey() {
  try {
    const saved = localStorage.getItem(PROFILE_KEY);
    if (saved && /^[a-z0-9]{8,64}$/i.test(saved)) return saved;
    const key = crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem(PROFILE_KEY, key);
    return key;
  } catch {
    return '';
  }
}

function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || data.error) throw new Error(data.error || '通信エラー');
  return data;
}

function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ code: S.code, pid: S.pid }));
  } catch {
    /* ignore */
  }
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.code === 'string' && typeof data.pid === 'string') return data;
  } catch {
    /* ignore */
  }
  return null;
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  S.code = null;
  S.pid = null;
  S.view = null;
  S.playersSig = '';
  S.lastLogId = 0;
  clearTimeout(S.pollTimer);
}

/* ---------------------------------------------------------------- screens */

const SCREENS = ['home', 'lobby', 'game', 'result'];

function showScreen(name) {
  for (const s of SCREENS) {
    $(`#screen-${s}`)?.classList.toggle('hidden', s !== name);
  }
  $('#btnLeave').classList.toggle('hidden', name === 'home');
  $('#topCode').classList.toggle('hidden', name === 'home');
}

/* --------------------------------------------------------------- polling */

function schedule(phase) {
  clearTimeout(S.pollTimer);
  const delay = phase === 'playing' ? 250 : 800;
  S.pollTimer = setTimeout(poll, delay);
}

async function poll() {
  if (!S.code || S.polling) return;
  S.polling = true;
  try {
    const v = await api(`/api/rooms/${encodeURIComponent(S.code)}?pid=${encodeURIComponent(S.pid || '')}`);
    if (!v.me) {
      clearSession();
      showScreen('home');
      toast('参加情報が見つかりませんでした');
      return;
    }
    applyView(v);
  } catch (e) {
    if (String(e.message).includes('部屋が見つかりません')) {
      clearSession();
      showScreen('home');
      toast('部屋が終了しました');
      return;
    }
    // 一時的な通信エラーは次回ポーリングで回復させる
  } finally {
    S.polling = false;
    if (S.code) schedule(S.view?.phase);
  }
}

function applyView(v) {
  S.view = v;
  S.offset = v.serverTime - Date.now();
  if (v.phase !== 'playing') S.lastRound = 0;
  if (v.me) {
    S.pid = v.me.id;
    S.code = v.code;
  }
  $('#topCode').textContent = v.code;

  if (v.phase === 'lobby') {
    showScreen('lobby');
    renderLobby(v);
  } else if (v.phase === 'playing') {
    showScreen('game');
    renderGame(v);
  } else {
    showScreen('result');
    renderResult(v);
  }
  renderLog(v);
}

/* ----------------------------------------------------------------- lobby */

function hearts(lives) {
  let out = '';
  for (let i = 0; i < MAX_LIVES; i++) {
    out += i < lives ? '<span class="on">❤️</span>' : '<span class="off">🖤</span>';
  }
  return out;
}

function playerCard(p, v) {
  const skill = p.skill ? SKILL_MAP[p.skill] : null;
  const skillText = skill
    ? `${skill.icon} ${esc(skill.name)}${p.skill === 'block' && p.blockUsed ? '（使用済み）' : ''}`
    : 'スキル未選択';
  const cls = [
    'pcard',
    p.id === v.me?.id ? 'me' : '',
    p.isHolder ? 'holder' : '',
    p.alive === false ? 'dead' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="${cls}">
    ${p.isHolder ? '<span class="holder-tag">💣 所持</span>' : ''}
    <div class="pname">${esc(p.name)}${p.id === v.me?.id ? '<span class="you">YOU</span>' : ''}</div>
    <div class="pskill">${skillText}</div>
    <div class="hearts">${hearts(p.lives)}</div>
  </div>`;
}

function renderLobby(v) {
  $('#lobbyCode').textContent = v.code;
  $('#lobbyCount').textContent = String(v.players.length);
  $('#lobbyPlayers').innerHTML = v.players.map((p) => playerCard(p, v)).join('');
  $('#lobbyHint').textContent = '同じWiFiの仲間にコードを共有しよう。';

  buildSkills();
  for (const el of document.querySelectorAll('.skill')) {
    el.classList.toggle('selected', el.dataset.skill === v.me?.skill);
  }

  const missing = v.players.filter((p) => !p.skill).length;
  $('#skillHint').textContent =
    v.me?.skill && missing === 0
      ? '全員のスキルが決まりました'
      : missing > 0
        ? `未選択の ${missing} 人はランダムなスキルになります`
        : '';

  const btn = $('#btnStart');
  btn.classList.toggle('hidden', !v.me?.isHost);
  btn.disabled = !v.me?.isHost || v.players.length < 2;
  btn.textContent = v.players.length < 2 ? '2人以上で開始できます' : 'ゲーム開始';
  $('#lobbyWait').textContent = v.me?.isHost
    ? v.players.length < 2
      ? 'あと1人以上でスタートできます'
      : ''
    : 'ホストが開始すると自動で始まります';
}

function buildSkills() {
  if (S.skillsBuilt) return;
  S.skillsBuilt = true;
  const grid = $('#skillGrid');
  grid.innerHTML = SKILLS.map(
    (s) => `<button class="skill" type="button" data-skill="${s.id}">
      <span class="skill-icon">${s.icon}</span>
      <span class="skill-name">${s.name}</span>
      <span class="skill-desc">${s.desc}</span>
    </button>`,
  ).join('');
  grid.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.skill');
    if (!btn) return;
    try {
      const v = await api(`/api/rooms/${S.code}/skill`, { pid: S.pid, skill: btn.dataset.skill });
      applyView(v);
    } catch (e) {
      toast(e.message);
    }
  });
}

/* ------------------------------------------------------------------ game */

function renderGame(v) {
  $('#roundLabel').textContent = `ROUND ${v.round}`;

  const sig = v.players.map((p) => `${p.id}:${p.lives}:${p.alive}:${p.isHolder}`).join('|');
  if (sig !== S.playersSig) {
    S.playersSig = sig;
    $('#gamePlayers').innerHTML = v.players.map((p) => playerCard(p, v)).join('');
  }

  const holder = v.players.find((p) => p.isHolder);
  $('#holderLine').innerHTML = holder
    ? `爆弾は <b>${esc(holder.name)}</b> の手に`
    : '次の爆弾を待っている…';

  // 所持者が変わったら保持時間の計測をリセット
  const holderId = holder ? holder.id : null;
  if (holderId !== S.holderId) {
    S.holderId = holderId;
    S.holderSince = serverNow();
  }

  const bomb = $('#bombArt');
  bomb.classList.toggle('ticking', !!holder);

  // 爆弾の長さ: 常時表示 + ラウンド開始時にバナー
  const fuseLine = $('#fuseLine');
  fuseLine.textContent = v.fuseMs > 0 ? `この爆弾：${Math.round(v.fuseMs / 1000)}秒` : '';
  if (v.round !== S.lastRound) {
    S.lastRound = v.round;
    const banner = $('#fuseBanner');
    if (v.fuseMs > 0) {
      banner.classList.remove('hidden');
      banner.innerHTML = `💣 この爆弾は <b>${Math.round(v.fuseMs / 1000)}秒</b>！`;
      clearTimeout(S.fuseTimer);
      S.fuseTimer = setTimeout(() => banner.classList.add('hidden'), 4000);
    } else {
      banner.classList.add('hidden');
    }
  }

  const me = v.me;
  $('#nextAlert').classList.toggle('hidden', !me?.nextIsMe);
  if (me?.nextIsMe) $('#nextAlert').textContent = '⚠ 次はあなたに爆弾が来る';

  // 解析: 一瞬だけ残り時間を見せる
  if (me && me.revealUntil > 0 && me.revealUntil > serverNow()) {
    S.reveal = { until: me.revealUntil, ms: me.revealMs };
  }
  const box = $('#revealBox');
  if (S.reveal && S.reveal.until > serverNow()) {
    box.classList.remove('hidden');
    box.innerHTML = `🔍 解析：のこり <b>${(S.reveal.ms / 1000).toFixed(1)}</b> 秒`;
  } else {
    box.classList.add('hidden');
    S.reveal = null;
  }

  updatePassButton();
}

function updatePassButton() {
  const v = S.view;
  const btn = $('#btnPass');
  if (!v || v.phase !== 'playing') return;
  updateBombHeat();
  const me = v.me;

  if (!me) {
    btn.disabled = true;
    btn.className = 'pass-btn';
    btn.textContent = '観戦中';
    return;
  }

  if (!me.alive) {
    btn.disabled = true;
    btn.className = 'pass-btn';
    btn.textContent = '脱落 — 観戦中';
    return;
  }

  if (me.canPass) {
    btn.disabled = false;
    btn.className = 'pass-btn ready';
    btn.textContent = 'タップしてパス！';
    return;
  }

  if (me.isHolder && me.lockUntil > serverNow()) {
    const remain = ((me.lockUntil - serverNow()) / 1000).toFixed(1);
    btn.disabled = true;
    btn.className = 'pass-btn locked';
    btn.textContent = `妨害中… ${remain}s`;
    return;
  }

  btn.disabled = true;
  btn.className = 'pass-btn';
  btn.textContent = '爆弾を待つ…';
}

/** 持っている時間が長いほど爆弾を熱く見せる (残り時間は出さない) */
function updateBombHeat() {
  const bomb = $('#bombArt');
  if (!bomb) return;
  const holder = S.view?.players?.find((p) => p.isHolder);
  bomb.classList.remove('heat-1', 'heat-2', 'heat-3');
  if (!holder) return;
  const heldMs = serverNow() - S.holderSince;
  if (heldMs > 4500) bomb.classList.add('heat-3');
  else if (heldMs > 3000) bomb.classList.add('heat-2');
  else if (heldMs > 1500) bomb.classList.add('heat-1');
}

setInterval(() => {
  if (S.view?.phase === 'playing') updatePassButton();
}, 100);

function renderLog(v) {
  const last = v.log.length ? v.log[v.log.length - 1].id : 0;
  if (last === S.lastLogId) return;

  const fresh = v.log.filter((entry) => entry.id > S.lastLogId);
  S.lastLogId = last;

  $('#logList').innerHTML = v.log
    .slice(-10)
    .map((entry) => `<li class="${entry.kind}">${esc(entry.text)}</li>`)
    .join('');

  if (fresh.some((entry) => entry.kind === 'danger')) {
    document.body.classList.add('shake');
    const flash = document.querySelector('.boom-flash');
    if (flash) {
      flash.classList.remove('go');
      void flash.offsetWidth;
      flash.classList.add('go');
    }
    const bomb = $('#bombArt');
    bomb.classList.remove('bang');
    void bomb.offsetWidth;
    bomb.classList.add('bang');
    setTimeout(() => document.body.classList.remove('shake'), 460);
  }
}

/* ---------------------------------------------------------------- result */

function renderResult(v) {
  const winner = v.players.find((p) => p.id === v.winnerId);
  $('#winnerName').textContent = winner ? winner.name : '引き分け';
  loadResultStats(v);

  const ranked = [...v.players].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.lives !== b.lives) return b.lives - a.lives;
    return a.name.localeCompare(b.name);
  });

  $('#ranking').innerHTML = ranked
    .map((p, i) => {
      const skill = p.skill ? SKILL_MAP[p.skill] : null;
      return `<li>
        <span class="rk-name">${i + 1}. ${esc(p.name)}</span>
        <span class="rk-meta">${p.alive ? '生存' : '脱落'} ・ ${p.lives}ライフ${
          skill ? ` ・ ${skill.icon}${esc(skill.name)}` : ''
        }</span>
      </li>`;
    })
    .join('');
}

/* --------------------------------------------------------------- ranking */

let rankOpen = false;

function rankLine(r) {
  const rate = Math.round(r.winRate * 100);
  return `<li><span class="rk-name">${r.rank}. ${esc(r.name)}</span><span class="rk-meta">${r.wins}勝 / ${r.games}戦 ・ 勝率${rate}%</span></li>`;
}

async function fetchRanking(limit) {
  const key = profileKey();
  return api(`/api/ranking?limit=${limit}&key=${encodeURIComponent(key)}`);
}

async function toggleRanking() {
  const body = $('#rankBody');
  const btn = $('#btnRank');
  if (rankOpen) {
    rankOpen = false;
    body.classList.add('hidden');
    btn.textContent = 'ランキングを見る';
    return;
  }
  rankOpen = true;
  body.classList.remove('hidden');
  btn.textContent = 'ランキングをとじる';
  $('#rankList').innerHTML = '<li><span class="rk-name">読み込み中…</span></li>';
  $('#rankMe').textContent = '';
  try {
    const data = await fetchRanking(10);
    if (!data.enabled) {
      $('#rankList').innerHTML = '';
      $('#rankMe').textContent = 'ランキングは未設定です（D1 を接続すると記録されます）';
      return;
    }
    $('#rankList').innerHTML = data.top.length
      ? data.top.map(rankLine).join('')
      : '<li><span class="rk-name">まだ記録がありません</span></li>';
    $('#rankMe').textContent = data.me
      ? `あなた: ${data.me.rank}位 ・ ${data.me.wins}勝 / ${data.me.games}戦`
      : 'あなたの記録はまだありません';
  } catch (e) {
    $('#rankMe').textContent = e.message;
  }
}

let statsShownFor = null;

async function loadResultStats(v) {
  const id = `${v.code}:${v.round}:${v.winnerId ?? ''}`;
  if (statsShownFor === id) return;
  statsShownFor = id;
  const box = $('#resultStats');
  box.textContent = '';
  try {
    const data = await fetchRanking(1);
    if (!data.enabled) return;
    if (data.me) {
      const rate = Math.round(data.me.winRate * 100);
      box.textContent = `通算 ${data.me.games}戦 ${data.me.wins}勝（勝率${rate}%）・ ランキング ${data.me.rank}位`;
    } else {
      box.textContent = '通算成績はまだありません';
    }
  } catch {
    /* 表示できなくてもゲーム進行には影響させない */
  }
}

/* ---------------------------------------------------------------- actions */

function setBusy(btn, busy, text) {
  btn.disabled = busy;
  if (text) btn.textContent = text;
}

async function createRoom() {
  const name = $('#nameInput').value.trim();
  const err = $('#homeError');
  err.textContent = '';
  if (!name) {
    err.textContent = 'ニックネームを入力してください';
    return;
  }
  const btn = $('#btnCreate');
  setBusy(btn, true, '作成中…');
  try {
    localStorage.setItem(NAME_KEY, name);
    const v = await api('/api/rooms', { name, playerKey: profileKey() });
    S.code = v.code;
    S.pid = v.me.id;
    saveSession();
    S.lastLogId = 0;
    applyView(v);
    schedule(v.phase);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    setBusy(btn, false, '部屋をつくる');
  }
}

async function joinRoom() {
  const name = $('#nameInput').value.trim();
  const code = $('#codeInput').value.trim().toUpperCase();
  const err = $('#homeError');
  err.textContent = '';
  if (!name) {
    err.textContent = 'ニックネームを入力してください';
    return;
  }
  if (code.length !== 4) {
    err.textContent = '部屋コードは4文字です';
    return;
  }
  const btn = $('#btnJoin');
  setBusy(btn, true, '…');
  try {
    localStorage.setItem(NAME_KEY, name);
    const v = await api(`/api/rooms/${encodeURIComponent(code)}/join`, {
      name,
      playerKey: profileKey(),
    });
    S.code = v.code;
    S.pid = v.me.id;
    saveSession();
    S.lastLogId = 0;
    applyView(v);
    schedule(v.phase);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    setBusy(btn, false, '参加');
  }
}

async function startGame() {
  const btn = $('#btnStart');
  setBusy(btn, true, '開始中…');
  try {
    const v = await api(`/api/rooms/${S.code}/start`, { pid: S.pid });
    applyView(v);
  } catch (e) {
    toast(e.message);
  } finally {
    setBusy(btn, false, 'ゲーム開始');
    updatePassButton();
  }
}

let passBusy = false;

async function passBomb() {
  if (passBusy) return;
  passBusy = true;
  const btn = $('#btnPass');
  btn.disabled = true;
  btn.textContent = 'パス！';
  try {
    const v = await api(`/api/rooms/${S.code}/pass`, { pid: S.pid });
    applyView(v);
  } catch (e) {
    toast(e.message);
  } finally {
    passBusy = false;
    updatePassButton();
  }
}

async function rematch() {
  const btn = $('#btnRematch');
  setBusy(btn, true, '準備中…');
  try {
    const v = await api(`/api/rooms/${S.code}/rematch`, { pid: S.pid });
    S.lastLogId = 0;
    applyView(v);
    schedule(v.phase);
  } catch (e) {
    toast(e.message);
  } finally {
    setBusy(btn, false, 'もう一度あそぶ');
  }
}

async function copyLink() {
  const url = `${location.origin}/?room=${S.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('リンクをコピーしました');
  } catch {
    toast(url);
  }
}

function leave() {
  clearSession();
  S.view = null;
  showScreen('home');
  $('#topCode').classList.add('hidden');
}

/* ------------------------------------------------------------------- boot */

function boot() {
  $('#btnCreate').addEventListener('click', createRoom);
  $('#btnJoin').addEventListener('click', joinRoom);
  $('#btnStart').addEventListener('click', startGame);
  $('#btnPass').addEventListener('click', passBomb);
  $('#btnRematch').addEventListener('click', rematch);
  $('#btnCopy').addEventListener('click', copyLink);
  $('#btnRank').addEventListener('click', toggleRanking);
  $('#btnLeave').addEventListener('click', leave);
  $('#btnHome').addEventListener('click', leave);

  $('#codeInput').addEventListener('input', (ev) => {
    ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  try {
    const savedName = localStorage.getItem(NAME_KEY);
    if (savedName) $('#nameInput').value = savedName;
  } catch {
    /* ignore */
  }

  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase();
  if (roomParam.length === 4) $('#codeInput').value = roomParam;

  // 進行中のセッションがあれば復帰
  const session = readSession();
  if (session) {
    S.code = session.code;
    S.pid = session.pid;
    showScreen('lobby');
    poll();
    return;
  }

  showScreen('home');
}

boot();
