#!/usr/bin/env node
/**
 * 국토교통부 실거래가 → 정적 JSON.
 *
 * GitHub Actions 가 매일 돌려 docs/v1/ 아래에 파일을 만들고,
 * GitHub Pages 가 그 폴더를 그대로 서빙한다. 서버가 없다.
 *
 * 앱이 API를 직접 못 부르는 이유: 조회 단위가 (법정동코드 + 계약년월) 로 고정이라
 * 지도 영역으로는 부를 수 없고, 개발계정 일 10,000건 제한이 있으며,
 * 인증키가 앱 번들에 들어가면 그대로 노출된다.
 *
 * 환경변수
 *   MOLIT_SERVICE_KEY  공공데이터포털 인증키 (필수)
 *   KAKAO_REST_KEY     카카오 REST 키. 없으면 좌표를 못 채워 지도에 안 뜬다.
 *   MONTHS             수집 개월 수 (기본 12)
 *   ONLY               특정 시군구만 (쉼표 구분, 예: 11650,11680)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const RAW_KEY = (process.env.MOLIT_SERVICE_KEY ?? '').trim();

/**
 * 공공데이터포털은 인증키를 두 형태로 준다.
 *   Encoding 키 — 이미 URL 인코딩된 문자열 (%2B, %3D 등이 들어있다)
 *   Decoding 키 — 원본 (+, = 등이 그대로)
 * Encoding 키를 다시 인코딩하면 %2B 가 %252B 가 되어 인증에 실패한다
 * ("등록되지 않은 서비스키", 코드 30). 어느 쪽이 들어와도 되게 판별한다.
 */
const KEY = /%[0-9A-Fa-f]{2}/.test(RAW_KEY) ? RAW_KEY : encodeURIComponent(RAW_KEY);
const KAKAO = process.env.KAKAO_REST_KEY ?? '';
const MONTHS = Number(process.env.MONTHS ?? 12);
const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);

if (!KEY) {
  console.error('MOLIT_SERVICE_KEY 가 없습니다.');
  process.exit(1);
}

const MIN_SAMPLE = 5;
const OUT = 'docs/v1';
const GEO_CACHE = 'scripts/geo-cache.json';
const ENDPOINT =
  'https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade';

console.log(
  `인증키 ${RAW_KEY.length}자 · ${/%[0-9A-Fa-f]{2}/.test(RAW_KEY) ? 'Encoding 형태(그대로 사용)' : 'Decoding 형태(인코딩 후 사용)'}` +
  ` · 카카오 키 ${KAKAO ? '있음' : '없음'}`,
);

const lawds = JSON.parse(readFileSync('scripts/lawd.json', 'utf8'))
  .filter((l) => ONLY.length === 0 || ONLY.includes(l.code));

const geo = existsSync(GEO_CACHE) ? JSON.parse(readFileSync(GEO_CACHE, 'utf8')) : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = (b, n) => (b.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`)) ?? [, null])[1]?.trim() ?? null;
const num = (v) => {
  if (v === null) return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function months(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

async function fetchMonth(lawdCd, ym) {
  const url =
    `${ENDPOINT}?serviceKey=${KEY}` +
    `&LAWD_CD=${lawdCd}&DEAL_YMD=${ym}&numOfRows=1000&pageNo=1`;
  const res = await fetch(url);
  const xml = await res.text();

  const code = tag(xml, 'resultCode');
  if (code && code !== '00' && code !== '000') {
    const msg = tag(xml, 'resultMsg') ?? tag(xml, 'errMsg') ?? '알 수 없는 오류';
    throw new Error(`[${code}] ${msg}`);
  }
  if (xml.includes('<errMsg>')) throw new Error(tag(xml, 'errMsg'));

  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const y = tag(b, 'dealYear'), mo = tag(b, 'dealMonth'), d = tag(b, 'dealDay');
    const price = num(tag(b, 'dealAmount'));
    const sqm = num(tag(b, 'excluUseAr'));
    if (!y || !mo || !d || price === null || sqm === null) continue;

    out.push({
      name: tag(b, 'aptNm') ?? '이름없음',
      umd: tag(b, 'umdNm') ?? '',
      jibun: tag(b, 'jibun') ?? '',
      builtYear: num(tag(b, 'buildYear')),
      dealDate: `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`,
      priceManwon: Math.round(price),
      exclusiveSqm: sqm,
      floor: num(tag(b, 'floor')),
      dong: tag(b, 'aptDong')?.trim() || null,
    });
  }
  return out;
}

async function geocode(address) {
  if (geo[address] !== undefined) return geo[address];
  if (!KAKAO) return null;

  const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO}` } });
  if (!res.ok) return null;
  const j = await res.json();
  const f = j.documents?.[0];
  // 실패도 캐시한다. 매번 다시 시도하면 호출량만 낭비된다.
  const pos = f ? { lat: Number(f.y), lng: Number(f.x) } : null;
  geo[address] = pos;
  await sleep(60);
  return pos;
}

