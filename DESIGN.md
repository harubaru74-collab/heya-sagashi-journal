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
- ✅ ページ下部の詳細テーブルに初期費用の内訳(`costBreakdown`)を追加
- ✅ お部屋の中身をレーダーからチェックリストに変更、重視項目(weight)の仕組みを追加(4節参照)
- ✅ チェックリストに新規5項目追加(2階以上・エアコン・洗面所独立・温水洗浄便座・浴室乾燥機)

## 10. 2026-09-16(2回目)の改修で対応した内容

実物件での見た目確認後にもらった追加フィードバックへの対応。

- ✅ **写真ギャラリー化**: `imageUrl`(単数)をやめ、`images`(配列)に変更。物件ページのJSON-LD
  (`schema.org`の`image`フィールド)→無ければ`<meta property="og:image">`の全出現(複数タグ
  あれば全部拾う)、の優先順で最大30枚まで収集。サイト側は横スクロールギャラリーで表示し、
  タップで元画像を新規タブで開く(`RoomSearch.gs`の`extractPropertyImages_`参照)
- ✅ **チェックリストの表示順を固定**: 広さ/都市ガス、エアコン/2階以上、バストイレ別/洗面所独立、
  洗濯機室内/温水洗浄便座、収納付き/浴室乾燥機、ネット無料/ロフト付き、の2列×6行になるよう
  `criteria.json`の`roomConditions`配列の順序を確定(GAS側`ROOM_CRITERIA_.roomConditions`も同順に同期済み)
- ✅ **チェックリストの色を濃く**: `--good-bg`を濃い緑の塗りつぶし+白文字に変更(パステルの薄い
  緑地×緑文字だと視認性が低かったため)
- ✅ **レーダー軸ラベルの下に実データの一言を表示**: Chart.jsの`pointLabels.callback`で2行表示
  (例:「通勤アクセス」の下に「13分」)。`app.js`の`buildLifeAxisCaptions()`参照
- ✅ **周辺施設の表示を「○m 徒歩○分」に**: 徒歩1分=80mの不動産表示慣例で分数→メートル換算
  (`app.js`の`minutesToMeters()`)。Gemini側にメートル数を聞く必要はない
- ✅ **初期費用目安・通勤をコンパクトな1行表示に変更**: 内訳・経路を別行(sub-row)にせず、
  同じセル内に「合計(内訳を・区切りで列挙)」「○分(乗り換え○回)+経路を小さく添える」という
  1項目1行の表示に変更
- ✅ **ステータス変更をサイト上のプルダウンで直接できるように変更**(LINEでの更新は廃止):
  `ai-concierge`のApps Scriptに`doGet(e)`を追加し、既存のWebhookデプロイをそのまま軽量な
  ステータス更新APIとしても使う設計にした。GitHubへの書き込み権限(PAT)は引き続きGAS側の
  スクリプトプロパティに留め、クライアント側には一切渡さない。サイトの`criteria.json`の
  `statusUpdateApi.token`(簡易ないたずら防止の合言葉。GitHub PATのような強い権限は持たない)
  で軽く検証してから更新する。CORSの都合上レスポンスは読めないため、サイト側は
  `fetch(url, {mode:"no-cors"})`で送りっぱなしにし、数秒待ってねと案内するだけに留めている
- ✅ **物件同士の比較機能**: `compare.html`を新設。一覧ページの各カードに「比較」チェックボックス
  を追加し、2件以上選ぶと画面下に浮動バーが出て`compare.html?ids=a,b,c`に遷移する。
  比較ページは`criteria.roomConditions`の全項目+主要指標(マッチ度・家賃・通勤等、より良い方に
  ★枠を表示)を並べた表と、複数物件を重ねた周辺環境レーダーを表示する
  (求人ジャーナルのような「Geminiに再ランキングさせる」方式ではなく、既にスコア済みの
  データをクライアント側で並べるだけのシンプルな実装)

### まだ手をつけていない項目

- 間取り図だけを狙って抽出する精度向上(現状は写真ギャラリー全般の取得に留まり、
  間取り図と内装写真の区別はしていない)
- 並び替え・重視フラグは`criteria.json`を直接編集する運用(サイト上のドラッグUIではない、
  書き込み権限の都合上)。もっと手軽に編集したくなったら、他の「型ファイル」同様の
  編集体験を検討する

