import { newCode } from './game';

/**
 * /api/* を部屋ごとの Durable Object に振り分けるだけの Worker。
 * 状態は DO が持つので、外部ストレージの事前作成は不要。
 */

export { RoomDO } from './room';

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean);

    if (seg[0] !== 'api') return env.ASSETS.fetch(request);
    if (seg[1] !== 'rooms') return json({ error: 'not found' }, 404);

    try {
      // POST /api/rooms — 空いているコードを探して部屋を作る
      if (seg.length === 2) {
        if (request.method !== 'POST') return json({ error: 'not found' }, 404);
        const body = await request.text();
        if (!body) return json({ error: 'リクエストが不正です' }, 400);
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
