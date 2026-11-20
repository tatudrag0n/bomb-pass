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
 *    残り時間はつねに「導火線の残量」(速度補正なしの時間) で受け渡しし、
 *    各所持者の速度はその区間の実時間への換算にだけ使う。
 *    そうしないと減速の所持者を経由するたびに残量が 1/0.6 倍に膨らむ。
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
export type Phase = 'lobby' | 'playing' | 'finished' | 'closed';

export const MAX_LIVES = 3;
export const MAX_PLAYERS = 8;

/** 爆弾の基本寿命 (ランダム範囲, ms) */
const MIN_MS = 6000;
const MAX_MS = 12000;

/** 渡すボタンのクールダウン: 生存人数 × この値 (ms)。ボタンは爆弾を持っていないときも押せるが、押すたびにこのクールダウンが入る */
const PASS_COOLDOWN_PER_PLAYER_MS = 250;
/** クールダウンの上限 (ms) */
const PASS_COOLDOWN_MAX_MS = 2000;

/** スキル確率・効果 */
const ANALYZE_CHANCE = 0.3;
const ANALYZE_SHOW_MS = 1400;
const BLOCK_CHANCE = 0.3;
const BLOCK_MS = 1000;
const DODGE_CHANCE = 0.3;
const SPEED_ACCELERATE = 1.5;
const SPEED_DECELERATE = 0.6;

export interface Player {
  id: string;
  /** 端末をまたいだ通算戦績のキー (ブラウザに保存される匿名ID) */
  key: string;
  name: string;
  skill: Skill | null;
  /** 渡すボタンのクールダウン明け時刻 (サーバー時刻)。0 = 押せる */
  passReadyAt: number;
  lives: number;
  alive: boolean;
}

