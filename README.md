# heya-sagashi-journal(お部屋探しジャーナル)

はるかちゃんの賃貸物件探しを、LINEbot(`ai-concierge`)と連携して自動で比較・可視化するサイト。
「できたこと日記」サイト(`dekita-diary`)と同じ運用方針(無料のGitHub Pages・非公開URL運用)。

## 仕組み

1. LINEで「いえさがし (物件ページのURL)」と送ると、`ai-concierge`(GAS)がまず簡易版をLINEで返信する。
2. 同時に`ai-concierge`が、物件情報をGitHub Contents API経由でこのリポジトリに直接コミットする
   (`docs/data/properties/{id}.json`を追加し、`docs/data/index.json`を更新するだけ。
   ビルドステップなし・GitHub Actionsも使わない)。
3. GitHub Pages(`docs/`)が最新の内容をそのまま配信する(静的HTML+JSがJSONをその場でfetchして描画)。

## このリポジトリの役割

- `docs/` … GitHub Pagesが配信する本体
  - `index.html` … 物件一覧(マッチ度順)
  - `property.html?id=xxx` … 物件詳細(レーダーチャート2種・マッチ度・総評)
  - `articles/` … 街紹介記事(手書き。記事内に条件に合う物件一覧を動的に埋め込み)
  - `app.js` … 共通のデータ読み込み・Chart.js描画ロジック
  - `data/criteria.json` … はるかちゃんの理想条件(家賃・通勤・部屋条件など)
  - `data/index.json` … 物件一覧のサマリ(一覧ページ用)
  - `data/properties/{id}.json` … 物件ごとの詳細データ(GASが書き込む本体)
- `DESIGN.md` … データ形式・レーダーチャートの軸・スコア計算式の仕様書(調整はここを見てから)
- `SETUP.md` … 初回セットアップ手順(GitHub Pages有効化・GASのトークン発行)

## 公開範囲について

`dekita-diary`と同じ方針: 無料でGitHub Pagesを使うためリポジトリ・サイトともにPublicだが、
`robots.txt`で検索エンジンには載せない設定にしている。家賃上限や希望エリアなど個人的な条件が
乗るため、URLは他人に教えないこと。
