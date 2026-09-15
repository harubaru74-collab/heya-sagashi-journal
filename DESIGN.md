# 設計メモ(データ形式・スコア計算・GAS連携の仕様)

「土台」フェーズで決めた設計をまとめておく。`RoomSearch.gs`(ai-concierge側)を実装するときは
このドキュメントを正本にする。

## 1. 全体の流れ

1. LINEで「いえさがし (URL)」と送る
2. GASが`UrlFetchApp`でそのURLのHTMLを取得
3. Geminiに「このHTMLから物件情報を抽出して」と投げ、構造化データを受け取る
   (求人精査の`callJobReviewGemini_`と同じ、`[[KEY:value]]`形式のメタ行を使う方式を踏襲)
4. 抽出結果から `docs/data/properties/{id}.json` の形式を組み立て、レーダースコア・総合点を計算
5. LINEに簡易版ダイジェストを返信(見出し・マッチ度・総評・良い点/気になる点を2〜3個ずつ)
6. 同じ内容を、GitHub Contents API経由でこのリポジトリに直接コミット
   - `docs/data/properties/{id}.json` を新規作成
   - `docs/data/index.json` に物件サマリを1件追記して更新
7. サイトはfetchでJSONを読むだけなので、コミット後すぐに反映される(ビルド不要)

## 2. 物件ID

`{YYYYMMDD}-{ランダム4桁英数字}`(例: `20260915-a1b2`)。日付は登録日(JST)。
複数物件が同日に登録されてもぶつからないよう、ランダム部分を必ず付ける。

## 3. データスキーマ

`docs/data/properties/sample-001.json` を実例として参照。主なフィールド:

- `imageUrl` … 物件ページの`og:image`から拾った代表画像のURL(ダウンロード・再ホストはせず参照のみ)
- `rent.total` … 家賃+管理費・共益費の総額(円)
- `rent.effectiveTotal` … ネット無料の場合、`total - 5000`(はるかちゃんの換算ルール)
- `initialCostEstimate` … 初期費用の合計目安(円)
- `costBreakdown` … 初期費用の内訳。`[{label, amount}, ...]`(敷金・礼金・仲介手数料など)
- `room.*` … `criteria.json`の`roomConditions`と1対1対応する boolean条件(下記4節、12項目)
- `commute.minutes` / `commute.transfers` … 品川シーサイド駅までの所要時間・乗り換え回数
- `surroundings.areaGuide` … 最寄り駅・エリアの特色+治安住環境をまとめた200〜350字程度の解説文
- `surroundings.facilities` … 周辺施設。`[{name, minutes}, ...]`(品川図書館は必ず含める)
- `radar.lifeAxes` … 0〜100点に変換済みの「お部屋+周辺環境」レーダー用スコア(下記4節)
- `score.total` / `score.matchPercent` … 総合点(0〜100)。基本的に同じ値を2箇所に持たせる
- `score.summary` … Geminiが生成する一言総評(マッチ度の理由を含む文章)
- `score.goodPoints` / `score.concernPoints` … 箇条書き(それぞれ2〜4個程度)

## 4. 「お部屋の中身」チェックリスト + 「お部屋+周辺環境」レーダー

2026-09-16に、①のレーダーチャートを**チェックリスト形式**に変更した(ほとんどが有無=booleanで
5段階評価に向かないため)。以下がその仕様。

### ①お部屋の中身チェックリスト(`criteria.json`の`roomConditions`が正本、12項目)

広さ / バストイレ別 / ロフト付き / 収納付き / 洗濯機室内 / ネット無料 / 都市ガス /
2階以上 / エアコン / 洗面所独立 / 温水洗浄便座 / 浴室乾燥機

- **表示順=`criteria.json`の配列順**。並び替えたい場合は配列の順番を編集する
- 各項目に`weight`(初期値1)を持つ。**weightを上げるほど「重視する項目」として
  ②の`roomQuality`スコアへの影響が大きくなり、サイト上でも★マーク表示になる**。
  物件ごとではなく`criteria.json`1箇所の設定が全物件に一律で反映される
- boolean項目: あり=達成率100、なし=達成率0
- 「広さ」だけは`sizeScoring`(`minSqm`=15㎡→0、`fullScoreSqm`=30㎡→100)で連続値に線形換算
- サイトの表示順・weightと、GAS(`RoomSearch.gs`の`ROOM_CRITERIA_.roomConditions`)の並び順・
  weightは**手動で同期**が必要(自動連携はしていない。両方直すこと)

### ②お部屋+周辺環境レーダー(6軸、変更なし)

1. `roomQuality` … ①の重み付き加重平均。`sum(achievement_i * weight_i) / sum(weight_i)`
   (単純平均ではなく、重視項目ほど大きく効く計算式に変更済み)
2. `rentValue` … 家賃コスパ。`effectiveTotal`が`idealTotal`(7万円)以下なら100点、
   `maxTotal`(8万円)ちょうどで40点、それを超えたら0点、という区分線形
3. `commuteAccess` … 品川シーサイドまでの所要時間から算出(ドアツードアの合計時間だけを見る。
   住所・最寄り駅までの徒歩時間そのものはフィルタにしない)。
   目安: 理想20分以内=100点、それを超えた分だけ減点。乗り換えは参考程度に1回ごと軽く減点
4. `stationCloseness` … 最寄り駅徒歩分数(表示・参考用。ハードな足切りには使わない)。
   5分以内=100点、それ以上は緩やかに減点
5. `dailyConvenience` … スーパー・BIZcomfort・図書館・カラオケ・ジムなど`criteria.json`の
   `dailyLife`/`surroundingWants`に該当する施設がどれだけ近くにあるか(Geminiが検索して推定)
