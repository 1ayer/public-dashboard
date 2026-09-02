import "./style.css";

const formatNumber = new Intl.NumberFormat("ko-KR");
const formatWon = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const PAGE_SIZE = 10;

const state = { data: null, region: "전체", category: "전체", search: "", sort: "name", page: 1 };

const $ = (selector) => document.querySelector(selector);
const percent = (value, total) => total ? `${(value / total * 100).toFixed(1)}%` : "—";
const safeText = (value) => value || "정보 없음";
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[character]));

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function populateSelect(select, values) {
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  });
}

function filteredFacilities() {
  const term = state.search.trim().toLocaleLowerCase("ko");
  return state.data.facilities.filter((item) => {
    if (state.region !== "전체" && item.region !== state.region) return false;
    if (state.category !== "전체" && item.category !== state.category) return false;
    if (!term) return true;
    return [item.name, item.place, item.address, item.management, item.rawType]
      .some((value) => String(value || "").toLocaleLowerCase("ko").includes(term));
  });
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderKpis(items) {
  const total = items.length;
  const paid = items.filter((item) => item.paid).length;
  const weekend = items.filter((item) => item.weekendOpen).length;
  const online = items.filter((item) => item.online).length;
  $("#kpi-total").textContent = formatNumber.format(total);
  $("#kpi-paid").textContent = percent(paid, total);
  $("#kpi-weekend").textContent = percent(weekend, total);
  $("#kpi-online").textContent = percent(online, total);
  const scope = [state.region === "전체" ? "전국" : state.region, state.category === "전체" ? null : state.category].filter(Boolean).join(" · ");
  $("#kpi-scope").textContent = `${scope} 기준`;
}

function groupTop(items, key, limit) {
  const counts = new Map();
  items.forEach((item) => counts.set(item[key], (counts.get(item[key]) || 0) + 1));
  return [...counts].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, limit);
}

function renderBars(items) {
  const byRegion = state.region === "전체";
  const entries = groupTop(items, byRegion ? "region" : "rawType", byRegion ? 10 : 8);
  $("#distribution-title").textContent = byRegion ? "지역별 시설 분포" : `${state.region} 시설 유형`;
  const chart = $("#bar-chart");
  chart.replaceChildren();
  const maximum = Math.max(...entries.map((entry) => entry.value), 1);
  entries.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `<span class="bar-rank">${String(index + 1).padStart(2, "0")}</span><span class="bar-label"></span><span class="bar-track"><i style="width:${entry.value / maximum * 100}%"></i></span><strong>${formatNumber.format(entry.value)}</strong>`;
    row.querySelector(".bar-label").textContent = entry.name;
    chart.append(row);
  });
  if (!entries.length) chart.innerHTML = '<p class="chart-empty">표시할 분포가 없습니다.</p>';
}

function renderConditions(items) {
  const total = items.length;
  const paid = items.filter((item) => item.paid).length;
  const free = total - paid;
  const paidRate = total ? paid / total * 100 : 0;
  $("#paid-donut").style.setProperty("--paid-rate", `${paidRate * 3.6}deg`);
  $("#donut-value").textContent = total ? `${paidRate.toFixed(1)}%` : "—";
  $("#paid-count").textContent = formatNumber.format(paid);
  $("#free-count").textContent = formatNumber.format(free);
  $("#always-rate").textContent = percent(items.filter((item) => item.alwaysOpen).length, total);
  const capacity = median(items.map((item) => item.capacity));
  const fees = median(items.filter((item) => item.paid).map((item) => item.fee));
  $("#capacity-median").textContent = capacity === null ? "—" : `${formatNumber.format(Math.round(capacity))}명`;
  $("#fee-median").textContent = fees === null ? "—" : formatWon.format(Math.round(fees));
}

function sortedFacilities(items) {
  const copy = [...items];
  if (state.sort === "capacity") {
    return copy.sort((a, b) => (b.capacity || -1) - (a.capacity || -1) || a.name.localeCompare(b.name, "ko"));
  }
  if (state.sort === "date") return copy.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, "ko"));
  return copy.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