## 11. 2026-09-16(3回目)の改修で対応した内容

- ✅ **家賃コスパの評価を3段階化**: `rentGoodMax`(7.2万円、評価高め=100点)・`rentOkMax`
  (7.5万円、まあよし=80点)・`rentMaxTotal`(8万円、絶対上限)の3段階+区分線形に変更
  (`rentValueScore_`参照)。7.5万円を超えると徐々に減点され、8万円ちょうどで10点まで下がる
- ✅ **一覧カードに「○万円・○㎡・通勤○分」を強調表示**: `docs/data/index.json`の各エントリに
  `commuteMinutes`を追加(`updateRoomIndexOnGithub_`で書き込み)。旧データにはこの値が無いため
  「-」表示になる(再登録時に補われる)
- ✅ **写真ギャラリーをメイン+サムネイル形式に変更**: LINEアプリ内ブラウザ等で横スワイプが
  アプリ側のジェスチャーに取られてスクロールしづらいことがあるため、タップでメイン画像を
  切り替えるサムネイル一覧方式に変更(横スクロールの吸着方式はやめた)
- ✅ **初期費用目安・通勤の内訳を折り返し表示に**: 合計金額の下に内訳を小さい文字で改行表示
  (`.detail-sub`、`display:block`)。通勤は経路の下に新宿までの参考時間(`commute.leisure`)も追加
- ✅ **通勤経路に区間ごとの所要時間を追加**: `COMMUTE_ROUTE`のプロンプトで区間ごとの乗車時間を
  明記するよう指示
- ✅ **最寄り駅・利用可能路線のセクションを追加**: `nearbyStations`(`{line, station,
  walkMinutes, note}`の配列)を新設。Geminiに「路線名::駅名::徒歩分数::一言解説」を
  `;;`区切りで列挙させ、`parseNearbyStations_`でパースする。「エリアについて」の下・
  「周辺施設」の上に表示

## 12. 2026-09-16(4回目)の改修で対応した内容

- ✅ **通勤ルートの精度向上**: 相互直通運転(りんかい線⇔JR埼京線など)を乗り換え回数に
  数えないよう、また遠回りではなく最速経路を採用するようプロンプトを強化(`buildRoomExtractionPrompt_`)。
  ただしGeminiのWeb検索は専用の乗換案内APIではないため、今後も誤りが完全になくなるとは限らない
- ✅ **「物件名+○万円・○㎡・通勤○分」を一体表示**: `titleStatsHtml()`を共通化し、
  一覧カードだけでなく物件詳細ページのh1直下にも表示するように
- ✅ **「通勤」を「最寄り駅・路線」と同じカード形式に変更**: `renderCommuteCard()`を新設し、
  「最寄り駅・路線」カードの直前に配置。詳細テーブル側の通勤行は重複するため削除
- ✅ **比較ページの改善**:
  - マッチ度の下に「マッチ度の理由」(score.summary)の行を追加
  - 「広さ」を独立した行にして、広い方に★枠(best表示)が付くように変更
  - レーダーチャートを表より上に移動
  - 各物件の代表写真(`images[0]`、無ければ`imageUrl`)を「物件名」行の上に小さく表示
- ✅ **一覧ページに並び替え・フィルタ機能を追加**: `renderPropertyList(container, filterFn, opts)`に
  `sortKey`/`sortDir`/`includeHiddenStatuses`を渡せるように変更。マッチ度順/家賃順/通勤順/
  広さ順のプルダウンと、「見送り・掲載終了も表示」チェックボックスをindex.htmlに追加
- ✅ **ステータスに「掲載終了」を追加**し、「見送り」と合わせて`hiddenByDefaultStatuses`
  (criteria.json)で一覧からデフォルト非表示に変更(明示的にチェックを入れれば表示される)

## 13. 2026-09-16(5回目)の改修で対応した内容