6. `safety` … 治安・住環境(Geminiに検索させて推定。裏付けが取れない場合は50点程度の中立値。
   実際の解説文は`surroundings.areaGuide`に書く。捏造しないこと)

## 5. 総合点(score.total / matchPercent)

```
base = roomQuality*0.25 + rentValue*0.25 + commuteAccess*0.20
     + stationCloseness*0.15 + dailyConvenience*0.10 + safety*0.05
```

その上で、はるかちゃんの「絶対軸」を超える場合はペナルティを掛ける(条件を満たさない物件を
高得点にしないため。**住所・最寄り駅徒歩分数・乗り換え回数はここでは判定しない**):

- `rent.effectiveTotal > criteria.rent.maxTotal` → `base`を60%に減点
- `commute.minutes > criteria.commute.maxMinutes`(25分)→ `base`を80%に減点

`score.total = score.matchPercent = round(base)` (0〜100にクランプ)

`grade`は目安: 85点以上=◎◎◎ / 70点以上=◎◎ / 55点以上=◎ / それ未満=△

## 6. GitHub Contents APIでのコミット方法(GAS実装メモ)

- 認証: Fine-grained Personal Access Token。対象リポジトリを`heya-sagashi-journal`のみに限定し、
  Permissions → Contents を「Read and write」にしたものを発行し、
  スクリプト プロパティ`ROOM_GITHUB_TOKEN`に保存する(SETUP.md参照)
- 新規ファイル作成: `PUT https://api.github.com/repos/{owner}/{repo}/contents/{path}`
  - body: `{ "message": "コミットメッセージ", "content": "(UTF-8→Base64エンコードした中身)", "branch": "main" }`
- 既存ファイル更新(`index.json`): 同じエンドポイントだが、まず`GET`で現在のファイルを取得して
  `sha`を読み取り、bodyに`"sha": "..."`を含めて`PUT`する(省略すると409エラーになる)
- 認証ヘッダ: `Authorization: Bearer {ROOM_GITHUB_TOKEN}` (`Accept: application/vnd.github+json`)
- GASの`UrlFetchApp.fetch`で`Utilities.base64Encode(Utilities.newBlob(jsonString, "application/json", "").getBytes())`
  のようにUTF-8バイト列からBase64を作る(絵文字を含む場合は文字コードのズレに注意)

## 7. LINEダイジェストのフォーマット(案)

```
【(サンプル)〇〇マンション】の比較、できたよ🏠✨

マッチ度: 81%(◎◎)
(一言総評)

◎ 良い点
・品川シーサイドまで乗り換えなし13分
・ネット無料で実質家賃6.6万円

△ 気になる点
・ロフトなし

詳しくはサイトで見てね → https://harubaru74-collab.github.io/heya-sagashi-journal/property.html?id=xxxx
```

## 8. まだ決めていない・次に詰める点

- HTMLからの物件情報抽出は、ポータルサイトごとにHTML構造が異なる。まずは1〜2サイトで
  実際にどこまで正しく抽出できるか試してから、プロンプトを調整する必要がある
- ポータルサイトの利用規約でスクレイピングが禁止されている場合があるため、
  「1人の個人が自分の物件検討のために1URLずつ手動で送る」用途に留め、大量取得・再配布はしない
- `dailyConvenience` / `safety`軸はGeminiの検索精度に依存するため、実際に使いながら
  プロンプトの調整が必要になりそう

## 9. 2026-09-16の改修で対応した内容

デザインを「パステルレインボー・ステッカー」に決定(手書き文字Yomogi×水色/ピンクのパステル)。
併せて以下を実装済み:

- ✅ 通勤は「〇分・乗り換え〇回」を明記(ドアツードア、住所・徒歩時間はフィルタから除外)
- ✅ 対象範囲を「ドアツードア20分前後・最長25分」だけで判定するよう変更(4節参照)
- ✅ 最寄り駅までの徒歩分数を独立表示項目に(ヘッダー直下)
- ✅ 「周辺」の上に`surroundings.areaGuide`(街・治安の解説文、200〜350字)を追加
- ✅ 「周辺」は`surroundings.facilities`(施設名+分数)を表示、品川図書館は必ず含める指示
- ✅ 代表画像(`imageUrl`、`og:image`から取得)をページ上部に表示
- ✅ ステータス変更はLINEで「いえさがし ○○、内見予約したよ」→ サイトに反映(GAS側で実装、
  サイト上の直接編集UIは書き込み権限をpublicなJSに埋め込めないため見送り)
- ✅ ページ下部の詳細テーブルに初期費用の内訳(`costBreakdown`)を追加
- ✅ お部屋の中身をレーダーからチェックリストに変更、重視項目(weight)の仕組みを追加(4節参照)
- ✅ チェックリストに新規5項目追加(2階以上・エアコン・洗面所独立・温水洗浄便座・浴室乾燥機)

### まだ手をつけていない項目

- 物件同士の比較機能(転職ジャーナルサイトの企業ランキングを参考にした仕組み)。
  次のフェーズでJobReview.gsの「これまでの求人一覧をGeminiに渡してランキングを作り直す」
  パターンを流用する想定
- 間取り図(内装写真とは別に、間取り図だけを狙って抽出する)は`imageUrl`(og:image汎用画像)
  止まり。ポータルサイトによっては間取り図がog:imageに出ない場合があるため要調整
- 並び替え・重視フラグは`criteria.json`を直接編集する運用(サイト上のドラッグUIではない)。
  もっと手軽に編集したくなったら、他の「型ファイル」同様の編集体験を検討する
