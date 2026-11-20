/**
 * 通算戦績・ランキング (D1)。
 * D1 が未接続でもゲーム本体は動くように、呼び出し側で env.DB の有無を判定する。
 */

const SCHEMA =
  'CREATE TABLE IF NOT EXISTS players (' +
  'key TEXT PRIMARY KEY, name TEXT NOT NULL, games INTEGER NOT NULL DEFAULT 0, ' +
  'wins INTEGER NOT NULL DEFAULT 0, rating REAL NOT NULL DEFAULT 1000, ' +
  'rated_games INTEGER NOT NULL DEFAULT 0, rated_wins INTEGER NOT NULL DEFAULT 0, ' +
  'updated_at INTEGER NOT NULL)';

/** すでに存在するテーブルへ後から追加するレート用のカラム */
const RATING_COLUMNS = [
  'ALTER TABLE players ADD COLUMN rating REAL NOT NULL DEFAULT 1000',
  'ALTER TABLE players ADD COLUMN rated_games INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE players ADD COLUMN rated_wins INTEGER NOT NULL DEFAULT 0',
];

let ready: Promise<void> | null = null;

export function ensureStatsTable(db: D1Database): Promise<void> {
  if (!ready) {
    // exec() は文を分割して実行するため、DDL は prepare().run() で流す
    ready = db
      .prepare(SCHEMA)
      .run()
      .then(async () => {
        for (const sql of RATING_COLUMNS) {
          try {
            await db.prepare(sql).run();
          } catch (e) {
            // すでにあるカラムへの追加 (重複カラム) は無視する
            if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) throw e;
          }
        }
      })
      .catch((e) => {
        ready = null;
        throw e;
      });
  }
  return ready;
}

export interface RankRow {
  key: string;
  name: string;
  games: number;
  wins: number;
  rating: number;
  rated_games: number;
  rated_wins: number;
}

export interface RankedRow {
  key: string;
  name: string;
  games: number;
  wins: number;
  /** レート (ランダムマッチのみ)。表示は整数 */
  rating: number;
  ratedGames: number;
  ratedWins: number;
  /** レート順の順位。ランダムマッチ未経験は 0 */
  rank: number;
  winRate: number;
}

/** D1 の行 (snake_case) をクライアント向け (camelCase) に変換する */
function toRanked(r: RankRow, rank: number): RankedRow {
  return {
    key: r.key,
    name: r.name,
    games: r.games,
    wins: r.wins,
    rating: Math.round(r.rating ?? RATING_INITIAL),
    ratedGames: r.rated_games ?? 0,
    ratedWins: r.rated_wins ?? 0,
    rank,
    winRate: r.games > 0 ? r.wins / r.games : 0,
  };
}

const UPSERT = `INSERT INTO players (key, name, games, wins, updated_at) VALUES (?, ?, 1, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    name = excluded.name,
    games = players.games + 1,
    wins = players.wins + excluded.wins,
    updated_at = excluded.updated_at`;

export interface GameEntry {
  key: string;
  name: string;
  win: boolean;
}

/** レートの初期値と K 値 */
export const RATING_INITIAL = 1000;
export const RATING_K = 16;

export interface RatingDelta {
  key: string;
  delta: number;
  newRating: number;
}

/**
 * レート計算 (D1 に依存しない純粋関数)。
 * 勝者 W と各敗者 L について、E_L は敗者 L の勝率期待値
 *   E_L = 1 / (1 + 10^((R_W - R_L) / 400))
 * 敗者の減少量 = round(16 * E_L)、勝者の増加量 = 敗者たちの減少量の平均 (round)。
 * 互角なら ±8、格上に勝つと大きく増え、格下に勝つと少しだけ増える。
 */
export function computeRatingChanges(
  winner: { key: string; rating: number },
  losers: { key: string; rating: number }[],
): RatingDelta[] {
  const decreases = losers.map((l) => {
    const expected = 1 / (1 + Math.pow(10, (winner.rating - l.rating) / 400));
    return Math.round(RATING_K * expected);
  });
  const gain =
    decreases.length > 0
      ? Math.round(decreases.reduce((a, b) => a + b, 0) / decreases.length)
      : 0;
  return [
    { key: winner.key, delta: gain, newRating: winner.rating + gain },
    ...losers.map((l, i) => ({
      key: l.key,
      delta: -decreases[i],
      newRating: l.rating - decreases[i],
    })),
  ];
}

/**
 * 1試合の結果を全参加者ぶん加算する。games/wins は全試合で加算し、
 * rated のときだけレートも更新する (ランダムマッチの試合だけが対象)。
 */
export async function recordGame(
  db: D1Database,
  entries: GameEntry[],
  now: number,
  opts: { rated?: boolean } = {},
): Promise<void> {
  await ensureStatsTable(db);
  const rows = entries.filter((e) => e.key);
  if (rows.length === 0) return;
  const stmts = rows.map((e) => db.prepare(UPSERT).bind(e.key, e.name, e.win ? 1 : 0, now));
  await db.batch(stmts);

  if (!opts.rated) return;
  const winner = rows.find((e) => e.win);
  if (!winner) return;
  const keys = rows.map((e) => e.key);
  const placeholders = keys.map(() => '?').join(',');
  const res = await db
    .prepare(`SELECT key, rating FROM players WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; rating: number }>();
  const ratings = new Map((res.results ?? []).map((r) => [r.key, r.rating ?? RATING_INITIAL]));
  const losers = rows
    .filter((e) => !e.win)
    .map((e) => ({ key: e.key, rating: ratings.get(e.key) ?? RATING_INITIAL }));
  const changes = computeRatingChanges(
    { key: winner.key, rating: ratings.get(winner.key) ?? RATING_INITIAL },
    losers,
  );
  const updates = changes.map((c) =>
    db
      .prepare(
        'UPDATE players SET rating = ?, rated_games = rated_games + 1, rated_wins = rated_wins + ? WHERE key = ?',
      )
      .bind(c.newRating, c.key === winner.key ? 1 : 0, c.key),
  );
  if (updates.length > 0) await db.batch(updates);
}

/** ランダムマッチのレート順ランキング (rated_games > 0 のプレイヤーのみ) */
export async function topPlayers(db: D1Database, limit: number): Promise<RankedRow[]> {
  await ensureStatsTable(db);
  const res = await db
    .prepare(
      'SELECT key, name, games, wins, rating, rated_games, rated_wins FROM players WHERE rated_games > 0 ORDER BY rating DESC, rated_wins DESC, updated_at DESC LIMIT ?',
    )
    .bind(limit)
    .all<RankRow>();
  return (res.results ?? []).map((r, i) => toRanked(r, i + 1));
}

export async function playerStats(db: D1Database, key: string): Promise<RankedRow | null> {
  await ensureStatsTable(db);
  const row = await db
    .prepare('SELECT key, name, games, wins, rating, rated_games, rated_wins FROM players WHERE key = ?')
    .bind(key)
    .first<RankRow>();
  if (!row) return null;
  const rating = row.rating ?? RATING_INITIAL;
  const ratedGames = row.rated_games ?? 0;
  // ランダムマッチ未経験は順位なし (0)。経験者のみレート順で順位を数える。
  let rank = 0;
  if (ratedGames > 0) {
    const better = await db
      .prepare(
        'SELECT COUNT(*) AS c FROM players WHERE rated_games > 0 AND (rating > ? OR (rating = ? AND rated_wins > ?))',
      )
      .bind(rating, rating, row.rated_wins ?? 0)
      .first<{ c: number }>();
    rank = (better?.c ?? 0) + 1;
  }
  return toRanked(row, rank);
}
