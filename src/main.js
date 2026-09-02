import "./style.css";
import {
  DEFAULT_FILTERS,
  buildCsv,
  completenessLevel,
  filterFacilities,
  freshnessOf,
  haversineKm,
  loadFacilityData,
  safeExternalUrl,
  sortFacilities,
} from "./data.js";
import { FacilityMap } from "./map.js";

const PAGE_SIZE = 10;
const formatNumber = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const formatWon = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW", maximumFractionDigits: 0 });
const FILTER_IDS = {
  region: "region-filter",
  district: "district-filter",
  category: "category-filter",
  fee: "fee-filter",
  weekend: "weekend-filter",
  channel: "channel-filter",
  capacity: "capacity-filter",
  freshness: "freshness-filter",
  completeness: "completeness-filter",
  contact: "contact-filter",
  search: "search-input",
};
const FILTER_LABELS = {
  region: "시·도", district: "시·군·구", category: "분류", fee: "요금", weekend: "주말",
  channel: "신청", capacity: "수용인원", freshness: "최신성", completeness: "정보", contact: "연락 가능", search: "검색",
};
const PARAMS = {
  region: "region", district: "district", category: "category", fee: "fee", weekend: "weekend",
  channel: "channel", capacity: "capacity", freshness: "fresh", completeness: "quality", search: "q",
};

const state = {
  data: null,
  filters: { ...DEFAULT_FILTERS },
  filtered: [],
  page: 1,
  sort: "name",
  compareIds: new Set(),
  detailId: null,
  userLocation: null,
  map: null,
  searchTimer: null,
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
}[character]));
const percent = (value, total) => total ? `${(value / total * 100).toFixed(1)}%` : "—";

function facilityById(id) {
  return state.data.facilities.find((item) => item.id === id);
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function feeText(item) {
  if (item.feeStatus === "무료") return "무료";
  if (item.feeStatus === "무료 표기 모순") return "무료 표기 · 금액 확인 필요";
  if (item.feeStatus === "유료·조건부 무료") return "유료 · 조건부 무료";
  if (item.feeStatus === "유료·조건별 금액") return "유료 · 조건별 금액";
  if (!Number.isFinite(item.fee)) return "유료 · 금액 문의";
  const duration = item.usageDuration ? ` / ${formatNumber.format(item.usageDuration)}시간` : "";
  return `${formatWon.format(item.fee)}${duration}`;
}

function freshnessClass(value) {
  return value === "최신" ? "badge-good" : value === "확인 권장" ? "badge-warn" : "badge-alert";
}

function completenessClass(value) {
  return value === "정보 충분" ? "badge-good" : value === "일부 누락" ? "badge-warn" : "badge-alert";
}

function populateSelect(select, values) {
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  });
}

