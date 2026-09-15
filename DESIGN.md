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

- `rent.total` … 家賃+管理費・共益費の総額(円)
- `rent.effectiveTotal` … ネット無料の場合、`total - 5000`(はるかちゃんの換算ルール)
- `room.*` … 7つのboolean条件(`criteria.json`の`roomConditions`と1対1対応)
- `commute.minutes` / `commute.transfers` … 品川シーサイド駅までの所要時間・乗り換え回数
- `radar.roomAxes` / `radar.lifeAxes` … 0〜100点に変換済みのレーダー用スコア(下記4節)
- `score.total` / `score.matchPercent` … 総合点(0〜100)。基本的に同じ値を2箇所に持たせる
- `score.summary` … Geminiが生成する一言総評(マッチ度の理由を含む文章)
- `score.goodPoints` / `score.concernPoints` … 箇条書き(それぞれ2〜4個程度)

## 4. レーダーチャート(2種類)

### ①お部屋の中身レーダー(7軸、`criteria.json`の`roomConditions`と同じ並び)

広さ / バストイレ別 / ロフト付き / 収納付き / 洗濯機室内 / ネット無料 / 都市ガス

- boolean項目: あり=100点、なし=0点
- 「広さ」: `criteria.json`の`sizeScoring`(`minSqm`=15㎡→0点、`fullScoreSqm`=30㎡→100点)で線形換算し、
  範囲外は0〜100にクランプする。式: `score = clamp((sqm - minSqm) / (fullScoreSqm - minSqm) * 100, 0, 100)`

### ②お部屋+周辺環境レーダー(6軸)

1. `roomQuality` … ①の7軸の単純平均
2. `rentValue` … 家賃コスパ。`effectiveTotal`が`idealTotal`(7万円)以下なら100点、
   `maxTotal`(8万円)ちょうどで40点、それを超えたら0点、という区分線形
3. `commuteAccess` … 品川シーサイドまでの所要時間・乗り換え回数から算出。
   目安: 15分以内かつ乗り換え0回=100点、20分・乗り換え1回=70点、それを超えるごとに減点
4. `stationCloseness` … 最寄り駅徒歩分数。5分以内=100点、10分=70点、15分=40点、それ以上は減点
5. `dailyConvenience` … スーパー・BIZcomfort・図書館・カラオケ・ジムなど`criteria.json`の
   `dailyLife`/`surroundingWants`に該当する施設がどれだけ近くにあるか(Geminiが検索して推定)
6. `safety` … 治安・住環境(Geminiに検索させて推定。裏付けが取れない場合は60点程度の中立値にし、
   「未検証」であることを`surroundings.safetyNote`に明記する。捏造しないこと)

## 5. 総合点(score.total / matchPercent)

```
base = roomQuality*0.25 + rentValue*0.25 + commuteAccess*0.20
     + stationCloseness*0.15 + dailyConvenience*0.10 + safety*0.05
```

その上で、はるかちゃんの「絶対軸」を超える場合はペナルティを掛ける(条件を満たさない物件を
高得点にしないため):

- `rent.effectiveTotal > criteria.rent.maxTotal` → `base`を60%に減点
- `walkMinutesToStation > criteria.walkToStationMinutes.hardMax`(15分)→ `base`を70%に減点
- `commute.minutes > criteria.commute.maxMinutes`(20分) または `commute.transfers > criteria.commute.maxTransfers`(1回)→ `base`を80%に減点

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

## 9. 次のフェーズの要望(2026-09-16、実物件での動作確認後にはるかちゃんから)

デザインが固まってから着手する。以下は要望メモ(実装方法は未検討):

- 「通勤」は最初に「〇分(ドアツードア)」を明記する
- 物件の対象範囲は「徒歩20分前後(最長25分)」または「電車20分前後(最長25分)」で判定し、
  住所や最寄り駅までの徒歩時間そのものはフィルタ条件にしない(現行のwalkMinutesToStation
  ハードリミット15分は撤廃・緩和する)
- 最寄り駅までの徒歩分数は独立した表示項目にする
- 物件同士の比較機能(転職ジャーナルサイトの企業比較の仕組みを参考に)
- 「周辺」セクションの上に、最寄り駅・地域の特色を解説する項目を追加
- 「周辺」セクションは施設名+そこまでの所要時間を表示(品川図書館はデフォルトで表示)
- 間取り図・内装写真を元の物件ページから引用して表示
- ステータス(気になる/内見予約済み等)をサイト上で変更できるようにする
- ページ下部に、実際のポータルサイトのような詳細項目一覧を追加
