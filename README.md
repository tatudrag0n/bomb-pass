# 💣 爆弾パス (Bomb Pass)

同じWiFiにつながったスマホ同士で遊ぶ、ホットポテト系パーティゲーム。
Cloudflare Workers + Durable Objects で動きます。D1 は通算戦績・ランキング用です。

## あそびかた

- ライフは **3**。爆弾が爆発すると **1** 減る（**強化** スキルの相手なら 2）。
- 爆弾を持っている人が **タップ** すると、**ランダムな誰か** に渡る。次が誰かは誰にもわからない。
- 爆弾を受け取った直後は、**生存人数×0.25秒（最大2秒）** のクールダウンがあり、その間は渡せない。
- 爆発までの秒数は毎回ランダム（6〜12秒）。ラウンド開始時に爆弾の長さが表示されるが、残り時間は画面に出ない（**???**）。
- タイマーは渡してもリセットされない（渡している間も減り続ける）。
- ライフが尽きたら脱落。最後の1人が勝ち。

## スキル（開始時に1つ選択）

| スキル | 効果 |
| --- | --- |
| 🔍 解析 | 爆弾を手にした時、30% で残り時間が一瞬だけ見える |
| 🔮 予知 | 次に爆弾が自分に来るかわかる |
| ⚡ 加速 | 自分が持っている間、秒数が 1.5 倍速になる |
| 🧊 減速 | 自分が持っている間、秒数が 0.6 倍速になる |
| ⛓️ 妨害 | 渡す時、30% で受け取った人に 3 秒のタップ不可（1試合1回まで） |
| 🌀 回避 | 受け取る時、30% でスキップして即座に次の人へ |
| 💥 強化 | 自分が渡した相手がパスする前に爆発すると 2 ライフ削る |

## 部屋検索

ホーム画面の **「部屋をさがす」** で、いま募集中の部屋（部屋コード・ホスト名・人数）が一覧表示されます。
行の「参加」を押すだけでその部屋に入れます（5秒ごとに自動更新）。

一覧は `LobbyDO`（Durable Object）が持ち、各部屋から「募集している」状態だけを集約しています。
ゲーム開始・満員になった部屋は一覧から消え、誰も参加していない部屋は更新が止まって 40 秒で自動的に消えます。

## 通算戦績・ランキング（D1）

決着した試合は、参加者全員の通算成績（試合数・勝利数）として D1 に1回だけ記録されます。
プレイヤーの識別はブラウザに保存される匿名ID（`bombpass.profile.v1`）です。
D1 を外すとこの機能だけが無効になり、ゲームは通常どおり動きます。

このリポジトリは D1（`bakudance`）に接続済みです。設定は `wrangler.jsonc` の以下だけで、
テーブル（`players`）は初回アクセス時に自動作成されるため、手動のマイグレーションは不要です。

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "bakudance", "database_id": "1ec282c6-eea1-47ef-a46b-b0979fa1f9c3" }
],
```

別の環境で動かすときは、この `database_id`（と `database_name`）を自分の D1 のものに差し替えて再デプロイしてください。
このブロックごと削除するとランキング機能だけが無効になります。

ランキングはホーム画面の「ランキングを見る」で表示され、リザルト画面に自分の通算成績が出ます。

## デプロイ（Cloudflare Workers）

**追加リソースの作成なしで** `wrangler deploy` が通ります
（部屋の状態は Durable Objects が持ち、`migrations` によりデプロイ時に自動作成されます）。

```bash
npm install
npm run deploy      # wrangler deploy
```

Cloudflare ダッシュボードから GitHub リポジトリを接続する場合:

- ビルドコマンド: 不要（または `npm run build`）
- デプロイコマンド: `npx wrangler deploy`
- ルートディレクトリ: リポジトリ直下

公開 URL は **https://bakudance.mct-official.com**（Worker にカスタムドメインを接続済み）。
別のドメインを使う場合は Worker の **Settings → Domains & Routes → Add custom domain** から追加します。
Cloudflare 管理下のドメインなら DNS レコードも自動で作られます。

## 同一WiFiでの遊び方

デプロイした URL に全員がアクセスするだけ。ホストが「部屋をつくる」→
4文字コード（またはリンク）を共有 → 参加、で対戦できます（最大8人）。
コードを知らなくても「部屋をさがす」から募集中の部屋に入れます。
LAN 内だけで完結させたい場合は下のローカル起動を使ってください。

## 開発

```bash
npm install
npm run dev        # http://localhost:8787
npm run dev:lan    # 0.0.0.0 で待受（同じWiFiの実機から LAN IP:8787 へ）
npm run check      # 型チェック + バンドル
npm run sim        # 3人対戦を自動実行して爆発/ライフ減少/戦績更新を確認
```

`npm run sim` は `BASE_URL` を渡すとデプロイ先にも実行できます。
ローカル開発でも D1 は Miniflare のローカル SQLite に記録されるので、本番のデータには触れません。
本番の `bakudance` は `npx wrangler d1 execute bakudance --remote --command "SELECT * FROM players"` で確認できます。

## 構成

- `src/game.ts` — ゲームルール（純粋ロジック）。爆発時刻・次の宛先はサーバーだけが知る。
- `src/room.ts` — 部屋ごとの Durable Object。状態の保存と API を担当。
- `src/lobby.ts` — 募集中の部屋を集約する Durable Object（部屋検索）。
- `src/index.ts` — `/api/*` を部屋の DO に振り分ける Worker、ランキング API。
- `src/stats.ts` — D1 の通算戦績・ランキング。
- `public/` — 画面（バニラJS、250ms ポーリングで同期）。

## API

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/rooms` | 募集中の部屋一覧（部屋検索） |
| POST | `/api/rooms` | 部屋作成 `{name, playerKey}` |
| POST | `/api/rooms/:code/join` | 参加 `{name, playerKey}` |
| GET | `/api/rooms/:code?pid=` | 状態取得（爆発の解決もここ） |
| POST | `/api/rooms/:code/skill` | スキル選択 `{pid, skill}` |
| POST | `/api/rooms/:code/start` | 開始（ホストのみ） |
| POST | `/api/rooms/:code/pass` | パス `{pid}` |
| POST | `/api/rooms/:code/rematch` | もう一度 |
| GET | `/api/ranking?key=&limit=` | 上位ランキングと自分の通算成績 |
