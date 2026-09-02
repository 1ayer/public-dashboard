#!/usr/bin/env python3
"""Build a browser-friendly JSON dataset from the Korean public facility CSV."""

from __future__ import annotations

import csv
import gzip
import hashlib
import json
import re
import statistics
import sys
import unicodedata
from collections import Counter
from pathlib import Path


REGION_ALIASES = {
    "강원도": "강원특별자치도",
    "전라북도": "전북특별자치도",
    "울산": "울산광역시",
}

REGIONS = [
    "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시",
    "대전광역시", "울산광역시", "세종특별자치시", "경기도", "강원특별자치도",
    "충청북도", "충청남도", "전북특별자치도", "전라남도", "경상북도",
    "경상남도", "제주특별자치도",
]

CATEGORY_ORDER = [
    "회의·교육", "문화·행사", "실내체육", "구기·라켓",
    "다목적공간", "야외·휴양", "기타",
]

CHANNEL_ORDER = [
    "온라인", "전화", "방문", "팩스", "상시개방", "서면·공문",
    "이메일", "모바일", "키오스크", "추첨", "기타 문의",
]

CATEGORY_PATTERNS = [
    ("회의·교육", r"회의|강의|교육|세미나|교실|연수|열람실|학습"),
    ("문화·행사", r"강당|공연|전시|영화|문화회관|소극장|극장|아트홀|예술회관|서원|무대|예술"),
    ("실내체육", r"체육관|배드민턴|농구|배구|탁구|헬스|수영|볼링|스쿼시|당구|생활체조|체력단련|에어로빅|역도|무예|요가"),
    ("구기·라켓", r"축구|풋살|야구|테니스|족구|골프|게이트볼|국궁|궁도|론볼|씨름|경기장|스케이트|트랙|X-GAME|라켓"),
    ("야외·휴양", r"캠핑|야영|휴양림|운동장|공원|놀이터|광장|관광지|야외|잔디|산림"),
    ("다목적공간", r"다목적|공유|동아리|사랑방|레크레이션|요리스튜디오|주민공간|커뮤니티"),
]

# The source contains six Changwon rows whose coordinates form an artificial
# diagonal into the East Sea (35/128 through 41/134). A generous province box
# catches that address-coordinate mismatch without excluding border facilities.
REGION_COORDINATE_BOUNDS = {
    "경상남도": (34.4, 36.0, 127.3, 129.7),
}

# Two additional repeated-place patterns are contradicted by a matching row or
# a newer record at the same place and address. Raw coordinates stay in the
# record; only map display is disabled.
KNOWN_COORDINATE_OUTLIERS = {
    ("가야진사공원", 35.668489, 128.902782),
    ("화도체육문화센터", 37.605294, 127.301414),
}


def clean_text(value: str | None) -> str:
    return unicodedata.normalize("NFKC", value or "").strip()


def parse_number(value: str) -> float | None:
    cleaned = clean_text(value).replace(",", "")
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def coordinates_valid(region: str, latitude: float | None, longitude: float | None) -> bool:
    if latitude is None or longitude is None:
        return False
    if not (32 <= latitude <= 39.5 and 123 <= longitude <= 132):
        return False
    bounds = REGION_COORDINATE_BOUNDS.get(region)
    if not bounds:
        return True
    min_lat, max_lat, min_lng, max_lng = bounds
    return min_lat <= latitude <= max_lat and min_lng <= longitude <= max_lng


def region_of(row: dict[str, str]) -> str:
    address = (row.get("소재지도로명주소") or row.get("소재지지번주소") or "").strip()
    first = address.split()[0] if address else "주소 미상"
    return REGION_ALIASES.get(first, first)


def normalize_type(raw_type: str) -> str:
    return raw_type.replace("배드맨턴", "배드민턴").replace("풋살경기장", "풋살장")


def classify_text(text: str) -> str:
    compact = text.replace(" ", "")
    for category, pattern in CATEGORY_PATTERNS:
        if re.search(pattern, compact):
            return category
    return "기타"


