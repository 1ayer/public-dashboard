# 전국 공공시설 개방 현황 대시보드

전국공공시설개방정보표준데이터 7,255건을 지역·시설 분류·이용 조건별로 탐색할 수 있는 정적 HTML 대시보드입니다.

## 주요 기능

- 지역 및 7개 상위 시설 분류 필터
- 시설 수, 유료 비율, 주말 운영 비율, 온라인 신청 비율 요약
- 지역·시설 유형별 분포와 이용 조건 비교
- 시설명·주소·관리기관 검색, 정렬, 페이지 탐색
- 모바일·태블릿·데스크톱 반응형 화면

## 데이터 갱신

원본 CSV는 CP949 인코딩을 사용합니다. 아래 명령으로 브라우저용 JSON을 다시 생성할 수 있습니다.

```bash
python scripts/prepare_data.py path/to/전국공공시설개방정보표준데이터.csv public/data/manifest.json
npm run build
```

## 로컬 실행

```bash
npm ci
npm run dev
```

`main` 브랜치에 푸시하면 GitHub Actions가 `dist` 폴더를 GitHub Pages에 배포합니다.
