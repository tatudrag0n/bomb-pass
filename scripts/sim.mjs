/**
 * ローカルでの動作確認用シミュレータ。
 * 3人で部屋を作り、パスを繰り返して爆発とライフ減少が起きることを確認する。
 *
 *   npx wrangler dev --port 8787   (別ターミナル)
 *   node scripts/sim.mjs           (BASE_URL=... node scripts/sim.mjs)
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const names = ['アカ', 'ミドリ', 'アオ'];
const skills = ['analyze', 'foresight', 'accelerate', 'decelerate', 'block', 'dodge', 'power'];

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`${path}: ${data.error || res.status}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const keyOf = (i) => `sim${i}player001`;
  const host = await api('/api/rooms', { name: names[0], playerKey: keyOf(0) });
  const code = host.code;
  const players = [{ name: names[0], pid: host.me.id, key: keyOf(0) }];

  for (let i = 1; i < names.length; i++) {
    const v = await api(`/api/rooms/${code}/join`, { name: names[i], playerKey: keyOf(i) });
    players.push({ name: names[i], pid: v.me.id, key: keyOf(i) });
  }

  // 部屋検索: 募集中の部屋が一覧に出るか
  const listed = await api('/api/rooms');
  const found = (listed.rooms || []).some((r) => r.code === code);
  console.log(`room list: ${(listed.rooms || []).length}件 / 自分の部屋=${found ? 'あり' : 'なし'}`);
  if (!found) {
    console.log('NG: 部屋が検索一覧に出てきません');
    process.exitCode = 1;
  }

  for (let i = 0; i < players.length; i++) {
    await api(`/api/rooms/${code}/skill`, { pid: players[i].pid, skill: skills[i % skills.length] });
  }

  let v = await api(`/api/rooms/${code}/start`, { pid: players[0].pid });
  console.log(`room ${code} / phase=${v.phase} / round=${v.round}`);

  // 開始した部屋は検索一覧から消える
  const afterStart = await api('/api/rooms');
  const stillListed = (afterStart.rooms || []).some((r) => r.code === code);
  console.log(`room list (start 後): 自分の部屋=${stillListed ? 'あり' : 'なし'}`);
  if (stillListed) {
    console.log('NG: 開始した部屋が検索一覧に残っています');
    process.exitCode = 1;
  }
  console.log(`players: ${v.players.map((p) => `${p.name}(${p.skill},${p.lives})`).join(', ')}`);

  let passes = 0;
  let explosions = 0;
  let lastLives = v.players.map((p) => p.lives).join(',');
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline && v.phase === 'playing') {
    const holder = v.players.find((p) => p.isHolder);
    if (!holder) throw new Error('所持者がいません');

    const asHolder = await api(`/api/rooms/${code}?pid=${holder.id}`);
    if (asHolder.me.canPass) {
      try {
        v = await api(`/api/rooms/${code}/pass`, { pid: holder.id });
        passes++;
      } catch {
        v = await api(`/api/rooms/${code}?pid=${players[0].pid}`);
      }
    } else {
      v = await api(`/api/rooms/${code}?pid=${players[0].pid}`);
    }

    const lives = v.players.map((p) => p.lives).join(',');
    if (lives !== lastLives) {
      explosions++;
      console.log(`  💥 life change: ${lastLives} -> ${lives} (${v.log.at(-1)?.text})`);
      lastLives = lives;
    }
    await sleep(120);
  }

  console.log(
    `passes=${passes} explosions=${explosions} phase=${v.phase} winner=${v.winnerId ?? 'none'}`,
  );
  console.log(
    `lives: ${v.players.map((p) => `${p.name}:${p.lives}${p.alive ? '' : '(out)'}`).join(', ')}`,
  );

  if (explosions === 0) {
    console.log('NG: 爆発を観測できませんでした');
    process.exitCode = 1;
    return;
  }
  console.log('OK: 爆発とライフ減少を確認');

  // 通算戦績 (D1 接続時のみ) の確認
  try {
    const rank = await api(`/api/ranking?key=${players[0].key}&limit=5`);
    if (!rank.enabled) {
      console.log('ranking: 未設定 (D1 バインディングなし)');
    } else {
      console.log(`ranking: top=${rank.top.length} me=${rank.me ? `${rank.me.rank}位 ${rank.me.wins}勝/${rank.me.games}戦` : 'なし'}`);
    }
  } catch (e) {
    console.log(`ranking: 取得失敗 (${e.message})`);
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
});