def category_of(raw_type: str, context: str) -> tuple[str, str]:
    normalized = normalize_type(raw_type)
    direct = classify_text(normalized)
    if direct != "기타":
        return direct, "원자료"
    inferred = classify_text(context)
    if inferred != "기타":
        return inferred, "시설명·부대정보 추정"
    return "기타", "원자료"


def application_channels(application: str) -> list[str]:
    channels: list[str] = []
    patterns = [
        ("온라인", r"인터넷|온라인|홈페이지|예약시스템|공공서비스예약|공유누리|통합예약|웹"),
        ("전화", r"전화|유선"),
        ("방문", r"방문|현장|선착순|일일입장|이용권|매표"),
        ("팩스", r"FAX|팩스"),
        ("상시개방", r"상시개방|자유이용|자유 이용|자율이용|예약 없이|무료개방"),
        ("서면·공문", r"신청서|공문|서면|우편"),
        ("이메일", r"이메일|E-mail|전자우편"),
        ("모바일", r"모바일|카카오톡|앱"),
        ("키오스크", r"kiosk|키오스크"),
        ("추첨", r"추첨|추첨제"),
    ]
    for label, pattern in patterns:
        if re.search(pattern, application, flags=re.IGNORECASE):
            channels.append(label)
    if application and not channels:
        channels.append("기타 문의")
    return channels


def weekend_status(start: str, end: str, closed: str) -> str:
    if "연중무휴" in closed:
        return "주말 운영" if (start, end) != ("00:00", "00:00") else "확인 필요"
    saturday_closed = bool(re.search(r"(?:^|[+,/\s])토(?:요일)?(?:$|[+,/\s])", closed))
    sunday_closed = bool(re.search(r"(?:^|[+,/\s])일(?:요일)?(?:$|[+,/\s])", closed))
    weekend_closed = "주말" in closed
    zero_time = (start, end) == ("00:00", "00:00")
    valid_time = bool(start and end and not zero_time and start != end)
    if zero_time:
        return "휴무" if weekend_closed or (saturday_closed and sunday_closed) else "확인 필요"
    if not valid_time:
        return "확인 필요"
    if weekend_closed or (saturday_closed and sunday_closed):
        return "확인 필요"
    if sunday_closed:
        return "토요일만 운영"
    if saturday_closed:
        return "일요일만 운영"
    return "주말 운영"


def district_of(row: dict[str, str]) -> str:
    address = (row.get("소재지도로명주소") or row.get("소재지지번주소") or "").strip()
    parts = address.split()
    for token in parts[1:4]:
        clean = re.sub(r"[(),]", "", token)
        if re.search(r"(?:시|군|구)$", clean):
            return clean
    if region_of(row) == "세종특별자치시":
        for token in parts[1:4]:
            clean = re.sub(r"[(),]", "", token)
            if re.search(r"(?:읍|면|동)$", clean):
                return clean
    return ""


def completeness_score(values: dict[str, object]) -> int:
    blocks = [
        bool(values.get("address") and values.get("mapValid")),
        bool(values.get("weekdayStart") and values.get("weekendStatus") != "확인 필요"),
        bool(values.get("feeSufficient")),
        bool(values.get("application")),
        bool(isinstance(values.get("capacity"), (int, float)) and values.get("capacity", 0) > 0),
        bool(values.get("phone") or values.get("website")),
    ]
    return round(sum(blocks) / len(blocks) * 100)


def row_signature(row: dict[str, str]) -> str:
    """Return a deterministic fingerprint input without relying on row order."""
    return "\x1f".join(
        f"{key}={clean_text(row.get(key))}" for key in sorted(row)
    )


def stable_id(signature: str, occurrence: int) -> str:
    # One pair in the source is byte-for-byte identical. An occurrence suffix
    # keeps both source rows addressable while the ID set remains deterministic.
    identity = signature if occurrence == 1 else f"{signature}\x1eduplicate={occurrence}"
    return hashlib.sha1(identity.encode("utf-8")).hexdigest()[:14]