function updateDistrictOptions(preferred = "전체") {
  const select = $("#district-filter");
  const districts = [...new Set(state.data.facilities
    .filter((item) => state.filters.region === "전체" || item.region === state.filters.region)
    .map((item) => item.district)
    .filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  select.replaceChildren(new Option("전체 시·군·구", "전체"));
  populateSelect(select, districts);
  select.disabled = state.filters.region === "전체";
  state.filters.district = districts.includes(preferred) ? preferred : "전체";
  select.value = state.filters.district;
}

function readUrlState() {
  const params = new URLSearchParams(location.search);
  Object.entries(PARAMS).forEach(([key, parameter]) => {
    const value = params.get(parameter);
    if (value) state.filters[key] = value;
  });
  state.filters.contact = params.get("contact") === "1";
  state.sort = ["name", "capacity", "date", "distance"].includes(params.get("sort")) ? params.get("sort") : "name";
  state.detailId = params.get("facility");
  if (state.detailId && !facilityById(state.detailId)) state.detailId = null;
  const compare = (params.get("compare") || "").split(",").filter(Boolean).slice(0, 4);
  state.compareIds = new Set(compare.filter((id) => facilityById(id)));
}

function applyStateToControls() {
  Object.entries(FILTER_IDS).forEach(([key, id]) => {
    const control = document.getElementById(id);
    if (!control) return;
    if (key === "contact") control.checked = state.filters.contact;
    else if ([...control.options || []].some((option) => option.value === state.filters[key]) || control.tagName === "INPUT") control.value = state.filters[key];
    else state.filters[key] = DEFAULT_FILTERS[key];
  });
  $("#sort-select").value = state.sort === "distance" && !state.userLocation ? "name" : state.sort;
  if (!state.userLocation && state.sort === "distance") state.sort = "name";
}

function syncUrl() {
  const params = new URLSearchParams();
  Object.entries(PARAMS).forEach(([key, parameter]) => {
    if (state.filters[key] !== DEFAULT_FILTERS[key]) params.set(parameter, state.filters[key]);
  });
  if (state.filters.contact) params.set("contact", "1");
  if (state.sort !== "name") params.set("sort", state.sort);
  if (state.detailId) params.set("facility", state.detailId);
  if (state.compareIds.size) params.set("compare", [...state.compareIds].join(","));
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
}

function renderActiveFilters() {
  const container = $("#active-filters");
  container.replaceChildren();
  let advancedCount = 0;
  Object.entries(state.filters).forEach(([key, value]) => {
    const inactive = key === "contact" ? !value : value === DEFAULT_FILTERS[key];
    if (inactive) return;
    if (["fee", "weekend", "channel", "capacity", "freshness", "completeness", "contact"].includes(key)) advancedCount += 1;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-chip";
    const display = key === "contact" ? "연락 가능" : value;
    button.textContent = `${FILTER_LABELS[key]}: ${display} ×`;
    button.setAttribute("aria-label", `${FILTER_LABELS[key]} ${display} 조건 삭제`);
    button.dataset.clearFilter = key;
    container.append(button);
  });
  if (!container.children.length) {
    const empty = document.createElement("span");
    empty.className = "no-filter";
    empty.textContent = "전체 시설을 보고 있습니다.";
    container.append(empty);
  }
  const badge = $("#advanced-count");
  badge.hidden = advancedCount === 0;
  badge.textContent = String(advancedCount);
}

function renderKpis(items) {
  const total = items.length;
  $("#kpi-total").textContent = formatNumber.format(total);
  $("#kpi-free").textContent = percent(items.filter((item) => !item.paid).length, total);
  $("#kpi-weekend").textContent = percent(items.filter((item) => item.weekendOpen).length, total);
  $("#kpi-online").textContent = percent(items.filter((item) => item.online).length, total);
  const scope = [state.filters.region === "전체" ? "전국" : state.filters.region, state.filters.district === "전체" ? null : state.filters.district, state.filters.category === "전체" ? null : state.filters.category].filter(Boolean).join(" · ");
  $("#kpi-scope").textContent = `${scope} 기준`;
}

function groupTop(items, key, limit) {
  const counts = new Map();
  items.forEach((item) => counts.set(item[key] || "정보 없음", (counts.get(item[key] || "정보 없음") || 0) + 1));
  return [...counts].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, limit);
}

function renderBars(items) {
  const byRegion = state.filters.region === "전체";
  const entries = groupTop(items, byRegion ? "region" : "normalizedType", byRegion ? 10 : 8);
  $("#distribution-title").textContent = byRegion ? "지역별 시설 분포" : `${state.filters.region} 시설 유형`;
  const chart = $("#bar-chart");
  chart.replaceChildren();
  const maximum = Math.max(...entries.map((entry) => entry.value), 1);
  entries.forEach((entry, index) => {
    const row = document.createElement(byRegion ? "button" : "div");
    if (byRegion) {
      row.type = "button";
      row.dataset.selectRegion = entry.name;
      row.setAttribute("aria-label", `${entry.name} ${formatNumber.format(entry.value)}개 시설 보기`);
    }
    row.className = "bar-row";
    row.innerHTML = `<span class="bar-rank">${String(index + 1).padStart(2, "0")}</span><span class="bar-label">${escapeHtml(entry.name)}</span><span class="bar-track"><i style="width:${entry.value / maximum * 100}%"></i></span><strong>${formatNumber.format(entry.value)}</strong>`;
    chart.append(row);
  });
  if (!entries.length) chart.innerHTML = '<p class="chart-empty">표시할 분포가 없습니다.</p>';
}

function renderConditions(items) {
  const total = items.length;
  const paid = items.filter((item) => item.paid).length;
  const paidRate = total ? paid / total * 100 : 0;
  $("#paid-donut").style.setProperty("--paid-rate", `${paidRate * 3.6}deg`);
  $("#paid-donut").setAttribute("aria-label", `유료 시설 ${paidRate.toFixed(1)}퍼센트`);
  $("#donut-value").textContent = total ? `${paidRate.toFixed(1)}%` : "—";
  $("#paid-count").textContent = formatNumber.format(paid);
  $("#free-count").textContent = formatNumber.format(total - paid);
  $("#complete-rate").textContent = percent(items.filter((item) => completenessLevel(item.completeness) === "정보 충분").length, total);
  const capacity = median(items.map((item) => item.capacity));
  const fees = median(items.filter((item) => item.paid).map((item) => item.fee));
  $("#capacity-median").textContent = capacity === null ? "—" : `${formatNumber.format(Math.round(capacity))}명`;
  $("#fee-median").textContent = fees === null ? "—" : formatWon.format(Math.round(fees));
  $("#fresh-rate").textContent = percent(items.filter((item) => freshnessOf(item.date) === "최신").length, total);
}

function statusBadges(item) {
  const fresh = freshnessOf(item.date);
  const complete = completenessLevel(item.completeness);
  const inferred = item.categoryBasis !== "원자료" ? '<span class="status-badge badge-neutral">분류 추정</span>' : "";
  return `<span class="status-badge ${freshnessClass(fresh)}">${escapeHtml(fresh)}</span><span class="status-badge ${completenessClass(complete)}">${escapeHtml(complete)}</span>${inferred}`;
}

function compareButton(item) {
  const selected = state.compareIds.has(item.id);
  return `<button type="button" class="compare-toggle${selected ? " selected" : ""}" data-compare="${item.id}" aria-pressed="${selected}">${selected ? "선택됨" : "비교"}</button>`;
}

function renderFacilityRow(item) {
  const distance = state.userLocation && item.mapValid ? `${haversineKm(state.userLocation, item).toFixed(1)}㎞` : "";
  return `<tr>
    <td><button class="facility-link" type="button" data-detail="${item.id}">${escapeHtml(item.name)}</button><span class="muted">${escapeHtml(item.address || item.place || "주소 정보 없음")}</span><span class="updated-date">기준 ${escapeHtml(item.date)}</span>${distance ? `<span class="distance-label">${distance}</span>` : ""}</td>
    <td><span class="category-chip">${escapeHtml(item.category)}</span><span class="muted">${escapeHtml(item.normalizedType)}</span><div class="status-stack">${statusBadges(item)}</div></td>
    <td><strong>${escapeHtml(feeText(item))}</strong><span class="muted">${item.capacity ? `${formatNumber.format(item.capacity)}명` : "수용인원 미입력"} · ${item.channels.length ? escapeHtml(item.channels.join("·")) : "신청방법 미입력"}</span></td>
    <td><span>평일 ${escapeHtml(item.weekday || "정보 없음")}</span><span class="muted">주말 ${escapeHtml(item.weekendStatus)} · ${escapeHtml(item.weekend || "정보 없음")}</span></td>
    <td><strong>${escapeHtml(item.management || "관리기관 미입력")}</strong><span class="muted">${escapeHtml(item.phone || "연락처 미입력")}</span></td>
    <td>${compareButton(item)}</td>
  </tr>`;
}

function renderFacilityCard(item) {
  return `<article class="facility-card"><header><span class="category-chip">${escapeHtml(item.category)}</span>${compareButton(item)}</header><button class="facility-link" type="button" data-detail="${item.id}">${escapeHtml(item.name)}</button><p>${escapeHtml(item.address || item.place || "주소 정보 없음")}</p><div class="card-facts"><span>${escapeHtml(feeText(item))}</span><span>${item.capacity ? `${formatNumber.format(item.capacity)}명` : "인원 미입력"}</span><span>${escapeHtml(item.weekendStatus)}</span></div><div class="status-stack">${statusBadges(item)}</div></article>`;
}

function renderTable(items) {
  const sorted = sortFacilities(items, state.sort, state.userLocation);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  state.page = Math.min(state.page, pageCount);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageItems = sorted.slice(start, start + PAGE_SIZE);
  $("#facility-table").innerHTML = pageItems.map(renderFacilityRow).join("");
  $("#facility-cards").innerHTML = pageItems.map(renderFacilityCard).join("");
  $("#empty-state").hidden = sorted.length !== 0;
  $("#result-summary").textContent = `선택 조건에 맞는 시설 ${formatNumber.format(sorted.length)}개 · ${state.data.facilities.length.toLocaleString("ko-KR")}개 중`;
  $("#page-status").textContent = `${state.page} / ${pageCount} 페이지`;
  $("#prev-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= pageCount;
}

function renderNearby(items) {
  const list = $("#nearby-list");
  if (!items.length) {
    list.innerHTML = '<p class="nearby-empty">현재 조건에 맞는 지도 시설이 없습니다.</p>';
    return;
  }
  list.innerHTML = items.map((item) => `<button type="button" data-detail="${item.id}"><span class="nearby-category">${escapeHtml(item.category)}</span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.district || item.region)} · ${escapeHtml(item.feeStatus)}</small></button>`).join("");
}

function renderMap(items, fit) {
  if (!state.map) return;
  const valid = items.filter((item) => item.mapValid);
  $("#map-summary").textContent = `검색 결과 ${formatNumber.format(items.length)}개 중 지도에 ${formatNumber.format(valid.length)}개 표시`;
  state.map.setFacilities(items, { fit });
}

function renderCompareTray() {
  const tray = $("#compare-tray");
  const items = [...state.compareIds].map(facilityById).filter(Boolean);
  tray.hidden = items.length === 0;
  $("#compare-count").textContent = `${items.length}/4`;
  $("#compare-items").innerHTML = items.map((item) => `<span>${escapeHtml(item.name)}<button type="button" data-remove-compare="${item.id}" aria-label="${escapeHtml(item.name)} 비교에서 제거">×</button></span>`).join("");
  $("#open-compare").disabled = items.length < 2;
}

function render({ fitMap = false, sync = true } = {}) {
  state.filtered = filterFacilities(state.data.facilities, state.filters);
  renderActiveFilters();
  renderKpis(state.filtered);
  renderBars(state.filtered);
  renderConditions(state.filtered);
  renderTable(state.filtered);
  renderMap(state.filtered, fitMap);
  renderCompareTray();
  if (sync) syncUrl();
}

function detailInfoRow(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "정보 없음")}</dd></div>`;
}

function openDetail(id, { focusMap = false } = {}) {
  const item = facilityById(id);
  if (!item) return;
  state.detailId = id;
  const fresh = freshnessOf(item.date);
  const complete = completenessLevel(item.completeness);
  $("#detail-badges").innerHTML = `<span class="category-chip">${escapeHtml(item.category)}</span>${statusBadges(item)}`;
  const website = safeExternalUrl(item.website);
  const phone = String(item.phone || "").replace(/[^0-9+]/g, "");
  const naverMap = `https://map.naver.com/p/search/${encodeURIComponent(item.address || item.name)}`;
  const kakaoMap = item.mapValid ? `https://map.kakao.com/link/map/${encodeURIComponent(item.name)},${item.lat},${item.lng}` : `https://map.kakao.com/?q=${encodeURIComponent(item.address || item.name)}`;
  $("#detail-content").innerHTML = `
    <div class="detail-title"><p>${escapeHtml(item.place || item.management)}</p><h2 tabindex="-1">${escapeHtml(item.name)}</h2><address>${escapeHtml(item.address || "주소 정보 없음")}</address></div>
    <div class="detail-actions">${phone ? `<a class="button button-primary" href="tel:${phone}">전화하기</a>` : ""}${website ? `<a class="button button-secondary" href="${escapeHtml(website)}" target="_blank" rel="noreferrer">홈페이지 <span class="sr-only">새 창</span></a>` : ""}<button class="button button-secondary" type="button" data-copy-address="${item.id}">주소 복사</button>${item.mapValid ? `<button class="button button-secondary" type="button" data-map-focus="${item.id}">지도에서 보기</button>` : ""}</div>
    <section><h3>이용 정보</h3><dl class="detail-grid">${detailInfoRow("요금", feeText(item))}${detailInfoRow("요금 원문", item.feeRaw || "미입력")}${detailInfoRow("시간당 환산", item.feePerHour ? `약 ${formatWon.format(item.feePerHour)}` : "환산 불가")}${detailInfoRow("수용인원", item.capacity ? `${formatNumber.format(item.capacity)}명` : "미입력")}${detailInfoRow("면적", item.area ? `${formatNumber.format(item.area)}㎡` : "미입력")}${detailInfoRow("신청방법", item.application || "미입력")}${detailInfoRow("신청 채널", item.channels.length ? item.channels.join(" · ") : "미입력")}</dl></section>
    <section><h3>운영 정보</h3><dl class="detail-grid">${detailInfoRow("평일", item.weekday)}${detailInfoRow("주말", `${item.weekendStatus} · ${item.weekend}`)}${detailInfoRow("휴관일", item.closed)}${detailInfoRow("연중무휴 표기", item.alwaysOpen ? "있음" : "없음")}</dl></section>
    <section><h3>시설·관리 정보</h3><dl class="detail-grid">${detailInfoRow("정제 분류", `${item.category}${item.categoryBasis !== "원자료" ? " · 추정" : ""}`)}${detailInfoRow("원자료 유형", item.rawType)}${detailInfoRow("부대시설", item.amenities)}${detailInfoRow("관리기관", item.management)}${detailInfoRow("담당부서", item.department)}${detailInfoRow("제공기관", item.provider)}</dl></section>
    <section class="data-confidence"><h3>데이터 확인</h3><p><span class="status-badge ${freshnessClass(fresh)}">${escapeHtml(fresh)}</span> 기준일 ${escapeHtml(item.date)} · <span class="status-badge ${completenessClass(complete)}">${escapeHtml(complete)}</span> 입력 완성도 ${item.completeness}%</p><p>운영시간과 요금은 변경될 수 있으므로 방문 전에 관리기관에 확인해 주세요.</p></section>
    <div class="external-map-links"><a href="${naverMap}" target="_blank" rel="noreferrer">네이버 지도 <span class="sr-only">새 창</span></a><a href="${kakaoMap}" target="_blank" rel="noreferrer">카카오맵 <span class="sr-only">새 창</span></a></div>`;
  const dialog = $("#detail-dialog");
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("h2").focus?.();
  syncUrl();
  if (focusMap) state.map.focus(item);
}

