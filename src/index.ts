import { newCode } from './game';
import { ensureStatsTable, playerStats, topPlayers } from './stats';

/**
 * /api/* を部屋ごとの Durable Object に振り分けるだけの Worker。
 * 状態は DO が持つので、外部ストレージの事前作成は不要。
 * D1 (DB) は通算戦績・ランキング用のオプション binding。
 */

export { RoomDO } from './room';

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
  DB?: D1Database;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });

const KEY_RE = /^[a-z0-9]{8,64}$/i;

function roomFetch(
  env: Env,
  code: string,
  path: string,
  method: string,
  body: string | null,
): Promise<Response> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const init: RequestInit = { method };
  if (body !== null) {
    init.body = body;
    init.headers = { 'content-type': 'application/json' };
  }
  return stub.fetch(`https://room${path}`, init);
}

/** GET /api/ranking?key=&limit= — 上位一覧と自分の通算成績 */
async function ranking(env: Env, url: URL): Promise<Response> {
  const db = env.DB;
  if (!db) return json({ enabled: false, top: [], me: null });

  const rawLimit = Number(url.searchParams.get('limit') ?? 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(20, Math.max(1, Math.floor(rawLimit))) : 10;
  const key = url.searchParams.get('key') ?? '';

  try {
    const top = await topPlayers(db, limit);
    const me = KEY_RE.test(key) ? await playerStats(db, key) : null;
    return json({ enabled: true, top, me });
  } catch (e) {
    console.error('ranking failed', e);
    return json({ enabled: false, top: [], me: null });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean);

    if (seg[0] !== 'api') return env.ASSETS.fetch(request);

    try {
      if (seg[1] === 'ranking') {
        if (request.method !== 'GET') return json({ error: 'not found' }, 404);
        return await ranking(env, url);
      }

      if (seg[1] !== 'rooms') return json({ error: 'not found' }, 404);

      // POST /api/rooms — 空いているコードを探して部屋を作る
      if (seg.length === 2) {
        if (request.method !== 'POST') return json({ error: 'not found' }, 404);
        const body = await request.text();
        if (!body) return json({ error: 'リクエストが不正です' }, 400);
        if (env.DB) {
          // スキーマは初回アクセス時に作る (失敗しても部屋作成は続行)
          await ensureStatsTable(env.DB).catch((e) => console.error('schema failed', e));
        }
        for (let attempt = 0; attempt < 6; attempt++) {
          const code = newCode();
          const res = await roomFetch(env, code, `/api/rooms/${code}/create`, 'POST', body);
          if (res.status !== 409) return res;
        }
        return json({ error: '部屋を作成できませんでした' }, 500);
      }

      const code = (seg[2] ?? '').toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) return json({ error: '部屋コードが不正です' }, 400);

      const action = seg[3] ? `/${seg[3]}` : '';
      const body = request.method === 'GET' ? null : await request.text();
      return await roomFetch(env, code, `/api/rooms/${code}${action}${url.search}`, request.method, body);
    } catch (e) {
      console.error('api error', e);
      return json({ error: 'サーバーエラーが発生しました' }, 500);
    }
  },
};
