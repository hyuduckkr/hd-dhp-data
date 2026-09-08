# hd-dhp-data

HD DHP 앱의 시세 데이터. GitHub Actions 가 매일 수집하고 GitHub Pages 가 서빙한다.
서버가 없다.

## 처음 한 번

1. 이 폴더를 GitHub 저장소로 올린다 (**public** 권장 — Actions 분당 무료, Pages 무료)
2. **Settings → Secrets and variables → Actions → New repository secret** 두 개
   - `MOLIT_SERVICE_KEY` — 공공데이터포털 일반 인증키(Decoding)
   - `KAKAO_REST_KEY` — 카카오 REST API 키
3. **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main` / 폴더 `/docs` → Save
4. **Actions** 탭 → `실거래가 수집` → **Run workflow** (첫 실행은 수동)

몇 분 뒤 주소가 열린다:

```
https://<계정>.github.io/hd-dhp-data/v1/index.json
```

앱 `.env` 의 `EXPO_PUBLIC_API_BASE_URL` 에는 다음을 넣는다:

```
https://<계정>.github.io/hd-dhp-data
```

## 이후

매일 06:10 KST 에 자동 실행된다. 수동 실행 시 개월 수와 지역을 지정할 수 있다.

## 수집 범위 넓히기

`scripts/lawd.json` 이 지금은 서울 25개 구다.
전국으로 가려면 [행정표준코드관리시스템](https://www.code.go.kr)에서 법정동코드 전체자료를 받아
시군구 단위(코드 앞 5자리)만 뽑아 같은 형식으로 채우면 된다.

전국 250개 시군구 × 12개월 = 3,000 호출. 개발계정 일 10,000건 안에 들어가지만,
한 번에 다 돌리면 오래 걸리니 `ONLY` 입력으로 나눠 돌리는 편이 낫다.

## 아직 안 된 것

- **공급면적이 비어 있다** (`supplySqm: null`). 실거래가 API 는 전용면적만 준다.
  건축물대장 API 로 채워야 `34평형` 표기가 나온다. 그 전까지 앱은 평형을 추정하지 않는다.
- 아파트 매매만 수집한다. 전월세·연립다세대·단독다가구는 엔드포인트 추가 필요.
- 좌표는 카카오 지번 검색이라 일부 단지가 매칭되지 않는다. 매칭 실패한 단지는 빠진다
  (수집 로그에 개수가 찍힌다).
- 세대수·동수도 건축물대장 몫이다.
