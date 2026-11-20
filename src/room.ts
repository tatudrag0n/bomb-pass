import {
  MAX_PLAYERS,
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
import { recordGame } from './stats';

/**
 * 部屋ごとの Durable Object。
 * 1ルーム = 1インスタンスなので、状態はメモリ上で直列に扱える
 * (D1 のような楽観ロック・再試行が不要)。
 */

interface Env {
  DB?: D1Database;
  /** 部屋検索用の一覧 (未接続なら一覧に出ないだけ) */
  LOBBY?: DurableObjectNamespace;
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });

/** 遊び終わった部屋のコードを再利用できるようにする */
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

/** ロビー一覧への反映はこの間隔で間引く (ms) */
const LOBBY_SYNC_MS = 8000;

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** ブラウザが生成した匿名ID (通算戦績のキー) */
function cleanKey(raw: unknown, fallback: string): string {
  if (typeof raw === 'string' && /^[a-z0-9]{8,64}$/i.test(raw)) return raw;
  return fallback;
}

export class RoomDO {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private room: Room | null = null;
  private loaded = false;
  private lastLobbySync = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
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

  /**
   * 部屋検索の一覧を更新する。
   * 募集中なら登録、開始後・満員なら削除。一覧側は更新が止まると自動で消える。
   */
  private async syncLobby(now: number, force = false): Promise<void> {
    const room = this.room;
    const ns = this.env.LOBBY;
    if (!room || !ns) return;
    if (!force && now - this.lastLobbySync < LOBBY_SYNC_MS) return;
    this.lastLobbySync = now;

    const open = room.phase === 'lobby' && room.players.length < MAX_PLAYERS;
    const host = room.players.find((p) => p.id === room.hostId);
    const payload = open
      ? { code: room.code, host: host?.name ?? '', players: room.players.length, max: MAX_PLAYERS }
      : { code: room.code };

    try {
      const stub = ns.get(ns.idFromName('global'));
      await stub.fetch(`https://lobby/${open ? 'upsert' : 'remove'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // 一覧が更新できなくてもゲーム進行には影響させない
      console.error('lobby sync failed', e);
    }
  }

  /** 決着した試合を1回だけ D1 に記録してから保存する */
  private async persist(now: number): Promise<void> {
    const room = this.room;
    if (!room) return;

    if (room.phase === 'finished' && !room.recorded) {
      room.recorded = true;
      const db = this.env.DB;
      if (db) {
        try {
          await recordGame(
            db,
            room.players.map((p) => ({
              key: p.key || p.id,
              name: p.name,
              win: p.id === room.winnerId,
            })),
            now,
          );
        } catch (e) {
          console.error('stats record failed', e);
        }
      }
    }

    await this.save();
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
      this.room = newRoom(code, playerId, name, cleanKey(body.playerKey, playerId), now);
      await this.save();
      await this.syncLobby(now, true);
      return json(publicState(this.room, playerId, now));
    }

    if (!this.room) return json({ error: '部屋が見つかりません' }, 404);

    // 期限切れの爆弾はここで必ず爆発させる (誰か1人が取得すれば確定する)
    const dirty = resolveDue(this.room, now);

    if (method === 'GET') {
      if (dirty) await this.persist(now);
      // 募集中の部屋は一覧に残り続けるよう、定期的に更新する
      if (this.room.phase === 'lobby') this.ctx.waitUntil(this.syncLobby(now));
      return json(publicState(this.room, pid, now));
    }

    if (action === 'join') {
      const name = cleanName(body.name);
      if (!name) return json({ error: 'ニックネームを入力してください' }, 400);
      const newPid = newId();
      const result = joinRoom(this.room, newPid, name, cleanKey(body.playerKey, newPid), now);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.persist(now);
      await this.syncLobby(now, true);
      return json(publicState(this.room, newPid, now));
    }

    if (typeof pid !== 'string' || pid.length === 0) {
      return json({ error: '不明なプレイヤーです' }, 400);
    }

    if (action === 'skill') {
      const result = chooseSkill(this.room, pid, body.skill);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.persist(now);
      return json(publicState(this.room, pid, now));
    }

    if (action === 'start') {
      const result = startGame(this.room, pid, now);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.persist(now);
      await this.syncLobby(now, true);
      return json(publicState(this.room, pid, now));
    }

    if (action === 'pass') {
      const result = passBomb(this.room, pid, now);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.persist(now);
      return json(publicState(this.room, pid, now));
    }

    if (action === 'rematch') {
      const result = rematch(this.room, pid, now);
      if (!result.ok) return json({ error: result.error }, 400);
      await this.persist(now);
      await this.syncLobby(now, true);
      return json(publicState(this.room, pid, now));
    }

    return json({ error: 'not found' }, 404);
  }
}