/** 면적 타입별 집계. 표본이 적으면 평균을 만들지 않는다. */
function aggregate(deals) {
  const groups = new Map();
  for (const d of deals) {
    const k = d.exclusiveSqm.toFixed(1);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  return [...groups.values()]
    .map((rows) => {
      rows.sort((a, b) => (a.dealDate < b.dealDate ? 1 : -1));
      const latest = rows[0];
      const prev = rows[1] ?? null;
      return {
        exclusiveSqm: latest.exclusiveSqm,
        // 공급면적은 실거래가 API 에 없다. 건축물대장 매칭 전까지 null 이고,
        // 앱은 null 이면 평형을 추정하지 않고 전용 ㎡만 표시한다.
        supplySqm: null,
        latestPriceManwon: latest.priceManwon,
        latestDealDate: latest.dealDate,
        latestFloor: latest.floor,
        latestDong: latest.dong,
        deltaManwon: prev ? latest.priceManwon - prev.priceManwon : null,
        sampleCount: rows.length,
        avgPriceManwon:
          rows.length >= MIN_SAMPLE
            ? Math.round(rows.reduce((s, r) => s + r.priceManwon, 0) / rows.length)
            : null,
        deals: rows.slice(0, 30).map((r) => ({
          dealDate: r.dealDate,
          priceManwon: r.priceManwon,
          floor: r.floor,
          dong: r.dong,
          exclusiveSqm: r.exclusiveSqm,
          dealType: 'sale',
        })),
      };
    })
    .sort((a, b) => b.sampleCount - a.sampleCount);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(`${OUT}/full`, { recursive: true });

  const baseAt = new Date().toISOString().slice(0, 10);
  const index = [];
  const searchIndex = [];
  const ymList = months(MONTHS);

  for (const lawd of lawds) {
    const byComplex = new Map();
    let failed = 0;

    for (const ym of ymList) {
      try {
        for (const d of await fetchMonth(lawd.code, ym)) {
          const id = `${lawd.code}:${d.name.replace(/\s+/g, '')}`;
          if (!byComplex.has(id)) {
            byComplex.set(id, {
              id,
              name: d.name,
              kind: 'apt',
              address: `${lawd.sido} ${lawd.sigungu} ${d.umd} ${d.jibun}`.trim(),
              builtYear: d.builtYear,
              deals: [],
            });
          }
          byComplex.get(id).deals.push(d);
        }
      } catch (e) {
        failed++;
        console.error(`  ! ${lawd.sigungu} ${ym}: ${e.message}`);
        // 일일 한도(22) 를 만나면 더 돌려봐야 소용없다
        if (/\[22\]|\[23\]/.test(e.message)) {
          console.error('  일일 호출 한도에 걸렸습니다. 다음 실행에서 이어집니다.');
          throw e;
        }
      }
      await sleep(120);
    }

    const summaries = [];
    const fulls = [];
    let bbox = null;

    for (const c of byComplex.values()) {
      const pos = await geocode(c.address);
      if (!pos) continue; // 좌표가 없으면 지도에 못 올린다

      const areas = aggregate(c.deals);
      if (areas.length === 0) continue;

      const base = {
        id: c.id, name: c.name, kind: c.kind, address: c.address,
        lat: pos.lat, lng: pos.lng, builtYear: c.builtYear,
        households: null, buildings: null,
      };
      // 지도용 — 대표 면적 하나만, deals 없이
      summaries.push({ ...base, areas: [{ ...areas[0], deals: [] }] });
      // 상세용 — 전체
      fulls.push({ ...base, areas });
      searchIndex.push({ id: c.id, name: c.name, address: c.address, lawd: lawd.code });

      bbox = bbox
        ? {
            swLat: Math.min(bbox.swLat, pos.lat), swLng: Math.min(bbox.swLng, pos.lng),
            neLat: Math.max(bbox.neLat, pos.lat), neLng: Math.max(bbox.neLng, pos.lng),
          }
        : { swLat: pos.lat, swLng: pos.lng, neLat: pos.lat, neLng: pos.lng };
    }

    const provenance = {
      source: '국토교통부 실거래가 공개시스템 (공공데이터포털 Open API)',
      baseAt,
      note: failed > 0 ? `${failed}개월 수집 실패` : undefined,
    };

    writeFileSync(`${OUT}/${lawd.code}.json`, JSON.stringify({ items: summaries, provenance }));
    writeFileSync(`${OUT}/full/${lawd.code}.json`, JSON.stringify({ items: fulls, provenance }));
    writeFileSync(GEO_CACHE, JSON.stringify(geo, null, 0));

    if (bbox) index.push({ code: lawd.code, sido: lawd.sido, sigungu: lawd.sigungu, bbox, count: summaries.length });
    console.log(`${lawd.sigungu}(${lawd.code}) — 단지 ${summaries.length}개, 좌표 미매칭 ${byComplex.size - summaries.length}개`);
  }

  writeFileSync(`${OUT}/index.json`, JSON.stringify({
    baseAt,
    source: '국토교통부 실거래가 공개시스템 (공공데이터포털 Open API)',
    regions: index,
  }));
  writeFileSync(`${OUT}/search.json`, JSON.stringify({ baseAt, items: searchIndex }));
  console.log(`\n완료 — 지역 ${index.length}개, 단지 ${searchIndex.length}개, 기준 ${baseAt}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
