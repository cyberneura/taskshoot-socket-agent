# taskshoot-socket-agent — AI エージェント向けガイド

Taskshoot のメンションに Claude Agent SDK で自動返信する常駐デーモン。
概要・セットアップは README.md を参照。ここには開発時に繰り返し使う情報だけを書く。

## 技術スタック

- Node.js >= 20 / TypeScript (ESM, `type: module`)
- pnpm
- `@anthropic-ai/claude-agent-sdk`
- テスト: Node 標準の `node --test` + tsx (AAA パターン)

## コマンド

```shell
pnpm build        # tsc → dist/
pnpm check        # 型チェックのみ
pnpm test         # test/*.test.ts
pnpm dev          # tsx で直接起動 (要 taskshoot CLI 認証済み)
pnpm start        # dist/main.js を起動
```

## 配布

`pnpm add -g github:cyberneura/taskshoot-socket-agent` でインストールできる
(`prepare` が tsc を走らせるので dist をコミットしていなくてよい)。
**`npm install -g <git url>` は不可**: npm はグローバル git インストールで
devDependencies を入れないため tsc が無く prepare が失敗する (`--include=dev`
でも変わらない)。npm から入れられるようにするにはレジストリへの公開が要る
(公開物には `files` の dist が入るのでビルド不要)。未公開。

- `bin/taskshoot-socket-agent.mjs` — `bin` エントリ。`--version` / `--help` は
  dist/main.js を import せずに答える (import した時点でデーモンが起動して
  ロックを取るため、インストールの疎通確認ができなくなる)
- `files` に載っていないものは配布物に入らない。ソース追加時は確認する

## 構成

- `src/main.ts` — エントリポイント。WS 購読 + ポーリングバックストップ + 直列キュー
- `src/listen.ts` — `taskshoot listen` (WebSocket, JSON Lines) の購読
- `src/taskshoot.ts` — taskshoot CLI の薄いラッパー (通知・既読・アクティビティ)
- `src/activity.ts` — 「回答を考えています…」インジケーター (タスクごとの参照カウント +
  promise チェーン直列化 + 全体セマフォ)
- `src/runner.ts` — Claude Agent SDK の実行
- `src/state.ts` — handled-id 台帳とセッション保存 (二重返信防止の正本)

## 変更時の注意

- 二重返信防止は handled-id 台帳が正本。WS は ACK 無し・再接続時の catch-up 上限ありのため
  信頼しない設計。マーク順序 (read → ledger) には crash safety の理由がコメントで書いてある。
- アクティビティインジケーターは best-effort (失敗しても run を止めない)。並行性の不変条件
  (タスク単位の直列チェーン / refcount / セマフォの bounded fairness / TTL とリフレッシュ供給
  能力の関係) は `src/activity.ts` のコメントが正本。変更時はコメントの前提数値も更新する。
- ソースに `\u0000` 等のエスケープを書く時、生成ツール経由で実バイトが混入すると git が
  ファイルをバイナリ扱いする。コミット前に `git diff --staged --stat` に `Bin` が無いことを
  確認する。
