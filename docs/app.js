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

function radarDataset(axisLabels, axisValues, color) {
  const labels = Object.keys(axisLabels).map((k) => axisLabels[k]);
  const data = Object.keys(axisLabels).map((k) => (axisValues && axisValues[k] != null) ? axisValues[k] : 0);
  return { labels, data, color };
}

function drawRadarChart(canvas, axisLabels, axisValues, color) {
  const { labels, data } = radarDataset(axisLabels, axisValues, color);
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
          pointLabels: { font: { size: 11 } },
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
      '<div class="row-top">' +
        '<span class="name">' + p.name + sample + "</span>" +
        '<span class="score-badge">マッチ度 ' + p.matchPercent + "%</span>" +
      "</div>" +
      '<div class="meta">' +
        p.town + " ・ " + p.nearestStation + "駅 ・ " + p.layout + " " + p.sizeSqm + "㎡<br>" +
        "家賃総額 " + formatYen(p.rentTotal) +
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

function renderFacilityList(container, facilities) {
  if (!facilities || facilities.length === 0) {
    container.innerHTML = '<p class="empty-note" style="padding:10px;">周辺施設の情報はまだ登録されてないよ</p>';
    return;
  }
  container.innerHTML = '<ul class="facility-list">' + facilities.map((f) =>
    '<li><span class="fname">' + f.name + '</span><span class="fmin">' +
    (f.minutes != null ? "徒歩" + f.minutes + "分" : "-") + "</span></li>"
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
  } catch (e) {
    container.innerHTML = '<p class="empty-note">読み込みエラー: ' + e.message + "</p>";
  }
}
