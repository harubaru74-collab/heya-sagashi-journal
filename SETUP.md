# セットアップ手順(はるかちゃん用)

## ステップ1: GitHub Pagesを有効にする

1. https://github.com/harubaru74-collab/heya-sagashi-journal を開く
2. 「Settings」タブ→左メニュー「Pages」
3. 「Build and deployment」の「Source」を**「Deploy from a branch」**にする
4. 「Branch」を**`main`**、フォルダを**`/docs`**にして「Save」
5. 数分待つと公開URLが表示される(例: `https://harubaru74-collab.github.io/heya-sagashi-journal/`)
   - `dekita-diary`と同じく、`robots.txt`で検索エンジンには載らない設定にしてあるけど、
     URLを知っていれば誰でも見られるので、人に教えたりSNSに貼ったりしないこと

## ステップ2: GASからコミットするためのトークンを作る

1. https://github.com/settings/personal-access-tokens/new を開く
2. Token name: `heya-sagashi-journal-gas` など
3. Repository access → Only select repositories → `heya-sagashi-journal`
4. Permissions → Repository permissions → **Contents** を **Read and write** に変更
5. 「Generate token」→ 表示された `github_pat_...` をコピーしてメモしておく(この画面を閉じると二度と見られない)

## ステップ3: ai-conciergeのApps Scriptにトークンを登録する

「チャットボット用」スプレッドシートのApps Scriptエディタで、
「⚙️ プロジェクトの設定」→「スクリプト プロパティ」に以下を追加:

| プロパティ名 | 値 |
|---|---|
| `ROOM_GITHUB_TOKEN` | ステップ2で作ったトークン(`github_pat_...`) |

(リポジトリ名・オーナー名はコードにデフォルト値が入っているので、通常は他の設定不要)

物件詳細ページの「ステータス」プルダウンは、ai-concierge側のGAS Webアプリ(いつものLINE
Webhookと同じデプロイ)を軽いAPIとして呼び出して更新している。合言葉(`ROOM_STATUS_TOKEN`)
はコードにデフォルト値が入っているので、こちらも通常は何もしなくてOK。もし合言葉を変えたく
なったら、`ai-concierge`のスクリプトプロパティ`ROOM_STATUS_TOKEN`と、この`docs/data/criteria.json`
の`statusUpdateApi.token`を**両方**同じ値に揃えること。

## ステップ4: 動作確認

1. LINEで「いえさがし (適当な賃貸物件ページのURL)」と送る
2. LINEにダイジェストが届くか確認
3. https://harubaru74-collab.github.io/heya-sagashi-journal/ を開いて、物件が一覧に増えているか確認
4. 物件詳細ページを開き、写真ギャラリーが表示されるか(横スクロールできるか)確認
5. 「ステータス」のプルダウンを変えてみて、数秒待ってからページを再読み込みし、
   変更が反映されているか確認
6. 一覧ページで2件以上「比較」にチェックを入れて、画面下に出るバーから「比較する」を
   押し、`compare.html`で並べて見られるか確認
7. サンプル物件(`sample-001`)が表示に混ざっているのはテスト用データなので、
   実物件が増えてきたら`docs/data/properties/sample-001.json`と
   `docs/data/index.json`内のサンプル行は削除してOK