- ✅ **一覧ページのフィルター機能を拡充**: 並び替えプルダウンの下に折りたたみ式の
  「🔍 フィルターで絞り込む」パネル(`<details class="filter-panel">`)を新設
  - 「駅までの徒歩」プルダウン(5/10/15/20分以内)で`walkMinutesToStation`による絞り込み
  - 「お部屋の条件」チェックボックス群(`criteria.roomConditions`のうち`type!=="scale"`の
    項目を自動列挙)で、チェックした条件を**すべて満たす**物件だけに絞り込み
    (例: 「バストイレ別」にチェック→バストイレ別の物件のみ表示)
  - `renderPropertyList(container, filterFn, opts)`に`opts.roomFilters`(配列・AND条件)と
    `opts.maxWalkMinutes`(数値・以下)を追加。フィルター該当0件の場合は「条件に合う物件が
    無いよ。フィルターを見直してみてね」という専用の空状態メッセージを表示
  - `ai-concierge`側の`updateRoomIndexOnGithub_`で、`docs/data/index.json`の各物件サマリーに
    `walkMinutesToStation`と`room`(部屋条件オブジェクト)を追加書き込みするように変更。
    旧データ(この変更前に登録された物件)には無かったため、既存の`index.json`は物件ごとの
    個別JSON(`properties/{id}.json`)から値を補完して手動バックフィル済み。今後新規登録
    される物件は自動的にこれらのフィールドを持つ
- ✅ **フィルター条件の保存**: 選んだ並び替え・徒歩分数・部屋条件・AND/OR設定を
  `localStorage`(`heyaSagashiListFilters`)に保存し、次にページを開いたときも同じ条件を
  自動で復元するように(条件が入っていれば、フィルターパネルも自動で開いた状態にする)。
  端末をまたいだ同期はしない(比較機能の選択状態と同じ考え方)
- ✅ **お部屋の条件フィルターにAND/OR切り替えを追加**: 「すべて満たす(AND)」
  「いずれか満たす(OR)」のラジオボタンを追加。`renderPropertyList`の
  `opts.roomFilterMode`("and"あるいは"or")で切り替え、ORのときは
  `roomFilters.some(...)`、ANDのときは従来どおり`roomFilters.every(...)`で判定する
- ✅ **フィルターをリセットするボタンを追加**: 徒歩分数・部屋条件チェック・AND/OR設定を
  まとめて初期状態(条件なし)に戻せるように
- ✅ **名前を付けてフィルター条件を保存(最大10件)**: 「保存した条件」欄を新設。
  名前を入力して💾保存すると、そのときの並び替え・徒歩分数・部屋条件・AND/OR設定が
  1セットとして`localStorage`(`heyaSagashiFilterPresets`)にチップ形式で追加される。
  チップをタップすると一発でその条件を適用、×で削除。10件保存済みの状態で
  さらに保存しようとすると「削除してから保存してね」と案内する
  (`app.js`の`addFilterPreset`/`removeFilterPreset`/`loadFilterPresets`、
  上限は`FILTER_PRESET_MAX`)。前回の状態を自動で覚えておく既存の
  `heyaSagashiListFilters`とは別物として共存させている(自動復元 vs 明示的に名前を付けて残す、の役割分担)
- ✅ **フィルターに「通勤時間」「家賃(実質)」を追加**: 「駅までの徒歩」と同じプルダウン形式で、
  通勤時間(15/20/25/30分以内、`p.commuteMinutes`基準)と家賃(7万/7.2万/7.5万/8万円以内、
  `p.effectiveRentTotal`=実質家賃基準)を絞り込めるように。`renderPropertyList`の
  `opts.maxCommuteMinutes`/`opts.maxRent`で判定し、値が無い物件(`commuteMinutes`未登録など)は
  他のフィルター同様に除外される。フィルターリセット・保存条件(プリセット)・自動復元
  すべてにこの2つも含めて連動させている

## 14. 2026-09-16(7回目)の改修で対応した内容

- 🐛 **バグ修正: 写真URLのHTML実体参照が二重エスケープされていた**: `extractPropertyImages_`が
  `<meta property="og:image" content="...">`のcontent属性値をそのまま拾っていたため、
  本来のHTMLでは`&`が`&amp;`とエスケープされているのに、それをデコードしないまま
  `images`配列に格納していた(例: `...width=1200&amp;height=630`のような壊れたURL)。
  `decodeHtmlEntities_()`を新設してJSON-LD・og:image両方の抽出時にデコードするように修正。
  既存の登録済み物件(中沢ハイツ・恵比寿の賃貸マンション・カーサソラール中目黒の3件)の
  `images`/`imageUrl`もPythonスクリプトで一括デコードして直接バックフィル済み
