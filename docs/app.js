// heya-sagashi-journal: 共通の読み込み・描画ロジック
// データは docs/data/ 配下のJSONを fetch するだけ(ビルドステップなし)。
// GAS側がLINE経由で docs/data/properties/{id}.json と docs/data/index.json を
// GitHub Contents API で直接コミットすると、ここが自動でその内容を表示する。

const LIFE_AXIS_LABELS = {
  roomQuality: "部屋の設備充実度",
  rentValue: "家賃コスパ",
  commuteAccess: "通勤アクセス",
  stationCloseness: "駅の近さ",
  dailyConvenience: "生活利便性",
  safety: "治安・住環境"
};

// ルート直下のページ(index.html等)では既定値、サブフォルダ(articles/等)からは
// <script>で先に window.DATA_BASE / window.SITE_BASE を上書きしてから app.js を読み込む。
const DATA_BASE = (typeof window !== "undefined" && window.DATA_BASE) || "data/";
const SITE_BASE = (typeof window !== "undefined" && window.SITE_BASE) || "";

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(path + " の読み込みに失敗したよ(" + res.status + ")");
  return res.json();
}

function loadCriteria() { return fetchJson(DATA_BASE + "criteria.json"); }
function loadIndex() { return fetchJson(DATA_BASE + "index.json"); }
function loadProperty(id) { return fetchJson(DATA_BASE + "properties/" + id + ".json"); }

function formatYen(n) {
  if (n === null || n === undefined) return "-";
  return "¥" + Number(n).toLocaleString("ja-JP");
}

// 「万円」表記(例: 78000 → "7.8万円")
function formatMan(n) {
  if (n === null || n === undefined) return "-";
  const man = Math.round(n / 100) / 100;
  return man + "万円";
}

// レーダーの各軸ラベルの下に添える、実際の値ベースの一言(例:「通勤アクセス」の下に「3分」)
function buildLifeAxisCaptions(property) {
  const facilities = (property.surroundings && property.surroundings.facilities) || [];
  return {
    roomQuality: property.radar.lifeAxes.roomQuality + "%達成",
    rentValue: formatYen(property.rent.effectiveTotal),
    commuteAccess: (property.commute.minutes != null ? property.commute.minutes + "分" : "-"),
    stationCloseness: (property.walkMinutesToStation != null ? property.walkMinutesToStation + "分" : "-"),
    dailyConvenience: facilities.length ? facilities.length + "件" : property.radar.lifeAxes.dailyConvenience + "点",
    safety: property.radar.lifeAxes.safety + "点"
  };
}

