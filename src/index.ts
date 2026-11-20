import {
  chooseSkill,
  cleanName,
  joinRoom,
  newCode,
  newId,
  newRoom,
  passBomb,
  publicState,
  rematch,
  resolveDue,
  startGame,
  type Res,
  type Room,
} from './game';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });

/* ---------------------------------------------------------------- storage */

let schemaReady: Promise<unknown> | null = null;

function ensureSchema(env: Env): Promise<unknown> {
  if (!schemaReady) {
    schemaReady = env.DB.exec(
      'CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
    ).catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

async function readRoom(env: Env, code: string): Promise<{ room: Room; version: number } | null> {
  const row = await env.DB.prepare('SELECT state, version FROM rooms WHERE code = ?')
    .bind(code)
    .first<{ state: string; version: number }>();
  if (!row) return null;
  try {
    return { room: JSON.parse(row.state) as Room, version: row.version };
  } catch {
    return null;
  }
}

/**
 * 読み取り → 変更 → 楽観ロックで書き戻し。
 * 衝突したら最新状態からやり直す。
 */
async function act(
  env: Env,
  code: string,
  fn: (room: Room, now: number) => Res<Room>,
): Promise<{ room: Room } | { error: string }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await readRoom(env, code);
    if (!row) return { error: '部屋が見つかりません' };
    const now = Date.now();
    const res = fn(row.room, now);
    if (!res.ok) return { error: res.error };
    if (res.changed === false) return { room: row.room };

    const out = await env.DB.prepare(
      'UPDATE rooms SET state = ?, version = ?, updated_at = ? WHERE code = ? AND version = ?',
    )
      .bind(JSON.stringify(row.room), row.version + 1, now, code, row.version)
      .run();
    if (out.meta.changes === 1) return { room: row.room };
  }
  return { error: '通信が混み合っています。もう一度お試しください' };
}

/* -------------------------------------------------------------------- api */

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function withState(room: Room, pid: string | null): Response {
  return json(publicState(room, pid, Date.now()));
}

async function createRoom(env: Env, request: Request): Promise<Response> {
  const body = await readBody(request);
  const name = cleanName(body.name);
  if (!name) return json({ error: 'ニックネームを入力してください' }, 400);

  const now = Date.now();
  const pid = newId();
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = newCode();
    const room = newRoom(code, pid, name, now);
    try {
      await env.DB.prepare(
        'INSERT INTO rooms (code, state, version, updated_at) VALUES (?, ?, 1, ?)',
      )
        .bind(code, JSON.stringify(room), now)
        .run();
      return withState(room, pid);
    } catch {
      // コード衝突 → 再試行
    }
  }
  return json({ error: '部屋を作成できませんでした' }, 500);
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  await ensureSchema(env);

  const seg = url.pathname.split('/').filter(Boolean);
  if (seg[1] !== 'rooms') return json({ error: 'not found' }, 404);

  if (seg.length === 2) {
    if (request.method !== 'POST') return json({ error: 'not found' }, 404);
    return createRoom(env, request);
  }

  const code = decodeURIComponent(seg[2] ?? '').toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) return json({ error: '部屋コードが不正です' }, 400);

  const body = request.method === 'GET' ? {} : await readBody(request);
  const pidParam = url.searchParams.get('pid');
  const pid = typeof body.pid === 'string' ? body.pid : pidParam;

  // GET /api/rooms/:code?pid=xxx  — 状態取得 (+ 期限切れ爆発の解決)
  if (seg.length === 3 && request.method === 'GET') {
    const result = await act(env, code, (room, now) => {
      const changed = resolveDue(room, now);
      return { ok: true, value: room, changed };
    });
    if ('error' in result) return json({ error: result.error }, 404);
    return withState(result.room, pid);
  }

  if (seg.length === 3 && request.method === 'POST') {
    // 旧クライアントの再入室用に状態だけ返す
    const result = await act(env, code, (room) => ({ ok: true, value: room, changed: false }));
    if ('error' in result) return json({ error: result.error }, 404);
    return withState(result.room, pid);
  }

  if (seg.length !== 4) return json({ error: 'not found' }, 404);
  const action = seg[3];

  if (action === 'join') {
    const name = cleanName(body.name);
    if (!name) return json({ error: 'ニックネームを入力してください' }, 400);
    const newPid = newId();
    const result = await act(env, code, (room, now) => joinRoom(room, newPid, name, now));
    if ('error' in result) return json({ error: result.error }, 400);
    return withState(result.room, newPid);
  }

  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  if (typeof pid !== 'string' || pid.length === 0) return json({ error: '不明なプレイヤーです' }, 400);

  if (action === 'skill') {
    const result = await act(env, code, (room) => chooseSkill(room, pid, body.skill));
    if ('error' in result) return json({ error: result.error }, 400);
    return withState(result.room, pid);
  }

  if (action === 'start') {
    const result = await act(env, code, (room, now) => startGame(room, pid, now));
    if ('error' in result) return json({ error: result.error }, 400);
    return withState(result.room, pid);
  }

  if (action === 'pass') {
    const result = await act(env, code, (room, now) => passBomb(room, pid, now));
    if ('error' in result) return json({ error: result.error }, 400);
    return withState(result.room, pid);
  }

  if (action === 'rematch') {
    const result = await act(env, code, (room, now) => rematch(room, pid, now));
    if ('error' in result) return json({ error: result.error }, 400);
    return withState(result.room, pid);
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      console.error('api error', e);
      return json({ error: 'サーバーエラーが発生しました' }, 500);
    }
  },
};
