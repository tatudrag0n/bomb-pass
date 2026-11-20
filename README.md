# 💣 爆弾パス (Bomb Pass)

同じWiFiにつながったスマホ同士で遊ぶ、ホットポテト系パーティゲーム。
Cloudflare Workers + Durable Objects で動きます。外部DBの事前作成は不要です。

## あそびかた

- ライフは **3**。爆弾が爆発すると **1** 減る（**強化** スキルの相手なら 2）。
- 爆弾を持っている人が **タップ** すると、**ランダムな誰か** に渡る。次が誰かは誰にもわからない。
- 爆発までの秒数は毎回ランダムで、画面には **???** としか出ない。
- タイマーは渡してもリセットされない（渡している間も減り続ける）。
- ライフが尽きたら脱落。最後の1人が勝ち。

## スキル（開始時に1つ選択）

| スキル | 効果 |
| --- | --- |
| 🔍 解析 | 爆弾を手にした時、30% で残り時間が一瞬だけ見える |
| 🔮 予知 | 次に爆弾が自分に来るかわかる |
| ⚡ 加速 | 自分が持っている間、秒数が 1.5 倍速になる |
| 🧊 減速 | 自分が持っている間、秒数が 0.6 倍速になる |
| ⛓️ 妨害 | 渡す時、30% で受け取った人に 3 秒のタップ不可 |
| 🌀 回避 | 受け取る時、30% でスキップして即座に次の人へ |
| 💥 強化 | 自分が渡した相手がパスする前に爆発すると 2 ライフ削る |

## デプロイ（Cloudflare Workers）

このリポジトリは **追加リソースの作成なしで** `wrangler deploy` が通ります
（部屋の状態は Durable Objects が持ち、`migrations` によりデプロイ時に自動作成されます）。

```bash
npm install
npm run deploy      # wrangler deploy
```

Cloudflare ダッシュボードから GitHub リポジトリを接続する場合:

- ビルドコマンド: 不要（または `npm run build`）
- デプロイコマンド: `npx wrangler deploy`
- ルートディレクトリ: リポジトリ直下

カスタムドメイン（例: `bakudance.mct-official.com`）は
Worker の **Settings → Domains & Routes → Add custom domain** から追加します。
Cloudflare 管理下のドメインなら DNS レコードも自動で作られます。

## 同一WiFiでの遊び方

デプロイした URL に全員がアクセスするだけ。ホストが「部屋をつくる」→
4文字コード（またはリンク）を共有 → 参加、で対戦できます（最大8人）。
LAN 内だけで完結させたい場合は下のローカル起動を使ってください。

## 開発

```bash
npm install
npm run dev        # http://localhost:8787
npm run dev:lan    # 0.0.0.0 で待受（同じWiFiの実機から LAN IP:8787 へ）
npm run check      # 型チェック + バンドル
npm run sim        # 3人対戦を自動実行して爆発/ライフ減少を確認
```

`npm run sim` は `BASE_URL` を渡すとデプロイ先にも実行できます。

## 構成

- `src/game.ts` — ゲームルール（純粋ロジック）。爆発時刻・次の宛先はサーバーだけが知る。
- `src/room.ts` — 部屋ごとの Durable Object。状態の保存と API を担当。
- `src/index.ts` — `/api/*` を部屋の DO に振り分ける Worker。
- `public/` — 画面（バニラJS、250ms ポーリングで同期）。

## API

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/api/rooms` | 部屋作成 `{name}` |
| POST | `/api/rooms/:code/join` | 参加 `{name}` |
| GET | `/api/rooms/:code?pid=` | 状態取得（爆発の解決もここ） |
| POST | `/api/rooms/:code/skill` | スキル選択 `{pid, skill}` |
| POST | `/api/rooms/:code/start` | 開始（ホストのみ） |
| POST | `/api/rooms/:code/pass` | パス `{pid}` |
| POST | `/api/rooms/:code/rematch` | もう一度 |
