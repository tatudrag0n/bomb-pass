/**
 * 通算戦績・ランキング (D1)。
 * D1 が未接続でもゲーム本体は動くように、呼び出し側で env.DB の有無を判定する。
 */

const SCHEMA =
  'CREATE TABLE IF NOT EXISTS players (' +
  'key TEXT PRIMARY KEY, name TEXT NOT NULL, games INTEGER NOT NULL DEFAULT 0, ' +
  'wins INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)';

let ready: Promise<void> | null = null;

export function ensureStatsTable(db: D1Database): Promise<void> {
  if (!ready) {
    // exec() は文を分割して実行するため、DDL は prepare().run() で流す
    ready = db
      .prepare(SCHEMA)
      .run()
      .then(() => undefined)
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
}

export interface RankedRow extends RankRow {
  rank: number;
  winRate: number;
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

/** 1試合の結果を全参加者ぶん加算する */
export async function recordGame(
  db: D1Database,
  entries: GameEntry[],
  now: number,
): Promise<void> {
  await ensureStatsTable(db);
  const rows = entries.filter((e) => e.key);
  if (rows.length === 0) return;
  const stmts = rows.map((e) => db.prepare(UPSERT).bind(e.key, e.name, e.win ? 1 : 0, now));
  await db.batch(stmts);
}

export async function topPlayers(db: D1Database, limit: number): Promise<RankedRow[]> {
  await ensureStatsTable(db);
  const res = await db
    .prepare(
      'SELECT key, name, games, wins FROM players ORDER BY wins DESC, games DESC, updated_at DESC LIMIT ?',
    )
    .bind(limit)
    .all<RankRow>();
  return (res.results ?? []).map((r, i) => ({
    ...r,
    rank: i + 1,
    winRate: r.games > 0 ? r.wins / r.games : 0,
  }));
}

export async function playerStats(db: D1Database, key: string): Promise<RankedRow | null> {
  await ensureStatsTable(db);
  const row = await db
    .prepare('SELECT key, name, games, wins FROM players WHERE key = ?')
    .bind(key)
    .first<RankRow>();
  if (!row) return null;
  const better = await db
    .prepare('SELECT COUNT(*) AS c FROM players WHERE wins > ? OR (wins = ? AND games > ?)')
    .bind(row.wins, row.wins, row.games)
    .first<{ c: number }>();
  return {
    ...row,
    rank: (better?.c ?? 0) + 1,
    winRate: row.games > 0 ? row.wins / row.games : 0,
  };
}
