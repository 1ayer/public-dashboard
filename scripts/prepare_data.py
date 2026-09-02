#!/usr/bin/env python3
"""Build a browser-friendly JSON dataset from the Korean public facility CSV."""

from __future__ import annotations

import csv
import gzip
import json
import re
import statistics
import sys
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


def parse_number(value: str) -> float | None:
    cleaned = (value or "").replace(",", "").strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def region_of(row: dict[str, str]) -> str:
    address = (row.get("소재지도로명주소") or row.get("소재지지번주소") or "").strip()
    first = address.split()[0] if address else "주소 미상"
    return REGION_ALIASES.get(first, first)


def category_of(raw_type: str) -> str:
    text = raw_type.replace(" ", "")
    if re.search(r"회의|강의|교육|세미나", text):
        return "회의·교육"
    if re.search(r"강당|공연|전시|영화|문화회관|소극장|서원", text):
        return "문화·행사"
    if re.search(r"체육관|배드민턴|배드맨턴|농구|배구|탁구|헬스|수영|볼링|스쿼시|당구|생활체조", text):
        return "실내체육"
    if re.search(r"축구|풋살|야구|테니스|족구|골프|게이트볼|국궁|론볼|씨름", text):
        return "구기·라켓"
    if re.search(r"다목적|공유|동아리|광장|사랑방|레크레이션", text):
        return "다목적공간"
    if re.search(r"캠핑|휴양림|운동장", text):
        return "야외·휴양"
    return "기타"


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
    for index, row in enumerate(raw_rows, start=1):
        raw_type = (row.get("개방시설유형구분") or "기타").strip() or "기타"
        weekend_start = (row.get("주말운영시작시각") or "").strip()
        weekend_end = (row.get("주말운영종료시각") or "").strip()
        application = (row.get("신청방법구분") or "").strip()
        facility = {
            "id": index,
            "name": (row.get("개방시설명") or "명칭 없음").strip(),
            "place": (row.get("개방장소명") or "").strip(),
            "rawType": raw_type,
            "category": category_of(raw_type),
            "region": region_of(row),
            "paid": (row.get("유료사용여부") or "").strip().upper() == "Y",
            "fee": parse_number(row.get("사용료", "")),
            "capacity": parse_number(row.get("수용가능인원수", "")),
            "area": parse_number(row.get("면적", "")),
            "application": application,
            "online": bool(re.search(r"인터넷|온라인|홈페이지|예약시스템|공공서비스예약", application)),
            "weekday": f"{row.get('평일운영시작시각', '').strip()}–{row.get('평일운영종료시각', '').strip()}",
            "weekend": f"{weekend_start}–{weekend_end}",
            "weekendOpen": bool(weekend_start and weekend_end and (weekend_start, weekend_end) != ("00:00", "00:00")),
            "alwaysOpen": "연중무휴" in (row.get("휴관일") or ""),
            "closed": (row.get("휴관일") or "").strip(),
            "address": (row.get("소재지도로명주소") or row.get("소재지지번주소") or "").strip(),
            "management": (row.get("관리기관명") or "").strip(),
            "phone": (row.get("사용안내전화번호") or "").strip(),
            "website": (row.get("홈페이지주소") or "").strip(),
            "date": (row.get("데이터기준일자") or "").strip(),
            "lat": parse_number(row.get("위도", "")),
            "lng": parse_number(row.get("경도", "")),
        }
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
        "notes": {
            "unknownFee": sum(item["fee"] is None for item in facilities),
            "unknownCapacity": sum(item["capacity"] is None for item in facilities),
            "genericType": type_counts.get("기타", 0),
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
