import {
  chooseSkill,
  cleanName,
  joinRoom,
  newId,
  newRoom,
  passBomb,
  publicState,
  rematch,
  resolveDue,
  startGame,
  type Room,
} from './game';

/**
 * 部屋ごとの Durable Object。
 * 1ルーム = 1インスタンスなので、状態はメモリ上で直列に扱える
 * (D1 のような楽観ロック・再試行が不要)。
 */

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });

/** 遊び終わった部屋のコードを再利用できるようにする */
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class RoomDO {
  private readonly ctx: DurableObjectState;
  private room: Room | null = null;
  private loaded = false;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get<Room>('room');
    this.room = stored ?? null;
    this.loaded = true;
  }

  private async save(): Promise<void> {
    if (this.room) await this.ctx.storage.put('room', this.room);
  }

  async fetch(request: Request): Promise<Response> {
    await this.load();

    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean); // api / rooms / :code / :action
    const code = (seg[2] ?? '').toUpperCase();
    const action = seg[3] ?? null;
    const method = request.method;
    const body = method === 'GET' ? {} : await readBody(request);
    const pid = typeof body.pid === 'string' ? body.pid : url.searchParams.get('pid');
    const now = Date.now();

    // 部屋作成 (同じコードに古い部屋が残っていれば再利用する)
    if (action === 'create') {
      const name = cleanName(body.name);
      if (!name) return json({ error: 'ニックネームを入力してください' }, 400);
      if (this.room && now - this.room.updatedAt < ROOM_TTL_MS) {
        return json({ error: 'コードが重複しました' }, 409);
      }
      const playerId = newId();
      this.room = newRoom(code, playerId, name, now);
      await this.save();
      return json(publicState(this.room, playerId, now));
    }

    if (!this.room) return json({ error: '部屋が見つかりません' }, 404);

    // 期限切れの爆弾はここで必ず爆発させる (誰か1人が取得すれば確定する)
    let dirty = resolveDue(this.room, now);

    if (method === 'GET') {
      if (dirty) await this.save();
      return json(publicState(this.room, pid, now));
    }

    if (action === 'join') {
      const name = cleanName(body.name);
      if (!name) return json({ error: 'ニックネームを入力してください' }, 400);
      const newPid = newId();
      const result = joinRoom(this.room, newPid, name, now);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.save();
      return json(publicState(this.room, newPid, now));
    }

    if (typeof pid !== 'string' || pid.length === 0) {
      return json({ error: '不明なプレイヤーです' }, 400);
    }

    if (action === 'skill') {
      const result = chooseSkill(this.room, pid, body.skill);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.save();
      return json(publicState(this.room, pid, now));
    }

    if (action === 'start') {
      const result = startGame(this.room, pid, now);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.save();
      return json(publicState(this.room, pid, now));
    }

    if (action === 'pass') {
      const result = passBomb(this.room, pid, now);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.save();
      return json(publicState(this.room, pid, now));
    }

    if (action === 'rematch') {
      const result = rematch(this.room, pid, now);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.save();
      return json(publicState(this.room, pid, now));
    }

    return json({ error: 'not found' }, 404);
  }
}
