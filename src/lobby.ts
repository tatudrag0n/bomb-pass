/**
 * 開いている部屋の一覧 (ロビー)。
 *
 * 部屋ごとの Durable Object から「いま募集している」状態だけを集約する。
 * 誰も取得していない部屋は一定時間でリストから自動的に消えるので、
 * 終了した部屋や放置された部屋が残り続けることはない。
 */

const KEY = 'open';
/** この時間を超えて更新のない部屋は一覧から消す (ms) */
const STALE_MS = 40_000;
const MAX_LIST = 20;

export interface LobbyEntry {
  code: string;
  host: string;
  players: number;
  max: number;
  updatedAt: number;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class LobbyDO {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  private async read(): Promise<Record<string, LobbyEntry>> {
    const stored = await this.ctx.storage.get<Record<string, LobbyEntry>>(KEY);
    return stored ?? {};
  }

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split('/').filter(Boolean)[0] ?? '';
    const now = Date.now();
    const rooms = await this.read();

    // 更新の止まった部屋を掃除する
    let pruned = false;
    for (const [code, entry] of Object.entries(rooms)) {
      if (now - entry.updatedAt > STALE_MS) {
        delete rooms[code];
        pruned = true;
      }
    }

    if (action === 'list') {
      if (pruned) await this.ctx.storage.put(KEY, rooms);
      const list = Object.values(rooms)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_LIST);
      return json({ rooms: list, serverTime: now });
    }

    const body = await readBody(request);
    const code = typeof body.code === 'string' ? body.code.toUpperCase() : '';
    if (!/^[A-Z0-9]{4}$/.test(code)) return json({ error: '部屋コードが不正です' }, 400);

    if (action === 'upsert') {
      const players = Number(body.players);
      const max = Number(body.max);
      rooms[code] = {
        code,
        host: typeof body.host === 'string' ? body.host.slice(0, 12) : '',
        players: Number.isFinite(players) ? Math.max(0, Math.min(99, Math.floor(players))) : 0,
        max: Number.isFinite(max) && max > 0 ? Math.min(99, Math.floor(max)) : 8,
        updatedAt: now,
      };
      await this.ctx.storage.put(KEY, rooms);
      return json({ ok: true });
    }

    if (action === 'remove') {
      if (rooms[code]) {
        delete rooms[code];
        await this.ctx.storage.put(KEY, rooms);
      }
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  }
}
