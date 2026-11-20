/* 部屋検索 — 募集中の部屋を一覧して参加する */

export function initRoomSearch({ onJoin }) {
  const state = { open: false, timer: null, rooms: [], serverTime: 0 };
  const btn = document.querySelector('#btnRooms');
  const body = document.querySelector('#roomsBody');
  const list = document.querySelector('#roomList');
  const hint = document.querySelector('#roomsHint');
  if (!btn || !body || !list || !hint) return;

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  const agoText = (ms) => {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return 'たった今';
    return `${Math.round(sec / 60)}分前`;
  };

  async function load() {
    try {
      const res = await fetch('/api/rooms', { headers: { accept: 'application/json' } });
      const data = await res.json();
      state.rooms = Array.isArray(data.rooms) ? data.rooms : [];
      state.serverTime = data.serverTime || Date.now();
      render();
    } catch (e) {
      hint.textContent = e && e.message ? e.message : '読み込みに失敗しました';
    }
  }

  function render() {
    if (!state.rooms.length) {
      list.innerHTML = '';
      hint.textContent = 'いま募集中の部屋はありません。部屋をつくるか、コードで参加してください。';
      return;
    }
    list.innerHTML = state.rooms
      .map(
        (r) => `<li>
          <div class="ri-main">
            <span class="ri-code">${esc(r.code)}</span>
            <span class="ri-meta">${esc(r.host || 'ホスト')} ・ ${agoText(state.serverTime - r.updatedAt)}</span>
          </div>
          <div class="ri-right">
            <span class="ri-count">${r.players}/${r.max}人</span>
            <button class="secondary ri-join" type="button" data-code="${esc(r.code)}">参加</button>
          </div>
        </li>`,
      )
      .join('');
    hint.textContent = `${state.rooms.length}件の部屋が募集中（5秒ごとに更新）`;
  }

  function close() {
    state.open = false;
    clearInterval(state.timer);
    state.timer = null;
    body.classList.add('hidden');
    btn.textContent = '部屋をさがす';
  }

  async function toggle() {
    if (state.open) {
      close();
      return;
    }
    state.open = true;
    body.classList.remove('hidden');
    btn.textContent = '部屋をさがす（とじる）';
    hint.textContent = '読み込み中…';
    await load();
    clearInterval(state.timer);
    state.timer = setInterval(load, 5000);
  }

  btn.addEventListener('click', toggle);
  list.addEventListener('click', (ev) => {
    const join = ev.target.closest('.ri-join');
    if (!join) return;
    close();
    onJoin(join.dataset.code);
  });

  return { close };
}
