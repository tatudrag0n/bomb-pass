/**
 * 爆弾パス — ゲームロジック (サーバー権威)
 *
 * 方針:
 *  - 爆発までの残り時間はクライアントに一切送らない (チート/覗き見防止)。
 *  - 爆発の判定はサーバー側の時刻で行う。クライアントは定期取得するだけ。
 *  - 次に誰へ渡るかはランダム。次の受け取り手は受け取り時点で確定させる
 *    (「予知」スキルが機能するため)。
 *  - タイマーは渡しても引き継がれる (残り時間はリセットされない)。
 *    加速/減速は「持っている間の進み方」なので、渡した瞬間に残り時間を再計算する。
 */

export const SKILLS = [
  'analyze',
  'foresight',
  'accelerate',
  'decelerate',
  'block',
  'dodge',
  'power',
] as const;

export type Skill = (typeof SKILLS)[number];
export type Phase = 'lobby' | 'playing' | 'finished';

export const MAX_LIVES = 3;
export const MAX_PLAYERS = 8;

/** 爆弾の基本寿命 (ランダム範囲, ms) */
const MIN_MS = 3500;
const MAX_MS = 8000;

/** スキル確率・効果 */
const ANALYZE_CHANCE = 0.3;
const ANALYZE_SHOW_MS = 1400;
const BLOCK_CHANCE = 0.3;
const BLOCK_MS = 3000;
const DODGE_CHANCE = 0.3;
const SPEED_ACCELERATE = 1.5;
const SPEED_DECELERATE = 0.6;

export interface Player {
  id: string;
  name: string;
  skill: Skill | null;
  lives: number;
  alive: boolean;
}

export interface Bomb {
  holderId: string;
  /** この爆弾を手渡した人 (強化スキル判定用) */
  fromId: string | null;
  /** 次に受け取る人 (予知スキル用) */
  nextTargetId: string | null;
  /** サーバー時刻での爆発時刻 */
  deadline: number;
  /** この時刻までタップ不可 (妨害) */
  passableAt: number;
  /** 解析スキルの一瞬表示 */
  reveal: { forId: string; until: number; ms: number } | null;
}

export interface LogEntry {
  id: number;
  at: number;
  text: string;
  kind: 'info' | 'danger' | 'good' | 'warn';
}

export interface Room {
  code: string;
  hostId: string;
  phase: Phase;
  players: Player[];
  bomb: Bomb | null;
  round: number;
  winnerId: string | null;
  log: LogEntry[];
  logSeq: number;
  createdAt: number;
  updatedAt: number;
}

export type Res<T> = { ok: true; value: T; changed?: boolean } | { ok: false; error: string };

const ok = <T,>(value: T, changed = true): Res<T> => ({ ok: true, value, changed });
const fail = (error: string): Res<never> => ({ ok: false, error });

/* ------------------------------------------------------------------ utils */

function rnd(n: number): number {
  return Math.floor(Math.random() * n);
}

function pick<T>(arr: T[]): T {
  return arr[rnd(arr.length)];
}

export function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newCode(): string {
  // 紛らわしい文字を避ける
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[rnd(alphabet.length)];
  return out;
}

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 12);
}

function pushLog(room: Room, text: string, kind: LogEntry['kind'], now: number): void {
  room.logSeq += 1;
  room.log.push({ id: room.logSeq, at: now, text, kind });
  if (room.log.length > 40) room.log = room.log.slice(-40);
}

function alivePlayers(room: Room): Player[] {
  return room.players.filter((p) => p.alive);
}

function findPlayer(room: Room, id: string): Player | undefined {
  return room.players.find((p) => p.id === id);
}

function pickOther(room: Room, selfId: string): string {
  const others = alivePlayers(room).filter((p) => p.id !== selfId);
  if (others.length === 0) return selfId;
  return pick(others).id;
}

function baseDuration(): number {
  return MIN_MS + rnd(MAX_MS - MIN_MS + 1);
}

/** 加速 / 減速: そのプレイヤーが持っている間だけ秒数が伸縮する */
function applySpeed(duration: number, skill: Skill | null): number {
  if (skill === 'accelerate') return duration / SPEED_ACCELERATE;
  if (skill === 'decelerate') return duration / SPEED_DECELERATE;
  return duration;
}

/* ------------------------------------------------------------ bomb timing */

