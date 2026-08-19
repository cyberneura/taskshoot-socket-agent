# taskshoot-socket-agent — AI エージェント向けガイド

Taskshoot のメンションに AI エージェントで自動返信する常駐デーモン。
エージェントのバックエンドは差し替え可能 (Claude Agent SDK / Hermes Agent CLI)。
概要・セットアップは README.md を参照。ここには開発時に繰り返し使う情報だけを書く。

## 技術スタック

- Node.js >= 20 / TypeScript (ESM, `type: module`)
- pnpm
- `@anthropic-ai/claude-agent-sdk` (バックエンド `claude`)
- Hermes Agent CLI (バックエンド `hermes`。npm 依存ではなくホストのコマンド)
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

`pnpm add -g --allow-build=taskshoot-socket-agent github:cyberneura/taskshoot-socket-agent`
でインストールできる (`prepare` が tsc を走らせるので dist をコミットしなくてよい)。
インストール時ビルドに依存しているため制約が 2 つある。実測で確認したもの:

- `--allow-build` が必要 (pnpm 10.29 で確認。10.17 では不要だった)。現行 pnpm は
  git 由来パッケージの build script を allowlist 無しでは実行しない
- **`npm install -g <git url>` は不可**: npm はグローバル git インストールで
  devDependencies を入れないため tsc が無い (`--include=dev` でも変わらない)

両方とも「インストール時にビルドする」ことが原因なので、npm レジストリへ公開すれば
消える (公開物には `files` の dist が入るのでビルド不要。`npm pack` の tarball を
`-g` インストールして確認済み)。未公開。公開は `npm login && npm publish`。

- `bin/taskshoot-socket-agent.mjs` — `bin` エントリ。`--version` / `--help` は
  dist/main.js を import せずに答える (import した時点でデーモンが起動して
  ロックを取るため、インストールの疎通確認ができなくなる)
- `files` に載っていないものは配布物に入らない。ソース追加時は確認する

## pnpm 11 とビルドスクリプト

`pnpm-workspace.yaml` の `allowBuilds: {esbuild: true}` は消さないこと。
pnpm 11 は未承認のビルドスクリプトがあると **install を失敗させる**
(`ERR_PNPM_IGNORED_BUILDS`、pnpm 10 は警告のみ)。`bin/start.sh` は `set -e` の下で
`pnpm install --frozen-lockfile` を実行するので、承認が無いと新しいホストでの初回起動が
そこで落ちる (node_modules と dist は作られるので supervisor の再試行では上がるが、
FATAL に見える起動失敗が毎回 1 回入る)。

キー名は pnpm 11 のもの。**`onlyBuiltDependencies` / `ignoredBuiltDependencies` は
11 では効かない** (10 向けの書き方。11.21 で実測)。ビルドスクリプトを持つ依存が増えたら
`pnpm approve-builds --all` を実行してこのファイルを更新する。

## 構成

- `src/main.ts` — エントリポイント。WS 購読 + ポーリングバックストップ + 直列キュー
- `src/listen.ts` — `taskshoot listen` (WebSocket, JSON Lines) の購読
- `src/taskshoot.ts` — taskshoot CLI の薄いラッパー (通知・既読・アクティビティ)
- `src/activity.ts` — 「回答を考えています…」インジケーター (タスクごとの参照カウント +
  promise チェーン直列化 + 全体セマフォ)
- `src/runner.ts` — バックエンドの選択 (`TSSA_AGENT_BACKEND`)
- `src/backends/types.ts` — バックエンドの契約 (`runAgent(prompt, opts) -> {result, sessionId}`)
- `src/backends/claude.ts` — Claude Agent SDK (既定)
- `src/backends/hermes.ts` — Hermes Agent CLI
- `src/shutdown.ts` — 停止状態 (受付を閉じる + クリーンアップ登録)
- `src/state.ts` — handled-id 台帳とセッション保存 (二重返信防止の正本)
- `skills/taskshoot-socket-agent/SKILL.md` — 配布用の agent skill
  (`npx skills add cyberneura/taskshoot-socket-agent`)。`.claude/skills/` には置かない
  (両方 discovery 対象なので二重に列挙される)

## 変更時の注意

- 停止時は「動いているものを止める」だけでは足りない。kill された run は reject するので
  キューが次のメンションを取り出し、猶予中に投稿してしまう。その返信は台帳に記録されない
  (記録するデーモンが落ちるため) ので、再起動後にもう一度投稿される。**受付を閉じる**のが
  対で必要。`src/shutdown.ts` がその正本。
- 二重返信防止は handled-id 台帳が正本。WS は ACK 無し・再接続時の catch-up 上限ありのため
  信頼しない設計。マーク順序 (read → ledger) には crash safety の理由がコメントで書いてある。
- アクティビティインジケーターは best-effort (失敗しても run を止めない)。並行性の不変条件
  (タスク単位の直列チェーン / refcount / セマフォの bounded fairness / TTL とリフレッシュ供給
  能力の関係) は `src/activity.ts` のコメントが正本。変更時はコメントの前提数値も更新する。
- **SKILL.md は README の要約にしない。** 読み手はこのアプリを OSS として入れた第三者と
  そのエージェントで、手元の環境・組織固有の名前・個人のパスは 1 つも書かない。
  記述は README ではなく**実装と照合する** (README 自身が留保を持つので、写すだけでは
  検証にならない。要約すると留保が落ちて断定になり、そのまま誤りになる)。
  散文は実行されないのでテストでは捕まらない。レビューを依頼する時は
  「文章の内容そのものがレビュー対象」「事実の裏取りをせよ」
  「このアプリを初めて入れた第三者の環境でも正しいか」を明示する。
  例: 状態ディレクトリの既定は `homedir()` から組み立てているので macOS でも
  `~/.local/state/...` になる (プラットフォームの規約には従わない)。
  「XDG に従う」と書くと誤りになる
- ソースに `\u0000` 等のエスケープを書く時、生成ツール経由で実バイトが混入すると git が
  ファイルをバイナリ扱いする。コミット前に `git diff --staged --stat` に `Bin` が無いことを
  確認する。