- ✅ **外観・間取り図をそれぞれ独立したフィールドとして持つように**: `extractFloorPlanImageUrl_()`
  を新設。ページ内の`<img>`タグのalt/title/srcに「間取り」「madori」「floorplan」等の
  キーワードが含まれるものを間取り図とみなす簡易ヒューリスティック(100%の精度は保証できない)。
  `buildRoomPropertyRecord_`が`exteriorImageUrl`(=images[0])と`floorPlanImageUrl`を
  新たに物件レコードに持つようになり、`updateRoomIndexOnGithub_`でindex.jsonのサマリーにも
  この2つを含めるように。既存の登録済み物件は間取り図を後から取得し直せないため、
  `exteriorImageUrl`のみ補完し`floorPlanImageUrl`は空文字のまま(今後の新規登録から自動で入る)
- ✅ **一覧カードに外観・間取りの小さいサムネイルを追加**: `propertyCardHtml`に
  `.card-thumbs`(2枠並び)を追加。画像が無い場合は点線の空枠に「外観なし」「間取りなし」と
  表示するので、レイアウトが崩れない
- ✅ **比較ページに「間取り図」の行を追加**: 既存の「写真」行を「外観」に改名し、
  その直下に`floorPlanImageUrl`を使った「間取り図」行を新設(データが無ければ"-")