/** 爆弾を holderId に着地させる。回避の連鎖はここで処理する。 */
function landBomb(
  room: Room,
  holderId: string,
  now: number,
  opts: { fromId?: string | null; lockUntil?: number; hops?: number; carryMs?: number } = {},
): void {
  const holder = findPlayer(room, holderId);
  if (!holder) return;

  // carryMs があれば「渡ってきた残り時間」を引き継ぐ。なければ新しい爆弾。
  const raw = opts.carryMs !== undefined ? Math.max(1, opts.carryMs) : baseDuration();
  const duration = applySpeed(raw, holder.skill);

  const bomb: Bomb = {
    holderId: holder.id,
    fromId: opts.fromId ?? null,
    nextTargetId: pickOther(room, holder.id),
    deadline: now + duration,
    passableAt: opts.lockUntil ?? now,
    reveal: null,
  };
  room.bomb = bomb;
  pushLog(room, `${holder.name} に爆弾が渡った`, 'info', now);

  // 解析: 30% で残り時間を一瞬だけ本人にだけ見せる
  if (holder.skill === 'analyze' && Math.random() < ANALYZE_CHANCE) {
    bomb.reveal = { forId: holder.id, until: now + ANALYZE_SHOW_MS, ms: Math.round(duration) };
  }

  // 回避: 30% で受け取らずに即座に次の人へ
  const hops = opts.hops ?? 0;
  if (holder.skill === 'dodge' && hops < 4 && Math.random() < DODGE_CHANCE) {
    const others = alivePlayers(room).filter((p) => p.id !== holder.id);
    if (others.length > 0) {
      pushLog(room, `${holder.name} が回避！そのまま次の人へ`, 'good', now);
      // 保持時間は 0 なので、速度補正前の残り時間をそのまま次へ渡す
      landBomb(room, pick(others).id, now, { fromId: holder.id, hops: hops + 1, carryMs: raw });
    }
  }
}

function resolveExplosion(room: Room, now: number): void {
  const bomb = room.bomb;
  if (!bomb) return;
  const holder = findPlayer(room, bomb.holderId);
  room.bomb = null;
  if (!holder) return;

  const passer = bomb.fromId ? findPlayer(room, bomb.fromId) : undefined;
  const powerUp = !!passer && passer.skill === 'power';
  const damage = powerUp ? 2 : 1;

  holder.lives = Math.max(0, holder.lives - damage);
  if (powerUp) {
    pushLog(room, `強化！ ${holder.name} は ${damage} ライフを失った`, 'danger', now);
  } else {
    pushLog(room, `${holder.name} で爆発！ -${damage} ライフ`, 'danger', now);
  }

  if (holder.lives <= 0) {
    holder.alive = false;
    pushLog(room, `${holder.name} は脱落した`, 'warn', now);
  }

  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    room.phase = 'finished';
    room.winnerId = alive[0]?.id ?? null;
    pushLog(
      room,
      alive[0] ? `${alive[0].name} の勝ち！` : '全員爆発した…',
      'good',
      now,
    );
    return;
  }

  room.round += 1;
  landBomb(room, pick(alive).id, now, {});
}

/**
 * 期限切れの爆発を解決する。変更があれば true。
 * 取得のたびに呼ばれるので、誰か1人が見ていれば必ず爆発する。
 */
export function resolveDue(room: Room, now: number): boolean {
  if (room.phase !== 'playing' || !room.bomb) return false;
  if (now < room.bomb.deadline) return false;
  resolveExplosion(room, now);
  return true;
}

/* ------------------------------------------------------------------ setup */

