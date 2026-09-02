import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const EXPECTED_TOTAL = 7_255;
const EXPECTED_MAP_VALID = 7_252;
const MAX_REPORTED_ERRORS = 40;

const ALLOWED_CATEGORIES = new Set([
  "회의·교육",
  "문화·행사",
  "실내체육",
  "구기·라켓",
  "다목적공간",
  "야외·휴양",
  "기타",
]);

const ALLOWED_FEE_STATUSES = new Set([
  "무료",
  "무료 표기 모순",
  "유료·금액 미입력",
  "유료·단일 금액",
  "유료·조건별 금액",
  "유료·조건부 무료",
]);

const ALLOWED_WEEKEND_STATUSES = new Set([
  "주말 운영",
  "토요일만 운영",
  "일요일만 운영",
  "휴무",
  "확인 필요",
]);

const ALLOWED_CHANNELS = new Set([
  "온라인",
  "전화",
  "방문",
  "팩스",
  "상시개방",
  "서면·공문",
  "이메일",
  "모바일",
  "키오스크",
  "추첨",
  "기타 문의",
]);

const ALLOWED_COMPLETENESS = new Set([0, 17, 33, 50, 67, 83, 100]);

// Optional values may be empty, but these keys must survive preprocessing so
// that the UI can distinguish a missing source value from an omitted field.
const REQUIRED_SOURCE_FIELDS = [
  "sourceRow",
  "name",
  "place",
  "rawType",
  "feeRaw",
  "application",
  "closed",
  "address",
  "management",
  "provider",
  "phone",
  "website",
  "date",
  "lat",
  "lng",
];

const REQUIRED_DERIVED_FIELDS = [
  "normalizedType",
  "category",
  "categoryBasis",
  "feeStatus",
  "channels",
  "weekendStatus",
  "mapValid",
  "completeness",
];

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsDirectory, "..");
const dataDirectory = path.join(repositoryRoot, "public", "data");
const manifestPath = path.join(dataDirectory, "manifest.json");

let failureCount = 0;
const reportedErrors = [];

function check(condition, message) {
  if (condition) return;
  failureCount += 1;
  if (reportedErrors.length < MAX_REPORTED_ERRORS) reportedErrors.push(message);
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function countBy(records, key) {
  const counts = new Map();
  for (const record of records) {
    const value = String(record[key]);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

function formatCounts(entries) {
  return entries.map(([label, count]) => `${label} ${count.toLocaleString("ko-KR")}`).join(", ");
}

async function loadData() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`manifest.json을 읽거나 파싱할 수 없습니다: ${error.message}`);
  }

  if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) {
    throw new Error("manifest.parts가 비어 있거나 배열이 아닙니다.");
  }

  const records = [];
  const partCounts = [];

  for (const partName of manifest.parts) {
    if (typeof partName !== "string" || path.basename(partName) !== partName) {
      throw new Error(`안전하지 않은 part 파일명입니다: ${String(partName)}`);
    }

    const partPath = path.join(dataDirectory, partName);
    let partRecords;
    try {
      const compressed = await readFile(partPath);
      partRecords = JSON.parse(gunzipSync(compressed).toString("utf8"));
    } catch (error) {
      throw new Error(`${partName}을 읽거나 압축 해제·파싱할 수 없습니다: ${error.message}`);
    }

    if (!Array.isArray(partRecords)) {
      throw new Error(`${partName}의 최상위 값이 배열이 아닙니다.`);
    }

    check(partRecords.length > 0, `${partName}이 비어 있습니다.`);
    check(partRecords.length <= 1_000, `${partName}에 1,000건을 초과한 ${partRecords.length}건이 있습니다.`);
    partCounts.push([partName, partRecords.length]);
    records.push(...partRecords);
  }

  return { manifest, records, partCounts };
}