export interface Bomb {
  holderId: string;
  /** この爆弾の元の長さ (ms)。ラウンド開始時に表示する用。パスでは引き継ぐ */
  fuseMs: number;
  /** この爆弾を手渡した人 (強化スキル判定用) */
  fromId: string | null;
  /** 次に受け取る人 (予知スキル用) */
  nextTargetId: string | null;
  /** サーバー時刻での爆発時刻 */
  deadline: number;
  /** この時刻までタップ不可 (妨害スキルのロックだけ。受け取り直後のクールダウンはない) */
  passableAt: number;
  /** タップ不可の理由 ('block' = 妨害)。ロック中でなければ意味を持たない */
  lockKind: 'block';
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
  /** この試合の結果を D1 に記録済みか */
  recorded: boolean;
  /** ランダムマッチの部屋か (自動開始・レート対象) */
  matchmaking: boolean;
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

/**
 * ニックネームの禁止ワード。サーバー (game.ts) とクライアント (app.js) の
 * 2か所に同じリストがある。変えるときは両方変えること。
 */
export const BANNED_NAME_WORDS: string[] = [
  // 性的
  'ちんこ', 'ちんぽ', 'まんこ', 'おっぱい', 'セックス', 'えろ', 'オナニー', 'ペニス',
  // 排泄物
  'うんこ', 'うんち', 'くそ',
  // 侮辱・差別
  'ばか', 'バカ', '馬鹿', 'あほ', 'アホ', 'きちがい', 'きもい',
  // 脅迫
  '死ね', 'しね', '殺す', 'ころす', 'くたばれ',
  // なりすまし
  '運営', '公式', '管理者', '管理人', '運営者', 'admin', 'staff', 'スタッフ',
  // 英語
  'fuck', 'shit', 'bitch', 'dick', 'pussy', 'cock', 'sex', 'porn',
];

/** カタカナをひらがなに寄せる (全角→半角は NFKC で済ませる) */
function toHiragana(s: string): string {
  return s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 名前を判定用に正規化する (NFKC・カタカナ→ひらがな・小文字化・空白除去) */
function normalizeForNameCheck(s: string): string {
  return toHiragana(s.normalize('NFKC')).toLowerCase().replace(/\s+/g, '');
}

/** 禁止ワードを含む名前か (部分一致)。空文字は false (空の判定は cleanName 側)。 */
export function isInappropriateName(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const name = normalizeForNameCheck(raw);
  if (!name) return false;
  return BANNED_NAME_WORDS.some((w) => name.includes(normalizeForNameCheck(w)));
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
  return duration / speedFactor(skill);
}

/** そのプレイヤーが持っている間の導火線の進み方 (加速 1.5倍速 / 減速 0.6倍速 / それ以外は等速) */
function speedFactor(skill: Skill | null): number {
  if (skill === 'accelerate') return SPEED_ACCELERATE;
  if (skill === 'decelerate') return SPEED_DECELERATE;
  return 1;
}

/** 渡すボタンのクールダウン: 生存人数 × 250ms (最大2秒) */
function buttonCooldownMs(room: Room): number {
  return Math.min(PASS_COOLDOWN_MAX_MS, PASS_COOLDOWN_PER_PLAYER_MS * alivePlayers(room).length);
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
  // fuseMs は爆弾の元の長さ。パスでは前の爆弾の値を引き継ぐ。
  const fuseMs = opts.carryMs !== undefined ? (room.bomb?.fuseMs ?? raw) : raw;

  // 受け取り直後のクールダウンはなし。渡すボタンのクールダウンは各プレイヤー持ち
  // (passReadyAt) で、持っていないときのタップでも消費される。
  // ここで残るタップ不可は妨害スキルのロック (1秒) だけ。
  const passableAt = opts.lockUntil ?? now;
  const lockKind: 'block' = 'block';

  const bomb: Bomb = {
    holderId: holder.id,
    fuseMs,
    fromId: opts.fromId ?? null,
    nextTargetId: pickOther(room, holder.id),
    deadline: now + duration,
    passableAt,
    lockKind,
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

export function newRoom(
  code: string,
  hostId: string,
  name: string,
  key: string,
  now: number,
  matchmaking = false,
): Room {
  return {
    code,
    hostId,
    phase: 'lobby',
    players: [{ id: hostId, key, name, skill: null, passReadyAt: 0, lives: MAX_LIVES, alive: true }],
    bomb: null,
    round: 0,
    winnerId: null,
    log: [],
    logSeq: 0,
    recorded: false,
    matchmaking,
    createdAt: now,
    updatedAt: now,
  };
}

export function joinRoom(
  room: Room,
  pid: string,
  name: string,
  key: string,
  now: number,
): Res<Room> {
  if (room.phase !== 'lobby') return fail('ゲームが始まっているため参加できません');
  if (room.players.length >= MAX_PLAYERS) return fail('この部屋は満員です（8人まで）');
  room.players.push({ id: pid, key, name, skill: null, passReadyAt: 0, lives: MAX_LIVES, alive: true });
  pushLog(room, `${name} が参加した`, 'info', now);
  return ok(room);
}

/**
 * 退出する。部屋主が抜けたら部屋ごと閉じる。
 * 爆弾を持っていたら、導火線の残量を引き継いで他の生存者に渡す。
 */
export function leaveRoom(room: Room, pid: string, now: number): Res<{ closed: boolean }> {
  const player = findPlayer(room, pid);
  if (!player) return fail('プレイヤーが見つかりません');

  // 部屋主が抜けたら部屋ごと閉じる (残りの人はポーリングでホームに戻る)
  if (room.hostId === pid) {
    room.phase = 'closed';
    room.bomb = null;
    room.players = [];
    room.winnerId = null;
    return ok({ closed: true });
  }

  const wasHolder = room.phase === 'playing' && room.bomb?.holderId === pid;
  // 導火線の残量を引き継ぐ (減速の所持者の分も速度係数で戻す)
  const carryMs =
    wasHolder && room.bomb
      ? Math.max(1, (room.bomb.deadline - now) * speedFactor(player.skill))
      : undefined;

  room.players = room.players.filter((p) => p.id !== pid);
  pushLog(room, `${player.name} が抜けました`, 'info', now);

  if (room.phase === 'playing') {
    const alive = alivePlayers(room);
    if (alive.length <= 1) {
      room.phase = 'finished';
      room.winnerId = alive[0]?.id ?? null;
      room.bomb = null;
      pushLog(room, alive[0] ? `${alive[0].name} の勝ち！` : '全員いなくなった…', 'good', now);
    } else if (wasHolder && carryMs !== undefined) {
      landBomb(room, pick(alive).id, now, { carryMs });
    }
  }
  return ok({ closed: false });
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
    p.passReadyAt = 0;
    if (!p.skill) p.skill = pick([...SKILLS]);
  }
  room.phase = 'playing';
  room.round = 1;
  room.winnerId = null;
  room.recorded = false;
  room.log = [];
  room.logSeq = 0;
  room.bomb = null;
  pushLog(room, 'ゲーム開始！', 'good', now);
  landBomb(room, pick(room.players).id, now, {});
  return ok(room);
}

/** ランダムマッチ: この人数で即開始 */
const MATCHMAKING_FULL_PLAYERS = 4;
/** ランダムマッチ: この人数以上いればこの時間で開始 */
const MATCHMAKING_MIN_PLAYERS = 2;
const MATCHMAKING_WAIT_MS = 30_000;

/**
 * ランダムマッチ部屋の自動開始。条件を満たせばホストとして開始する。
 * join 直後と GET ポーリングの両方から呼ぶ。開始したら true。
 * 友達の部屋 (matchmaking でない部屋) では開始しない。
 */
export function maybeAutoStartMatchmaking(room: Room, now: number): boolean {
  if (!room.matchmaking || room.phase !== 'lobby') return false;
  const n = room.players.length;
  if (n >= MATCHMAKING_FULL_PLAYERS) return startGame(room, room.hostId, now).ok;
  if (n >= MATCHMAKING_MIN_PLAYERS && now - room.createdAt >= MATCHMAKING_WAIT_MS) {
    return startGame(room, room.hostId, now).ok;
  }
  return false;
}

export function passBomb(room: Room, pid: string, now: number): Res<Room> {
  if (room.phase !== 'playing' || !room.bomb) return fail('ゲーム中ではありません');
  const bomb = room.bomb;

  const holder = findPlayer(room, pid);
  if (!holder) return fail('プレイヤーが見つかりません');
  if (!holder.alive) return fail('脱落しています');
  if (now < holder.passReadyAt) return fail('ボタンのクールダウン中です');

  // 爆弾を持っていないときのタップは空振り。クールダウンだけ消費する。
  // 連打すると爆弾が来たときにすぐ返せなくなる。
  if (bomb.holderId !== pid) {
    holder.passReadyAt = now + buttonCooldownMs(room);
    return ok(room);
  }

  // 妨害スキルのロック中はタップできない
  if (now < bomb.passableAt) return fail('妨害中でタップできません');

  // タップが届く前に時間切れ → 爆発させて終わる (パスは無効)
  if (now >= bomb.deadline) {
    resolveExplosion(room, now);
    return ok(room);
  }

  // 妨害: 30% で受け取り手に 1 秒のタップ不可 (回数制限なし)
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
      pushLog(room, `${holder.name} の妨害！ ${receiver.name} は1秒動けない`, 'warn', now);
    }
  }

  // 渡せたら自分のボタンにクールダウンを付ける
  holder.passReadyAt = now + buttonCooldownMs(room);

  // 残り時間を「導火線の残量」として引き継ぐ。deadline - now は今の所持者の
  // 速度で換算された実時間なので、所持者の速度係数を掛けて導火線時間に戻す。
  // そのまま渡すと、減速の所持者を経由するたびに残量が 1/0.6 倍に膨らみ、
  // 加速の所持者では逆に縮んでしまう。
  const carryMs = (bomb.deadline - now) * speedFactor(holder.skill);
  landBomb(room, target, now, { fromId: holder.id, lockUntil, carryMs });
  return ok(room);
}

export function rematch(room: Room, pid: string, now: number): Res<Room> {
  if (!findPlayer(room, pid)) return fail('プレイヤーが見つかりません');
  if (room.phase !== 'finished') return fail('まだゲーム中です');
  for (const p of room.players) {
    p.lives = MAX_LIVES;
    p.alive = true;
    p.passReadyAt = 0;
  }
  room.phase = 'lobby';
  room.bomb = null;
  room.winnerId = null;
  room.round = 0;
  room.recorded = false;
  // ランダムマッチは1試合かぎり。もう一度遊ぶときは友達の部屋 (手動開始) になる。
  room.matchmaking = false;
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
  /** ランダムマッチの部屋か */
  matchmaking: boolean;
  /** 部屋作成時刻 (サーバー時刻)。ランダムマッチの自動開始までの目安に使う */
  createdAt: number;
  /** 今の爆弾の元の長さ (ms)。0 のときは爆弾なし */
  fuseMs: number;
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
    /** タップ不可の理由。ロック中でなければ null */
    lockKind: 'block' | null;
    /** 渡すボタンのクールダウン明け時刻 (サーバー時刻) */
    btnReadyAt: number;
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
    matchmaking: room.matchmaking ?? false,
    createdAt: room.createdAt,
    fuseMs: bomb ? bomb.fuseMs : 0,
    me: me
      ? {
          id: me.id,
          name: me.name,
          skill: me.skill,
          lives: me.lives,
          alive: me.alive,
          isHost: me.id === room.hostId,
          isHolder: !!bomb && bomb.holderId === me.id,
          canPass:
            !!bomb && bomb.holderId === me.id && now >= bomb.passableAt && now >= me.passReadyAt,
          lockUntil: bomb && bomb.holderId === me.id && bomb.passableAt > now ? bomb.passableAt : 0,
          lockKind:
            bomb && bomb.holderId === me.id && bomb.passableAt > now ? bomb.lockKind : null,
          btnReadyAt: me.passReadyAt,
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