def fee_details(paid: bool, raw: str) -> tuple[str, float | None]:
    if not paid:
        numeric = parse_number(raw)
        return ("무료 표기 모순", numeric) if numeric and numeric > 0 else ("무료", numeric)
    if not raw:
        return "유료·금액 미입력", None
    if re.fullmatch(r"[0-9][0-9,]*(?:\.[0-9]+)?원?", raw):
        return "유료·단일 금액", parse_number(raw.replace("원", ""))
    if "무료" in raw:
        return "유료·조건부 무료", None
    if re.search(r"[0-9]", raw):
        return "유료·조건별 금액", None
    return "유료·금액 미입력", None


def median(values: list[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: prepare_data.py INPUT.csv OUTPUT.json")

    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    with source.open(encoding="cp949", newline="") as handle:
        raw_rows = list(csv.DictReader(handle))

    facilities: list[dict[str, object]] = []
    signature_occurrences: Counter[str] = Counter()
    for index, row in enumerate(raw_rows, start=1):
        signature = row_signature(row)
        signature_occurrences[signature] += 1
        raw_type = clean_text(row.get("개방시설유형구분")) or "기타"
        normalized_type = normalize_type(raw_type)
        name = clean_text(row.get("개방시설명")) or "명칭 없음"
        place = clean_text(row.get("개방장소명"))
        amenities = clean_text(row.get("부대시설정보"))
        category, category_basis = category_of(raw_type, f"{name} {place} {amenities}")
        weekday_start = (row.get("평일운영시작시각") or "").strip()
        weekday_end = (row.get("평일운영종료시각") or "").strip()
        weekend_start = (row.get("주말운영시작시각") or "").strip()
        weekend_end = (row.get("주말운영종료시각") or "").strip()
        application = clean_text(row.get("신청방법구분"))
        channels = application_channels(application)
        closed = clean_text(row.get("휴관일"))
        paid = (row.get("유료사용여부") or "").strip().upper() == "Y"
        fee_raw = clean_text(row.get("사용료"))
        fee_status, fee = fee_details(paid, fee_raw)
        usage_duration = parse_number(row.get("사용기준시간", ""))
        fee_per_hour = (
            round(fee / usage_duration)
            if paid and fee and usage_duration and 0 < usage_duration <= 24
            else None
        )
        latitude = parse_number(row.get("위도", ""))
        longitude = parse_number(row.get("경도", ""))
        region = region_of(row)
        map_valid = coordinates_valid(region, latitude, longitude) and (
            place, latitude, longitude
        ) not in KNOWN_COORDINATE_OUTLIERS
        weekend_state = weekend_status(weekend_start, weekend_end, closed)
        base_values: dict[str, object] = {
            "address": (row.get("소재지도로명주소") or row.get("소재지지번주소") or "").strip(),
            "management": (row.get("관리기관명") or "").strip(),
            "phone": (row.get("사용안내전화번호") or "").strip(),
            "application": application,
            "capacity": parse_number(row.get("수용가능인원수", "")),
            "date": (row.get("데이터기준일자") or "").strip(),
            "weekdayStart": weekday_start,
            "weekendStart": weekend_start if (weekend_start, weekend_end) != ("00:00", "00:00") else "",
            "website": (row.get("홈페이지주소") or "").strip(),
            "fee": fee,
            "mapValid": map_valid,
            "weekendStatus": weekend_state,
            "feeSufficient": fee_status not in {"유료·금액 미입력", "무료 표기 모순"},
        }
        facility: dict[str, object] = {
            "id": stable_id(signature, signature_occurrences[signature]),
            "sourceRow": index,
            "name": name,
            "place": place,
            "rawType": raw_type,
            "normalizedType": normalized_type,
            "category": category,
            "categoryBasis": category_basis,
            "region": region,
            "district": district_of(row),
            "paid": paid,
            "fee": fee,
            "feeRaw": fee_raw,
            "feeStatus": fee_status,
            "usageDuration": usage_duration,
            "feePerHour": fee_per_hour,
            "overtimeDuration": parse_number(row.get("초과사용단위시간", "")),
            "overtimeFee": parse_number(row.get("초과사용료", "")),
            "capacity": base_values["capacity"],
            "area": parse_number(row.get("면적", "")),
            "amenities": amenities,
            "application": application,
            "channels": channels,
            "online": "온라인" in channels,
            "weekday": f"{weekday_start}–{weekday_end}",
            "weekend": f"{weekend_start}–{weekend_end}",
            "weekendStatus": weekend_state,
            "weekendOpen": weekend_state in {"주말 운영", "토요일만 운영", "일요일만 운영"},
            "alwaysOpen": "연중무휴" in closed,
            "closed": closed,
            "address": base_values["address"],
            "management": base_values["management"],
            "provider": (row.get("제공기관명") or "").strip(),
            "department": (row.get("담당부서명") or "").strip(),
            "phone": base_values["phone"],
            "website": base_values["website"],
            "photo": (row.get("시설사진정보") or "").strip(),
            "date": base_values["date"],
            "lat": latitude,
            "lng": longitude,
            "mapValid": map_valid,
        }
        facility["completeness"] = completeness_score(base_values)
        facilities.append(facility)

    total = len(facilities)
    region_counts = Counter(item["region"] for item in facilities)
    type_counts = Counter(item["rawType"] for item in facilities)
    category_counts = Counter(item["category"] for item in facilities)
    valid_fees = [item["fee"] for item in facilities if isinstance(item["fee"], float) and item["fee"] > 0]
    valid_capacity = [item["capacity"] for item in facilities if isinstance(item["capacity"], float) and item["capacity"] > 0]
    dates = [item["date"] for item in facilities if item["date"]]

    summary = {
        "total": total,
        "latestDate": max(dates),
        "earliestDate": min(dates),
        "paidRate": round(sum(bool(item["paid"]) for item in facilities) / total * 100, 1),
        "weekendRate": round(sum(bool(item["weekendOpen"]) for item in facilities) / total * 100, 1),
        "onlineRate": round(sum(bool(item["online"]) for item in facilities) / total * 100, 1),
        "alwaysOpenRate": round(sum(bool(item["alwaysOpen"]) for item in facilities) / total * 100, 1),
        "recentRate": round(sum(str(item["date"])[:4] >= "2025" for item in facilities) / total * 100, 1),
        "medianFee": median(valid_fees),
        "medianCapacity": median(valid_capacity),
        "regionCounts": [{"name": name, "value": region_counts.get(name, 0)} for name in REGIONS],
        "typeCounts": [{"name": name, "value": value} for name, value in type_counts.most_common()],
        "categoryCounts": [{"name": name, "value": category_counts.get(name, 0)} for name in CATEGORY_ORDER],
        "regions": REGIONS,
        "categories": CATEGORY_ORDER,
        "channels": CHANNEL_ORDER,
        "notes": {
            "unknownFee": sum(item["fee"] is None for item in facilities),
            "unknownCapacity": sum(item["capacity"] is None for item in facilities),
            "genericType": type_counts.get("기타", 0),
            "invalidCoordinates": sum(not bool(item["mapValid"]) for item in facilities),
        },
    }

    target.parent.mkdir(parents=True, exist_ok=True)
    part_names: list[str] = []
    for part_number, start in enumerate(range(0, total, 1000), start=1):
        part_name = f"facilities-{part_number:02d}.json.gz"
        payload = json.dumps(
            facilities[start:start + 1000], ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        (target.parent / part_name).write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
        part_names.append(part_name)

    target.write_text(
        json.dumps({"summary": summary, "parts": part_names}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    compressed_size = sum((target.parent / name).stat().st_size for name in part_names)
    print(f"wrote {target} + {len(part_names)} parts ({compressed_size:,} bytes, {total:,} facilities)")


if __name__ == "__main__":
    main()