function validateRecords(records) {
  const ids = new Set();
  const sourceRows = new Set();
  let mapValidCount = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const location = `전체 ${index + 1}번째 레코드(sourceRow=${String(record?.sourceRow ?? "없음")})`;

    check(record !== null && typeof record === "object" && !Array.isArray(record), `${location}: 객체가 아닙니다.`);
    if (record === null || typeof record !== "object" || Array.isArray(record)) continue;

    for (const field of [...REQUIRED_SOURCE_FIELDS, ...REQUIRED_DERIVED_FIELDS]) {
      check(hasOwn(record, field), `${location}: 필수 필드 '${field}'가 없습니다.`);
    }

    check(typeof record.id === "string" && /^[0-9a-f]{14}$/.test(record.id), `${location}: id '${String(record.id)}'가 14자리 소문자 SHA-1 형식이 아닙니다.`);
    check(!ids.has(record.id), `${location}: id '${String(record.id)}'가 중복되었습니다.`);
    ids.add(record.id);

    check(Number.isInteger(record.sourceRow) && record.sourceRow >= 1 && record.sourceRow <= EXPECTED_TOTAL, `${location}: sourceRow가 1~${EXPECTED_TOTAL} 범위의 정수가 아닙니다.`);
    check(!sourceRows.has(record.sourceRow), `${location}: sourceRow ${String(record.sourceRow)}가 중복되었습니다.`);
    sourceRows.add(record.sourceRow);

    check(typeof record.name === "string" && record.name.trim().length > 0, `${location}: 시설명이 비어 있습니다.`);
    check(typeof record.rawType === "string" && record.rawType.trim().length > 0, `${location}: 원 시설유형이 비어 있습니다.`);
    check(typeof record.address === "string" && record.address.trim().length > 0, `${location}: 주소가 비어 있습니다.`);
    check(typeof record.management === "string" && record.management.trim().length > 0, `${location}: 관리기관명이 비어 있습니다.`);
    check(typeof record.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.date), `${location}: 데이터기준일자 '${String(record.date)}'가 YYYY-MM-DD 형식이 아닙니다.`);

    check(ALLOWED_CATEGORIES.has(record.category), `${location}: 허용되지 않은 category '${String(record.category)}'입니다.`);
    check(ALLOWED_FEE_STATUSES.has(record.feeStatus), `${location}: 허용되지 않은 feeStatus '${String(record.feeStatus)}'입니다.`);
    check(ALLOWED_WEEKEND_STATUSES.has(record.weekendStatus), `${location}: 허용되지 않은 weekendStatus '${String(record.weekendStatus)}'입니다.`);
    check(ALLOWED_COMPLETENESS.has(record.completeness), `${location}: completeness ${String(record.completeness)}가 허용값 ${[...ALLOWED_COMPLETENESS].join(", ")} 중 하나가 아닙니다.`);

    check(Array.isArray(record.channels), `${location}: channels가 배열이 아닙니다.`);
    if (Array.isArray(record.channels)) {
      check(new Set(record.channels).size === record.channels.length, `${location}: channels에 중복값이 있습니다.`);
      for (const channel of record.channels) {
        check(ALLOWED_CHANNELS.has(channel), `${location}: 허용되지 않은 신청 채널 '${String(channel)}'입니다.`);
      }
    }

    const coordinatesAreNumbers = Number.isFinite(record.lat) && Number.isFinite(record.lng);
    check(coordinatesAreNumbers, `${location}: 위경도가 유한한 숫자가 아닙니다(lat=${String(record.lat)}, lng=${String(record.lng)}).`);
    check(typeof record.mapValid === "boolean", `${location}: mapValid가 불리언이 아닙니다.`);

    if (record.mapValid) {
      mapValidCount += 1;
      check(
        coordinatesAreNumbers
          && record.lat >= 32 && record.lat <= 39.5
          && record.lng >= 123 && record.lng <= 132,
        `${location}: mapValid=true이지만 국내 유효 범위를 벗어났습니다(lat=${String(record.lat)}, lng=${String(record.lng)}).`,
      );
    }
  }

  check(ids.size === records.length, `고유 id 수 ${ids.size}건이 전체 ${records.length}건과 다릅니다.`);
  check(sourceRows.size === records.length, `고유 sourceRow 수 ${sourceRows.size}건이 전체 ${records.length}건과 다릅니다.`);
  check(mapValidCount === EXPECTED_MAP_VALID, `mapValid=true가 ${mapValidCount}건입니다. 기대값은 ${EXPECTED_MAP_VALID}건입니다.`);

  return { mapValidCount };
}

async function main() {
  const { manifest, records, partCounts } = await loadData();
  const declaredTotal = manifest?.summary?.total;
  const partTotal = partCounts.reduce((sum, [, count]) => sum + count, 0);

  check(declaredTotal === EXPECTED_TOTAL, `manifest.summary.total이 ${String(declaredTotal)}입니다. 기대값은 ${EXPECTED_TOTAL}입니다.`);
  check(partTotal === declaredTotal, `part 합계 ${partTotal}건이 manifest.summary.total ${String(declaredTotal)}건과 다릅니다.`);
  check(records.length === partTotal, `병합 레코드 ${records.length}건이 part 합계 ${partTotal}건과 다릅니다.`);
  check(records.length === EXPECTED_TOTAL, `전체 레코드가 ${records.length}건입니다. 기대값은 ${EXPECTED_TOTAL}건입니다.`);

  const { mapValidCount } = validateRecords(records);

  if (failureCount > 0) {
    console.error(`\n❌ 데이터 검증 실패: ${failureCount.toLocaleString("ko-KR")}개 문제`);
    for (const error of reportedErrors) console.error(`- ${error}`);
    if (failureCount > reportedErrors.length) {
      console.error(`- 그 밖의 ${failureCount - reportedErrors.length}개 문제는 출력을 생략했습니다.`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("✅ 공공시설 배포 데이터 검증 통과");
  console.log(`- 총 ${records.length.toLocaleString("ko-KR")}건 / ${partCounts.length}개 part (${partCounts.map(([, count]) => count.toLocaleString("ko-KR")).join(" + ")})`);
  console.log(`- 안정 형식의 고유 id ${records.length.toLocaleString("ko-KR")}개`);
  console.log(`- 지도 유효 좌표 ${mapValidCount.toLocaleString("ko-KR")}건`);
  console.log(`- 유형: ${formatCounts(countBy(records, "category"))}`);
  console.log(`- 주말 상태: ${formatCounts(countBy(records, "weekendStatus"))}`);
  console.log(`- 요금 상태: ${formatCounts(countBy(records, "feeStatus"))}`);
  console.log(`- 완성도: ${formatCounts(countBy(records, "completeness"))}`);
}

main().catch((error) => {
  console.error(`❌ 데이터 검증을 실행할 수 없습니다: ${error.message}`);
  process.exitCode = 1;
});
