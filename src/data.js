export const DEFAULT_FILTERS = Object.freeze({
  region: "전체",
  district: "전체",
  category: "전체",
  fee: "전체",
  weekend: "전체",
  channel: "전체",
  capacity: "전체",
  freshness: "전체",
  completeness: "전체",
  contact: false,
  search: "",
});

export async function loadFacilityData() {
  const response = await fetch("./data/manifest.json");
  if (!response.ok) throw new Error(`데이터 목록을 불러오지 못했습니다. (${response.status})`);
  const manifest = await response.json();
  if (!("DecompressionStream" in window)) {
    throw new Error("이 브라우저는 압축 데이터 해제를 지원하지 않습니다. 최신 브라우저로 접속해 주세요.");
  }
  const parts = await Promise.all(manifest.parts.map(async (partName) => {
    const partResponse = await fetch(`./data/${partName}`);
    if (!partResponse.ok || !partResponse.body) throw new Error(`${partName}을 불러오지 못했습니다.`);
    const stream = partResponse.body.pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }));
  const facilities = parts.flat();
  if (facilities.length !== manifest.summary.total) throw new Error("데이터 건수가 일치하지 않습니다.");
  return { summary: manifest.summary, facilities };
}

export function freshnessOf(dateString, now = new Date()) {
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "확인 필요";
  const ageDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (ageDays <= 365) return "최신";
  if (ageDays <= 730) return "확인 권장";
  return "오래된 정보";
}

export function completenessLevel(score) {
  if (score >= 80) return "정보 충분";
  if (score >= 55) return "일부 누락";
  return "확인 필요";
}

export function capacityMatches(capacity, range) {
  if (range === "전체") return true;
  if (!Number.isFinite(capacity) || capacity <= 0) return range === "미입력";
  if (range === "10명 이하") return capacity <= 10;
  if (range === "11~30명") return capacity >= 11 && capacity <= 30;
  if (range === "31~100명") return capacity >= 31 && capacity <= 100;
  if (range === "101명 이상") return capacity >= 101;
  return true;
}

export function filterFacilities(facilities, filters) {
  const term = filters.search.trim().toLocaleLowerCase("ko");
  return facilities.filter((item) => {
    if (filters.region !== "전체" && item.region !== filters.region) return false;
    if (filters.district !== "전체" && item.district !== filters.district) return false;
    if (filters.category !== "전체" && item.category !== filters.category) return false;
    if (filters.fee !== "전체" && item.feeStatus !== filters.fee) return false;
    if (filters.weekend !== "전체" && item.weekendStatus !== filters.weekend) return false;
    if (filters.channel !== "전체" && !item.channels.includes(filters.channel)) return false;
    if (!capacityMatches(item.capacity, filters.capacity)) return false;
    if (filters.freshness !== "전체" && freshnessOf(item.date) !== filters.freshness) return false;
    if (filters.completeness !== "전체" && completenessLevel(item.completeness) !== filters.completeness) return false;
    if (filters.contact && !item.phone && !item.website) return false;
    if (!term) return true;
    return [
      item.name, item.place, item.address, item.management, item.provider, item.department,
      item.rawType, item.normalizedType, item.amenities, item.application,
    ]
      .some((value) => String(value || "").toLocaleLowerCase("ko").includes(term));
  });
}

export function haversineKm(first, second) {
  if (!first || !second) return Number.POSITIVE_INFINITY;
  const toRad = (degree) => degree * Math.PI / 180;
  const earthRadius = 6371;
  const deltaLat = toRad(second.lat - first.lat);
  const deltaLng = toRad(second.lng - first.lng);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRad(first.lat)) * Math.cos(toRad(second.lat)) * Math.sin(deltaLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function sortFacilities(items, sort, userLocation = null) {
  const copy = [...items];
  if (sort === "capacity") {
    return copy.sort((a, b) => (b.capacity || -1) - (a.capacity || -1) || a.name.localeCompare(b.name, "ko"));
  }
  if (sort === "date") return copy.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, "ko"));
  if (sort === "distance" && userLocation) {
    return copy.sort((a, b) => haversineKm(userLocation, a) - haversineKm(userLocation, b));
  }
  return copy.sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

function safeCsvCell(value) {
  let text = String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildCsv(items) {
  const headers = [
    "시설명", "장소명", "지역", "시군구", "분류", "분류근거", "원자료유형", "요금상태", "사용료원문",
    "사용기준시간", "수용인원", "평일운영", "주말운영", "주말상태", "휴관일", "신청방법",
    "주소", "관리기관", "전화번호", "홈페이지", "데이터기준일", "정보완성도",
  ];
  const rows = items.map((item) => [
    item.name, item.place, item.region, item.district, item.category, item.categoryBasis, item.rawType, item.feeStatus,
    item.feeRaw, item.usageDuration, item.capacity, item.weekday, item.weekend, item.weekendStatus,
    item.closed, item.application, item.address, item.management, item.phone, item.website, item.date,
    `${item.completeness}%`,
  ]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(safeCsvCell).join(",")).join("\r\n")}`;
}

export function safeExternalUrl(value) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(clean) ? clean : `https://${clean}`);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}