function drawRadarChart(canvas, axisLabels, axisValues, color, captions) {
  const keys = Object.keys(axisLabels);
  const labels = keys.map((k) => axisLabels[k]);
  const data = keys.map((k) => (axisValues && axisValues[k] != null) ? axisValues[k] : 0);
  return new Chart(canvas, {
    type: "radar",
    data: {
      labels,
      datasets: [{
        label: "スコア",
        data,
        backgroundColor: color + "33",
        borderColor: color,
        borderWidth: 2,
        pointBackgroundColor: color
      }]
    },
    options: {
      responsive: true,
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { stepSize: 25, showLabelBackdrop: false, color: "#999" },
          pointLabels: {
            font: { size: 11 },
            callback: function (label, index) {
              const caption = captions && captions[keys[index]];
              return caption ? [label, caption] : label;
            }
          },
          grid: { color: "#f1dbe4" },
          angleLines: { color: "#f1dbe4" }
        }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function propertyCardHtml(p) {
  const sample = p.isSample ? '<span class="sample-tag">サンプル</span>' : "";
  return (
    '<a class="property-card" href="' + SITE_BASE + 'property.html?id=' + encodeURIComponent(p.id) + '">' +
      '<label class="compare-check" onclick="event.stopPropagation()">' +
        '<input type="checkbox" class="compare-checkbox" value="' + p.id + '" onchange="onCompareCheckboxChange()">比較' +
      "</label>" +
      '<div class="row-top">' +
        '<span class="name">' + p.name + sample + "</span>" +
        '<span class="score-badge">マッチ度 ' + p.matchPercent + "%</span>" +
      "</div>" +
      '<div class="card-stats">' +
        formatMan(p.rentTotal) + " ・ " + p.sizeSqm + "㎡ ・ 通勤" + (p.commuteMinutes != null ? p.commuteMinutes + "分" : "-") +
      "</div>" +
      '<div class="meta">' +
        p.town + " ・ " + p.nearestStation + "駅" +
        (p.effectiveRentTotal !== p.rentTotal ? "(ネット込み実質 " + formatYen(p.effectiveRentTotal) + ")" : "") +
        ' ・ <span class="sticker-tag">' + (p.status || "-") + "</span>" +
      "</div>" +
    "</a>"
  );
}

// 「お部屋の中身」チェックリスト。criteria.roomConditionsの並び順=表示順、
// weightが1より大きい項目は★マークで目立たせる(全物件共通の重視設定)。
function renderRoomChecklist(container, criteria, property) {
  const room = property.room || {};
  const items = (criteria.roomConditions || []).map((cond) => {
    const important = (cond.weight || 1) > 1;
    if (cond.type === "scale") {
      const val = property.sizeSqm;
      return '<li class="yes"><span class="mark">' + (val != null ? "㎡" : "?") + '</span>' +
        '<span class="label">' + cond.label + (important ? '<span class="star">★</span>' : "") + '</span>' +
        '<span class="size-value">' + (val != null ? val + cond.unit : "不明") + "</span></li>";
    }
    const has = !!room[cond.key];
    return '<li class="' + (has ? "yes" : "no") + (important ? " important" : "") + '">' +
      '<span class="mark">' + (has ? "✓" : "×") + '</span>' +
      '<span class="label">' + cond.label + (important ? '<span class="star">★</span>' : "") + "</span></li>";
  });
  container.innerHTML = '<ul class="checklist">' + items.join("") + "</ul>";
}

// 徒歩1分=80m(不動産表示の慣例)換算で「○m 徒歩○分」の形式にする
function minutesToMeters(minutes) {
  return Math.round((minutes * 80) / 10) * 10;
}

function renderFacilityList(container, facilities) {
  if (!facilities || facilities.length === 0) {
    container.innerHTML = '<p class="empty-note" style="padding:10px;">周辺施設の情報はまだ登録されてないよ</p>';
    return;
  }
  container.innerHTML = '<ul class="facility-list">' + facilities.map((f) =>
    '<li><span class="fname">' + f.name + '</span><span class="fmin">' +
    (f.minutes != null ? minutesToMeters(f.minutes) + "m 徒歩" + f.minutes + "分" : "-") + "</span></li>"
  ).join("") + "</ul>";
}

// 元サイトと同じように、大きい写真+下のサムネイル一覧で全部見られるようにする。
// (imageUrlしか無い旧データとの互換のため、imagesが空ならimageUrl単体にフォールバックする)
// LINEアプリ内ブラウザ等では横スワイプがアプリ側に取られてスクロールしにくいことがあるため、
// メインの切り替えは「サムネイルをタップ」で行い、スワイプは補助手段に留める。
function renderPhotoGallery(container, images, legacyImageUrl) {
  const list = (images && images.length) ? images : (legacyImageUrl ? [legacyImageUrl] : []);
  if (list.length === 0) {
    container.innerHTML = '<div class="hero-photo-placeholder">写真はまだ取得できてないよ</div>';
    return;
  }
  container.innerHTML =
    '<a class="gallery-main" id="gallery-main-link" href="' + list[0] + '" target="_blank" rel="noopener">' +
      '<img id="gallery-main-img" src="' + list[0] + '" alt="物件の写真" referrerpolicy="no-referrer">' +
    "</a>" +
    (list.length > 1 ? '<div class="gallery-thumbs">' + list.map((url, i) =>
      '<img class="gallery-thumb' + (i === 0 ? " active" : "") + '" data-index="' + i + '" src="' + url +
      '" alt="サムネイル' + (i + 1) + '" referrerpolicy="no-referrer" loading="lazy">'
    ).join("") + "</div>" : "");

  if (list.length > 1) {
    const mainImg = document.getElementById("gallery-main-img");
    const mainLink = document.getElementById("gallery-main-link");
    container.querySelectorAll(".gallery-thumb").forEach((thumb) => {
      thumb.addEventListener("click", () => {
        const url = list[Number(thumb.dataset.index)];
        mainImg.src = url;
        mainLink.href = url;
        container.querySelectorAll(".gallery-thumb").forEach((t) => t.classList.remove("active"));
        thumb.classList.add("active");
      });
    });
  }
}

function renderNearbyStations(container, stations) {
  if (!stations || stations.length === 0) {
    container.innerHTML = '<p class="empty-note" style="padding:10px;">最寄り駅・路線の情報はまだ登録されてないよ</p>';
    return;
  }
  container.innerHTML = '<ul class="station-list">' + stations.map((s) =>
    '<li><div class="station-head"><span class="station-line">' + s.line + "</span>" +
      '<span class="station-name">' + s.station + "駅</span>" +
      '<span class="station-walk">徒歩' + (s.walkMinutes != null ? s.walkMinutes + "分" : "-") + "</span></div>" +
      (s.note ? '<p class="station-note">' + s.note + "</p>" : "") +
    "</li>"
  ).join("") + "</ul>";
}

async function renderPropertyList(container, filterFn) {
  container.innerHTML = '<p class="empty-note">読み込み中だよ…</p>';
  try {
    const idx = await loadIndex();
    let list = idx.properties || [];
    if (filterFn) list = list.filter(filterFn);
    list.sort((a, b) => b.scoreTotal - a.scoreTotal);
    if (list.length === 0) {
      container.innerHTML = '<p class="empty-note">まだ物件が登録されてないよ。LINEで「いえさがし (URL)」と送ると、ここに追加されるよ📮</p>';
      return;
    }
    container.innerHTML = list.map(propertyCardHtml).join("");
    restoreCompareCheckboxes();
  } catch (e) {
    container.innerHTML = '<p class="empty-note">読み込みエラー: ' + e.message + "</p>";
  }
}

// -------------------------------------------------------------
// 物件比較(チェックボックスで選んで比較ページへ)
// -------------------------------------------------------------
// 選択状態はこのブラウザだけのものでOKと割り切り、sessionStorageに保存する
// (複数端末をまたいだ同期はしない。個人利用の一覧選択なのでこれで十分)
const COMPARE_STORAGE_KEY = "heyaSagashiCompareIds";

function getCompareIds() {
  try {
    return JSON.parse(sessionStorage.getItem(COMPARE_STORAGE_KEY) || "[]");
  } catch (e) {
    return [];
  }
}

function setCompareIds(ids) {
  try {
    sessionStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(ids));
  } catch (e) { /* ストレージが使えない環境では諦める */ }
}

function restoreCompareCheckboxes() {
  const ids = getCompareIds();
  document.querySelectorAll(".compare-checkbox").forEach((cb) => {
    cb.checked = ids.indexOf(cb.value) !== -1;
  });
  updateCompareBar();
}

function onCompareCheckboxChange() {
  const ids = Array.from(document.querySelectorAll(".compare-checkbox:checked")).map((cb) => cb.value);
  setCompareIds(ids);
  updateCompareBar();
}

function updateCompareBar() {
  const ids = getCompareIds();
  let bar = document.getElementById("compare-bar");
  if (ids.length < 2) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "compare-bar";
    bar.className = "compare-bar";
    document.body.appendChild(bar);
  }
  bar.innerHTML = "<span>" + ids.length + "件選択中</span>" +
    '<a href="' + SITE_BASE + "compare.html?ids=" + ids.map(encodeURIComponent).join(",") + '">比較する →</a>';
}

// -------------------------------------------------------------
// ステータス変更(サイト上のボタンから、GASのWebアプリ経由でGitHubに反映)
// -------------------------------------------------------------
function renderStatusControl(container, property, criteria) {
  const api = criteria.statusUpdateApi;
  if (!api || !api.url) {
    container.textContent = property.status;
    return;
  }
  const options = (api.statusOptions || [property.status]).map((s) =>
    '<option value="' + s + '"' + (s === property.status ? " selected" : "") + ">" + s + "</option>"
  ).join("");
  container.innerHTML =
    '<select class="status-select" id="status-select">' + options + "</select>" +
    '<span class="status-save-note" id="status-save-note"></span>';
  document.getElementById("status-select").addEventListener("change", function () {
    saveStatus_(api, property.id, this.value);
  });
}

function saveStatus_(api, id, newStatus) {
  const note = document.getElementById("status-save-note");
  if (note) note.textContent = "保存中…";
  const url = api.url + "?action=updateRoomStatus&id=" + encodeURIComponent(id) +
    "&status=" + encodeURIComponent(newStatus) + "&token=" + encodeURIComponent(api.token);
  // GASのdoGetはCORSでレスポンスを読めないため no-cors で送りっぱなしにする
  // (リクエスト自体はサーバーに届いて処理されるので、結果はサイトの再読み込みで確認する)
  fetch(url, { mode: "no-cors" }).then(function () {
    if (note) note.textContent = "保存したよ(反映まで数秒待ってね)";
    setTimeout(function () {
      if (note) note.textContent = "";
    }, 4000);
  }).catch(function () {
    if (note) note.textContent = "保存に失敗したかも…もう一度試してみてね";
  });
}