function closeDetail() {
  const dialog = $("#detail-dialog");
  if (dialog.open) dialog.close();
  state.detailId = null;
  syncUrl();
}

function toggleCompare(id) {
  if (state.compareIds.has(id)) state.compareIds.delete(id);
  else if (state.compareIds.size >= 4) {
    showToast("시설은 최대 4개까지 비교할 수 있습니다.");
    return;
  } else state.compareIds.add(id);
  renderTable(state.filtered);
  renderCompareTray();
  syncUrl();
}

function openCompare() {
  const items = [...state.compareIds].map(facilityById).filter(Boolean);
  if (items.length < 2) return;
  const rows = [
    ["분류", (item) => item.category], ["지역", (item) => `${item.region} ${item.district}`],
    ["요금", feeText], ["수용인원", (item) => item.capacity ? `${formatNumber.format(item.capacity)}명` : "미입력"],
    ["주말 운영", (item) => `${item.weekendStatus} · ${item.weekend}`], ["신청방법", (item) => item.channels.length ? item.channels.join(" · ") : "미입력"],
    ["관리기관", (item) => item.management || "미입력"], ["기준일", (item) => `${item.date} · ${freshnessOf(item.date)}`],
    ["정보 완성도", (item) => `${item.completeness}% · ${completenessLevel(item.completeness)}`],
  ];
  $("#compare-content").innerHTML = `<table><thead><tr><th>비교 항목</th>${items.map((item) => `<th><button type="button" data-detail="${item.id}">${escapeHtml(item.name)}</button></th>`).join("")}</tr></thead><tbody>${rows.map(([label, getter]) => `<tr><th>${escapeHtml(label)}</th>${items.map((item) => `<td>${escapeHtml(getter(item))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  $("#compare-dialog").showModal();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 2600);
}

async function shareCurrentView() {
  syncUrl();
  const shareData = { title: "전국 공공시설 개방 현황", text: `선택 조건의 공공시설 ${state.filtered.length.toLocaleString("ko-KR")}개`, url: location.href };
  try {
    if (navigator.share) await navigator.share(shareData);
    else {
      await navigator.clipboard.writeText(location.href);
      showToast("현재 조건의 링크를 복사했습니다.");
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast("링크를 복사하지 못했습니다.");
  }
}

function downloadCsv() {
  const csv = buildCsv(state.filtered);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `공공시설_검색결과_${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast(`${state.filtered.length.toLocaleString("ko-KR")}개 시설을 내려받았습니다.`);
}

function clearFilter(key) {
  state.filters[key] = DEFAULT_FILTERS[key];
  if (key === "region") {
    state.filters.district = "전체";
    updateDistrictOptions();
  }
  applyStateToControls();
  state.page = 1;
  render({ fitMap: ["region", "district", "category"].includes(key) });
}

function resetAll() {
  state.filters = { ...DEFAULT_FILTERS };
  state.page = 1;
  state.sort = "name";
  updateDistrictOptions();
  applyStateToControls();
  render({ fitMap: true });
}

function bindEvents() {
  Object.entries(FILTER_IDS).forEach(([key, id]) => {
    const control = document.getElementById(id);
    const eventName = key === "search" ? "input" : "change";
    control.addEventListener(eventName, (event) => {
      const apply = () => {
        state.filters[key] = key === "contact" ? event.target.checked : event.target.value;
        if (key === "region") {
          state.filters.district = "전체";
          updateDistrictOptions();
        }
        state.page = 1;
        render({ fitMap: ["region", "district", "category"].includes(key) });
      };
      if (key === "search") {
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(apply, 200);
      } else apply();
    });
  });
  $("#sort-select").addEventListener("change", (event) => { state.sort = event.target.value; state.page = 1; renderTable(state.filtered); syncUrl(); });
  $("#reset-button").addEventListener("click", resetAll);
  $("#share-button").addEventListener("click", shareCurrentView);
  $("#csv-button").addEventListener("click", downloadCsv);
  $("#print-button").addEventListener("click", () => window.print());
  $("#prev-page").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; renderTable(state.filtered); $("#facility-heading").focus(); } });
  $("#next-page").addEventListener("click", () => { state.page += 1; renderTable(state.filtered); $("#facility-heading").focus(); });
  $("#clear-compare").addEventListener("click", () => { state.compareIds.clear(); renderTable(state.filtered); renderCompareTray(); syncUrl(); });
  $("#open-compare").addEventListener("click", openCompare);
  $("#locate-button").addEventListener("click", () => {
    if (!navigator.geolocation) return showToast("이 브라우저에서는 위치 기능을 사용할 수 없습니다.");
    navigator.geolocation.getCurrentPosition((position) => {
      state.userLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
      state.map.showUserLocation(state.userLocation);
      $("#sort-select option[value=distance]").disabled = false;
      state.sort = "distance";
      $("#sort-select").value = "distance";
      renderTable(state.filtered);
      syncUrl();
      showToast("현재 위치에서 가까운 순서로 정렬했습니다.");
    }, () => showToast("위치를 확인하지 못했습니다. 브라우저 권한을 확인해 주세요."), { enableHighAccuracy: false, timeout: 10000 });
  });

  document.addEventListener("click", async (event) => {
    const detail = event.target.closest("[data-detail]");
    if (detail) return openDetail(detail.dataset.detail);
    const compare = event.target.closest("[data-compare]");
    if (compare) return toggleCompare(compare.dataset.compare);
    const remove = event.target.closest("[data-remove-compare]");
    if (remove) return toggleCompare(remove.dataset.removeCompare);
    const clear = event.target.closest("[data-clear-filter]");
    if (clear) return clearFilter(clear.dataset.clearFilter);
    const region = event.target.closest("[data-select-region]");
    if (region) {
      state.filters.region = region.dataset.selectRegion;
      $("#region-filter").value = state.filters.region;
      updateDistrictOptions();
      state.page = 1;
      render({ fitMap: true });
      $("#map-explorer").scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (event.target.closest("[data-close-detail]")) return closeDetail();
    if (event.target.closest("[data-close-compare]")) return $("#compare-dialog").close();
    const copy = event.target.closest("[data-copy-address]");
    if (copy) {
      const item = facilityById(copy.dataset.copyAddress);
      try { await navigator.clipboard.writeText(item.address); showToast("주소를 복사했습니다."); } catch { showToast("주소를 복사하지 못했습니다."); }
      return;
    }
    const mapFocus = event.target.closest("[data-map-focus]");
    if (mapFocus) {
      const item = facilityById(mapFocus.dataset.mapFocus);
      closeDetail();
      state.map.focus(item);
      $("#map-explorer").scrollIntoView({ behavior: "smooth" });
    }
  });

  $("#detail-dialog").addEventListener("close", () => { if (state.detailId) { state.detailId = null; syncUrl(); } });
  $("#detail-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeDetail(); });
  $("#compare-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
  window.addEventListener("popstate", () => location.reload());
}

async function init() {
  try {
    state.data = await loadFacilityData();
    populateSelect($("#region-filter"), state.data.summary.regions);
    populateSelect($("#category-filter"), state.data.summary.categories);
    readUrlState();
    if (!["전체", ...state.data.summary.regions].includes(state.filters.region)) state.filters.region = "전체";
    if (!["전체", ...state.data.summary.categories].includes(state.filters.category)) state.filters.category = "전체";
    updateDistrictOptions(state.filters.district);
    applyStateToControls();
    $("#latest-date").textContent = state.data.summary.latestDate.replaceAll("-", ".");
    const freshCount = state.data.facilities.filter((item) => freshnessOf(item.date) === "최신").length;
    $("#recent-rate").textContent = `${(freshCount / state.data.facilities.length * 100).toFixed(1)}%`;
    $("#note-generic").textContent = formatNumber.format(state.data.summary.notes.genericType);
    $("#note-coordinates").textContent = formatNumber.format(state.data.summary.notes.invalidCoordinates);
    state.map = new FacilityMap($("#map"), {
      onSelect: (id) => openDetail(id),
      onNearbyChange: renderNearby,
      onTileError: () => { $("#map-warning").hidden = false; },
    });
    bindEvents();
    render({ fitMap: state.filters.region !== "전체" || state.filters.category !== "전체", sync: false });
    syncUrl();
    if (state.detailId) openDetail(state.detailId);
  } catch (error) {
    console.error(error);
    $("#main").innerHTML = `<section class="load-error"><h1>데이터를 불러오지 못했습니다.</h1><p>${escapeHtml(error.message)}</p><button class="button button-primary" type="button" onclick="location.reload()">다시 시도</button></section>`;
  }
}

init();