function facilityRow(item) {
  const tr = document.createElement("tr");
  const fee = item.paid ? (item.fee ? formatWon.format(item.fee) : "유료 · 요금 문의") : "무료";
  const capacity = item.capacity ? `${formatNumber.format(item.capacity)}명` : "인원 미입력";
  const websiteUrl = safeUrl(item.website);
  const website = websiteUrl ? `<a href="${escapeHtml(websiteUrl)}" target="_blank" rel="noreferrer">홈페이지</a>` : "";
  tr.innerHTML = `
    <td><strong class="facility-name"></strong><span class="muted facility-address"></span><span class="updated-date"></span></td>
    <td><span class="category-chip"></span><span class="muted raw-type"></span></td>
    <td><strong>${fee}</strong><span class="muted">${capacity} · ${escapeHtml(item.online ? "온라인 신청 가능" : safeText(item.application))}</span></td>
    <td><span>평일 ${safeText(item.weekday)}</span><span class="muted">주말 ${safeText(item.weekend)}</span></td>
    <td><strong class="management"></strong><span class="muted contact"></span><span class="site-link">${website}</span></td>`;
  tr.querySelector(".facility-name").textContent = item.name;
  tr.querySelector(".facility-address").textContent = item.address || item.place || "주소 정보 없음";
  tr.querySelector(".updated-date").textContent = `기준 ${item.date}`;
  tr.querySelector(".category-chip").textContent = item.category;
  tr.querySelector(".raw-type").textContent = item.rawType;
  tr.querySelector(".management").textContent = item.management || "관리기관 미입력";
  tr.querySelector(".contact").textContent = item.phone || "연락처 미입력";
  return tr;
}

function renderTable(items) {
  const sorted = sortedFacilities(items);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  state.page = Math.min(state.page, pageCount);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageItems = sorted.slice(start, start + PAGE_SIZE);
  const body = $("#facility-table");
  body.replaceChildren(...pageItems.map(facilityRow));
  $("#empty-state").hidden = sorted.length !== 0;
  $("#result-summary").textContent = `선택한 조건에 맞는 시설 ${formatNumber.format(sorted.length)}개`;
  $("#page-status").textContent = `${state.page} / ${pageCount} 페이지`;
  $("#prev-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= pageCount;
}

function render() {
  const items = filteredFacilities();
  renderKpis(items);
  renderBars(items);
  renderConditions(items);
  renderTable(items);
}

function bindEvents() {
  $("#region-filter").addEventListener("change", (event) => { state.region = event.target.value; state.page = 1; render(); });
  $("#category-filter").addEventListener("change", (event) => { state.category = event.target.value; state.page = 1; render(); });
  $("#search-input").addEventListener("input", (event) => { state.search = event.target.value; state.page = 1; render(); });
  $("#sort-select").addEventListener("change", (event) => { state.sort = event.target.value; state.page = 1; render(); });
  $("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; render(); $("#facility-table").closest(".explorer-panel").scrollIntoView({ behavior: "smooth" }); } });
  $("#next-page").addEventListener("click", () => { state.page += 1; render(); $("#facility-table").closest(".explorer-panel").scrollIntoView({ behavior: "smooth" }); });
  $("#reset-button").addEventListener("click", () => {
    state.region = "전체"; state.category = "전체"; state.search = ""; state.sort = "name"; state.page = 1;
    $("#region-filter").value = "전체"; $("#category-filter").value = "전체"; $("#search-input").value = ""; $("#sort-select").value = "name";
    render();
  });
}

async function init() {
  try {
    const response = await fetch("./data/manifest.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    if (!("DecompressionStream" in window)) throw new Error("This browser does not support gzip decompression.");
    const parts = await Promise.all(manifest.parts.map(async (partName) => {
      const partResponse = await fetch(`./data/${partName}`);
      if (!partResponse.ok || !partResponse.body) throw new Error(`Unable to load ${partName}`);
      const stream = partResponse.body.pipeThrough(new DecompressionStream("gzip"));
      return JSON.parse(await new Response(stream).text());
    }));
    state.data = { summary: manifest.summary, facilities: parts.flat() };
    populateSelect($("#region-filter"), state.data.summary.regions);
    populateSelect($("#category-filter"), state.data.summary.categories);
    $("#latest-date").textContent = state.data.summary.latestDate.replaceAll("-", ".");
    $("#recent-rate").textContent = `${state.data.summary.recentRate}%`;
    $("#note-generic").textContent = formatNumber.format(state.data.summary.notes.genericType);
    bindEvents();
    render();
  } catch (error) {
    console.error(error);
    $("#main").innerHTML = '<section class="load-error"><h1>데이터를 불러오지 못했습니다.</h1><p>잠시 후 페이지를 새로고침해 주세요.</p></section>';
  }
}

init();