export function newRoom(code: string, hostId: string, name: string, now: number): Room {
  return {
    code,
    hostId,
    phase: 'lobby',
    players: [{ id: hostId, name, skill: null, lives: MAX_LIVES, alive: true }],
    bomb: null,
    round: 0,
    winnerId: null,
    log: [],
    logSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function joinRoom(room: Room, pid: string, name: string, now: number): Res<Room> {
  if (room.phase !== 'lobby') return fail('ゲームが始まっているため参加できません');
  if (room.players.length >= MAX_PLAYERS) return fail('この部屋は満員です（8人まで）');
  room.players.push({ id: pid, name, skill: null, lives: MAX_LIVES, alive: true });
  pushLog(room, `${name} が参加した`, 'info', now);
  return ok(room);
}

export function chooseSkill(room: Room, pid: string, skill: unknown): Res<Room> {
  if (room.phase !== 'lobby') return fail('スキルはゲーム開始前だけ選べます');
  const player = findPlayer(room, pid);
  if (!player) return fail('プレイヤーが見つかりません');
  if (typeof skill !== 'string' || !SKILLS.includes(skill as Skill)) return fail('不明なスキルです');
  player.skill = skill as Skill;
  return ok(room);
}

export function startGame(room: Room, pid: string, now: number): Res<Room> {
  if (room.hostId !== pid) return fail('ホストだけが開始できます');
  if (room.phase !== 'lobby') return fail('すでに開始しています');
  if (room.players.length < 2) return fail('2人以上で始められます');

  for (const p of room.players) {
    p.lives = MAX_LIVES;
    p.alive = true;
    if (!p.skill) p.skill = pick([...SKILLS]);
  }
  room.phase = 'playing';
  room.round = 1;
  room.winnerId = null;
  room.log = [];
  room.logSeq = 0;
  room.bomb = null;
  pushLog(room, 'ゲーム開始！', 'good', now);
  landBomb(room, pick(room.players).id, now, {});
  return ok(room);
}

export function passBomb(room: Room, pid: string, now: number): Res<Room> {
  if (room.phase !== 'playing' || !room.bomb) return fail('ゲーム中ではありません');
  const bomb = room.bomb;
  if (bomb.holderId !== pid) return fail('爆弾を持っていません');
  if (now < bomb.passableAt) return fail('妨害中でタップできません');

  const holder = findPlayer(room, pid);
  if (!holder) return fail('プレイヤーが見つかりません');

  // タップが届く前に時間切れ → 爆発させて終わる (パスは無効)
  if (now >= bomb.deadline) {
    resolveExplosion(room, now);
    return ok(room);
  }

  // 妨害: 30% で受け取り手に 3 秒のタップ不可
  let lockUntil = now;
  if (holder.skill === 'block' && Math.random() < BLOCK_CHANCE) {
    lockUntil = now + BLOCK_MS;
  }

  const target = bomb.nextTargetId && findPlayer(room, bomb.nextTargetId)?.alive
    ? bomb.nextTargetId
    : pickOther(room, pid);

  if (lockUntil > now) {
    const receiver = findPlayer(room, target);
    if (receiver) {
      pushLog(room, `${holder.name} の妨害！ ${receiver.name} は3秒動けない`, 'warn', now);
    }
  }

  // 残り時間をそのまま引き継ぐ
  landBomb(room, target, now, { fromId: holder.id, lockUntil, carryMs: bomb.deadline - now });
  return ok(room);
}

export function rematch(room: Room, pid: string, now: number): Res<Room> {
  if (!findPlayer(room, pid)) return fail('プレイヤーが見つかりません');
  if (room.phase !== 'finished') return fail('まだゲーム中です');
  for (const p of room.players) {
    p.lives = MAX_LIVES;
    p.alive = true;
  }
  room.phase = 'lobby';
  room.bomb = null;
  room.winnerId = null;
  room.round = 0;
  room.log = [];
  room.logSeq = 0;
  pushLog(room, 'もう一度！スキルを選び直せます', 'info', now);
  return ok(room);
}

/* ----------------------------------------------------------- client state */

export interface PublicPlayer {
  id: string;
  name: string;
  skill: Skill | null;
  lives: number;
  alive: boolean;
  isHolder: boolean;
}

export interface PublicState {
  code: string;
  phase: Phase;
  hostId: string;
  round: number;
  winnerId: string | null;
  serverTime: number;
  me: {
    id: string;
    name: string;
    skill: Skill | null;
    lives: number;
    alive: boolean;
    isHost: boolean;
    isHolder: boolean;
    canPass: boolean;
    lockUntil: number;
    nextIsMe: boolean;
    revealMs: number;
    revealUntil: number;
  } | null;
  players: PublicPlayer[];
  log: LogEntry[];
}

/** クライアントへ送る形。残り時間・deadline は絶対に含めない。 */
export function publicState(room: Room, pid: string | null, now: number): PublicState {
  const bomb = room.bomb;
  const me = pid ? findPlayer(room, pid) : undefined;
  const reveal =
    bomb && bomb.reveal && bomb.reveal.forId === pid && now < bomb.reveal.until ? bomb.reveal : null;

  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    round: room.round,
    winnerId: room.winnerId,
    serverTime: now,
    me: me
      ? {
          id: me.id,
          name: me.name,
          skill: me.skill,
          lives: me.lives,
          alive: me.alive,
          isHost: me.id === room.hostId,
          isHolder: !!bomb && bomb.holderId === me.id,
          canPass: !!bomb && bomb.holderId === me.id && now >= bomb.passableAt,
          lockUntil: bomb && bomb.holderId === me.id && bomb.passableAt > now ? bomb.passableAt : 0,
          nextIsMe: !!bomb && me.skill === 'foresight' && bomb.nextTargetId === me.id,
          revealMs: reveal ? reveal.ms : 0,
          revealUntil: reveal ? reveal.until : 0,
        }
      : null,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      skill: p.skill,
      lives: p.lives,
      alive: p.alive,
      isHolder: !!bomb && bomb.holderId === p.id,
    })),
    log: room.log.slice(-14),
  };
}