- 🐛 **バグ修正: 写真ギャラリーが外観1枚しか取れていなかった**: homes.co.jp(LIFULL HOME'S)は
  1ページに`og:image`タグが1つしか無く、実際のページには間取り図・室内写真等を含む
  ギャラリーが十数枚あっても、そのうち1枚(外観)しか拾えていなかった。
  `extractRoomImageScopeKey_()`を新設し、代表画像(og:image等)のURLから
  「{会社ID}/rent/{物件ID}/」という物件固有のパスをスコープキーとして抽出、
  `extractScopedGalleryImages_()`でページ全体からこのキーを含む画像URLを広く拾い集める
  ように改修(`extractRoomImages_()`に統合)。「おすすめ物件」等、別物件の写真が
  紛れ込まないようスコープキーで絞り込んでいる。間取り図の判定(`extractFloorPlanImageUrl_`)も
  同じスコープキーを優先するよう変更(スコープ外だと関連物件の間取り図を誤検出するリスクが
  あったため)。homes.jpの画像プロキシパターンに依存したヒューリスティックなので、
  他ポータルではog:image/JSON-LDのみの従来動作にフォールバックする。
  既存の登録済み物件は再取得できないため、次回以降の新規登録から反映される

## 15. 2026-09-16(8回目)の改修で対応した内容

- 🐛 **バグ修正: 縦向き写真(間取り図等)が見切れていた**: `.gallery-main img`が
  `object-fit: cover`+16:9固定枠だったため、縦長の間取り図・室内写真が上下を
  crop(切り取り)されてしまっていた。`object-fit: contain`に変更し、画像全体が
  必ず収まるように(余白は`--blue-light`で埋める)
- ✅ **通勤カードを見やすく整理**: 経路の説明文がGeminiの生成した1つの長い文として
  そのまま表示され読みにくかった問題に対応。`splitRouteLines_()`を新設し、
  「(※またはXXX)」のような代替ルート注記を本文から切り離して別行にするように。
  また「🚶 最寄り駅まで徒歩○分」の行を新たに追加(`renderCommuteCard`に
  `nearestStation`/`walkMinutesToStation`を渡すように変更)
- ✅ **「広さ」を3段階の見やすい表示に変更**: これまでは値の有無だけで常に緑チェック
  扱いだったが、`criteria.sizeScoring`の`minSqm`(15㎡)・`goodSqm`(18㎡)を基準に
  「15㎡未満は△(あまり良くない、オレンジ)」「15〜18㎡未満は△(普通、グレー)」
  「18㎡以上は✓(緑)」の3段階表示にした(`sizeTier_()`)

## 16. 2026-09-16(9回目)の改修で対応した内容

- ✅ **ステータス管理を「気になる度(星0〜3)」に完全に置き換え**: 「内見予約」
  「内見済み」「申込済み」「契約済み」「見送り」「保留」「掲載終了」という8択の
  進捗ステータスは廃止し、シンプルに星0〜3個で気になる度をタップして付けられる
  仕組みに変更(デフォルトは星なし=0)。同じ星をもう一度タップすると0に戻せる
  - `ai-concierge`側: `buildRoomPropertyRecord_`が`status`の代わりに`interestStars: 0`を
    セットするように変更。GASのdoGetエンドポイントも`action=updateRoomStatus`から
    `action=updateInterestStars`に変更し、`stars`パラメータ(0〜3の整数、範囲外は拒否)を
    受け取るように(`updateRoomInterestStarsById_`・`handleInterestStarsUpdateWebRequest_`)
  - サイト側: `criteria.json`の`statusUpdateApi`(`statusOptions`・`hiddenByDefaultStatuses`)を
    `starUpdateApi`(`maxStars: 3`)に置き換え。`renderStatusControl`/`saveStatus_`を
    `renderStarRating`/`saveInterestStars_`に置き換え、一覧カード・比較ページの
    ステータス表示もすべて★☆表示(`starRatingHtml()`)に変更
  - 「見送り」「掲載終了」を一覧からデフォルトで隠す仕組み(`hiddenByDefaultStatuses`・
    「見送り」「掲載終了」も表示チェックボックス)は、対応する概念が無くなったため削除。
    一覧の並び替えに「気になる度が高い順」を追加
  - 既存の登録済み物件は`status`フィールドを削除し、全件`interestStars: 0`にリセットして
    バックフィル(旧ステータスと気になる度は別の軸のため、意味のある自動変換はできないと
    判断。改めて星を付け直してもらう運用とした)
- ✅ **レーダーチャートの「家賃コスパ」キャプションに点数を追加**: これまでは実質家賃の
  金額だけを表示していて、グラフ上の位置(75の線に近いかどうか等)からしか点数を
  読み取れなかった。キャプションに`(◯点)`を追加し、金額と点数の両方を一目で
  確認できるように(`buildLifeAxisCaptions`)。なお家賃コスパのスコア自体は
  ¥75,000で正しく80点(`rentValueScore_`の"まあよし"区分どおり)であり、
  計算にバグがあったわけではない

## 17. 2026-09-17 バグ修正: 写真ギャラリーが外観1枚しか取れないポータルがあった

- 🐛 ラウンド14で対応した「写真ギャラリーが外観1枚しか取れない」問題(スコープキー方式)は
  `img.homes.jp/{会社ID}/rent/{物件ID}/...`という命名規則のCDNにしか対応しておらず、
  `image.homes.renters.jp/{uuid}_property_picture_{物件ID}_large.jpg`という別の命名規則を
  使うポータル(例: 「賃貸マンション」大森の物件)では、外観1枚しか取れない不具合が
  再発していた。`extractRoomImageScopeKey_`が複数のURLパターンを順に試すように変更し、
  この命名規則にも対応した(`ROOM_IMAGE_SCOPE_KEY_PATTERNS_`)。テストで新パターン・
  旧パターンどちらも正しくギャラリーを拾えることを確認済み。
  ただしヒューリスティックである以上、まだ見ぬ別のCDN命名規則には引き続き対応できない
  可能性がある。既にこの不具合の影響を受けて登録済みの物件(外観1枚のみ)は、
  再取得できないので、気になる場合は同じURLで「いえさがし」をもう一度送って
  登録し直すしかない

## 18. 2026-09-17(10回目)の改修で対応した内容

- ✅ **フリーワード検索を追加**: 一覧ページ上部に検索ボックスを新設。物件名・町名・
  最寄り駅名のいずれかに部分一致(大文字小文字を無視)すれば表示する(`matchesKeyword_`)。
  `renderPropertyList`の`opts.keyword`として実装し、フィルターリセット・保存条件
  (プリセット)・前回状態の自動復元にも連動させた
- ✅ **物件の削除(実体は残したまま一覧から隠す)機能を追加**: 一覧カードの「比較」
  チェックボックスの隣に🗑ボタン、物件詳細ページにも🗑/♻️ボタンを追加。
  押すと`archived`(true/false)をGAS経由でGitHubに反映し、一覧からは
  デフォルトで隠す(「削除済みも表示」チェックボックスで見返せる)。
  9回目のラウンドで「ステータス→気になる度」に切り替えた際に無くなった
  「見送り・掲載終了を隠す」機能を、削除操作として復活させた形になる。
  - `ai-concierge`側: `buildRoomPropertyRecord_`が`archived: false`をセットするように
    変更。`updateRoomArchivedById_`/`handleArchivedUpdateWebRequest_`を新設し、
    `action=updateArchived&id=...&archived=true|false`で更新できるように
    (`action=updateInterestStars`と同じ認証・実装パターン)
  - サイト側: `renderPropertyList`に`opts.includeArchived`を追加(既定で
    `archived:true`の物件を除外)。一覧カードの🗑ボタンは押すとその場で
    カードを消す(楽観的UI更新、`wireCardArchiveButtons_`)。「削除済みも表示」を
    ONにしている間は🗑が♻️に変わり、カードは半透明+「(削除済み)」表示になる。
    物件詳細ページには`renderArchiveButton`で🗑/♻️の切り替えボタンを設置
  - 既存の登録済み物件はすべて`archived: false`にバックフィル済み

## 19. 2026-09-16 家賃コスパの100点ラインの引き下げ・通勤時間をGoogle Maps実測に変更

- ✅ **家賃コスパスコアの100点ライン(`rentGoodMax`)を¥72,000→¥65,000に変更**:
  実質家賃¥70,000の物件がレーダーチャートで100点表示されていたのに対し、
  はるかちゃんの体感(¥65,000以内なら文句なし、¥70,000は80点くらいの感覚)と
  ズレていたための調整。`ai-concierge`側`ROOM_CRITERIA_.rentGoodMax`のみ変更
  (`rentOkMax: 75000`・`rentMaxTotal: 80000`は変更なし)。既存の登録済み物件の
  スコアは自動では再計算されない(サイト側は登録時に計算済みの値をそのまま表示する
  設計のため)ので、正確な点数で見たい場合は同じURLで「いえさがし」を送り直す必要がある
- ✅ **通勤時間をGoogle Maps Directions APIで実測するように変更**: これまでは
  GeminiのWeb検索グラウンディングによる推定だったが、実際の物件(水野ビル→
  品川シーサイド駅)で「17分・乗り換え1回」という推定に対し、実際にGoogleマップで
  調べると「28〜32分」という大きな乖離が見つかった。相互直通運転の扱いミスに続く
  2件目の実例だったため、Web検索ベースの推定には構造的な限界があると判断し、
  実際のGoogle Maps Directions API(`mode=transit`、平日朝9時到着想定)で
  通勤先(`ROOM_CRITERIA_.commuteDestination`)と新宿駅までの所要時間・乗り換え回数・
  経路を実測するように変更した
  - `ai-concierge`側: `Config.gs`に任意プロパティ`GOOGLE_MAPS_API_KEY`を追加。
    `RoomSearch.gs`に`fetchTransitRoute_(originAddress, destinationName)`
    (Directions APIを呼んで所要時間・乗り換え回数・経路文字列・運賃を返す)、
    `nextWeekdayMorningEpoch_()`(次の平日朝9時のUNIX時刻を計算)、
    `applyGoogleMapsCommute_(meta)`(Geminiが抽出した`meta`の
    `COMMUTE_MIN`/`COMMUTE_TRANSFERS`/`COMMUTE_ROUTE`/`COMMUTE_LEISURE`を
    実測値で上書き)を新設し、`handleRoomSearchSubmission_`内で
    `parseRoomMeta_`の直後に呼ぶように変更
  - `GOOGLE_MAPS_API_KEY`が未設定、または住所が読み取れない・API呼び出しが
    失敗した場合は、これまで通りGeminiの推定値にフォールバックする
    (Geminiのプロンプト側の通勤時間抽出指示はフォールバック用としてそのまま残してある)
  - Google Maps Directions APIの利用には、はるかちゃん自身によるGoogle Cloudの
    プロジェクト作成・Directions APIの有効化・請求先アカウント設定が必要
    (`ai-concierge`の`SETUP.md`に手順を記載)。設定するまでは従来通りGemini推定のまま
  - 既存の登録済み物件(水野ビル含む)の通勤時間は自動では直らないため、
    正確な値で見たい場合は`GOOGLE_MAPS_API_KEY`設定後に同じURLを送り直す必要がある
