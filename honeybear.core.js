/* ─────────────────────────────────────────────────────────────────────────
 * 구조 개요
 *
 *  [admin 탭]                         [Zendesk 탭]
 *  캡처(API 가로채기 or DOM 파싱)      패널이 GM 스토리지 구독
 *        │                                  ▲
 *        ▼                                  │ GM_addValueChangeListener
 *  HBStore.saveCase(envelope) ── GM 스토리지(오리진 무관) ──┘
 *
 *  - 클립보드 브릿지/TADACTX 마커 → 삭제. GM 스토리지가 두 도메인 공유.
 *  - tada_* 분산 키 20여 개 → 'hb_case' 봉투 하나로 원자적 교체.
 *  - admin에서 긁는 순간 열려있는 젠데스크 패널이 즉시 갱신됨 (탭 간 실시간).
 *  - 멘트는 코드에서 분리 → ments.json을 GM_xmlhttpRequest로 로드(CSP 무시됨).
 * ───────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // 실행 확인용 비콘 — F12 콘솔에 이 줄이 없으면 스크립트가 아예 실행되지 않은 것
  console.log('%c[HB] 허니베어 core v0.7.3 로드됨 —', 'color:#0a7d72;font-weight:bold;', location.hostname);

  const HB_VER = 2; // 케이스 봉투 스키마 버전

  /* ═══════════════════════════════════════════════════════════════════════
   * 1. HBStore — 케이스 봉투 저장소 (기존 tada_* 20여 키를 대체)
   * ═══════════════════════════════════════════════════════════════════════ */
  const HBStore = {
    emptyCase() {
      return {
        v: HB_VER,
        ts: 0,                    // 마지막 캡처 시각 (신선도 판정용)
        ids: { type: '', ride: '', resv: '', fromResv: '', user: '', driver: '' },
        trip: { name: '', dateTime: '', departure: '', destination: '', actionWord: '', timeSrc: '', lostItem: '' },
        fare: {
          total: 0, est: 0, cancel: 0, surge: 0,
          items: [],              // [{label, amt}]
          fix: null,              // {old, new, items:[{label,from,to}]} — 요금정정 시
          loss: 0                 // 영업손실비
        },
        flags: { isCash: false, isPlus: false, isFromResv: false, thirdParty: '' }
      };
    },
    loadCase() {
      const raw = GM_getValue('hb_case', null);
      if (!raw) return this.emptyCase();
      try {
        const c = JSON.parse(raw);
        if (c && c.v === HB_VER) return c;
      } catch (e) {}
      return this.emptyCase();
    },
    // 원자적 교체가 기본. 라이드→예약 팔로우업 등 병합이 필요하면
    // 호출부에서 loadCase() 후 merge해서 통째로 저장한다 (규칙이 한 곳에 모임).
    saveCase(c) {
      c.v = HB_VER;
      c.ts = Date.now();
      GM_setValue('hb_case', JSON.stringify(c));
    },
    clearCase() { GM_deleteValue('hb_case'); },
    // 다른 탭(=admin)에서 저장되면 콜백 — 젠데스크 패널 실시간 갱신의 핵심
    onChange(cb) {
      GM_addValueChangeListener('hb_case', (name, oldV, newV, remote) => {
        let c = null; try { c = newV ? JSON.parse(newV) : null; } catch (e) {}
        cb(c, remote);
      });
    }
  };

  /* 팔로우업 병합 규칙 — 기존 꿀통의 isRideAddOn/isFollowUp 분기가 여기 한 곳으로 */
  function mergeCase(prev, cur) {
    if (!prev || !prev.ts) return cur;
    const sameCase =
      (cur.ids.resv && cur.ids.resv === prev.ids.resv) ||
      (cur.ids.fromResv && cur.ids.fromResv === prev.ids.resv) ||
      (prev.ids.fromResv && prev.ids.fromResv === cur.ids.resv) ||
      (cur.ids.ride && cur.ids.ride === prev.ids.ride);
    if (!sameCase) return cur; // 다른 건이면 통째 교체 → stale 오염 원천 차단
    const out = JSON.parse(JSON.stringify(prev));
    // 빈 값으로 덮지 않는 얕은 병합
    const fill = (dst, src) => Object.keys(src).forEach(k => {
      const v = src[k];
      if (v === '' || v == null || (Array.isArray(v) && !v.length) || v === 0) return;
      dst[k] = v;
    });
    fill(out.ids, cur.ids); fill(out.trip, cur.trip); fill(out.fare, cur.fare);
    // flags 도 빈 값 보호. Object.assign 이면 유저 페이지에서 잡은 써드파티 태그가
    // 이후 라이드 페이지 캡처의 thirdParty:'' 로 지워진다.
    // 단 boolean 은 false 가 유의미한 값이므로 그대로 반영한다.
    Object.keys(cur.flags).forEach(k => {
      const v = cur.flags[k];
      if (typeof v === 'boolean') { out.flags[k] = v; return; }
      if (v === '' || v == null) return;
      out.flags[k] = v;
    });
    // 예약 문구(탑승)는 라이드(호출)보다 우선 — 기존 _timeSrc 규칙
    if (prev.trip.timeSrc === 'resv' && cur.trip.timeSrc === 'ride') {
      out.trip.actionWord = prev.trip.actionWord;
      out.trip.dateTime = prev.trip.dateTime;
      out.trip.timeSrc = 'resv';
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 2. 공통 유틸
   * ═══════════════════════════════════════════════════════════════════════ */
  const won = v => { const n = Number(String(v || '').replace(/[^0-9]/g, '')); return n ? n.toLocaleString() + '원' : ''; };
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (tag, css, html) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; };
  const onReady = fn => (document.readyState === 'loading') ? document.addEventListener('DOMContentLoaded', fn) : fn();

  const IS_ADMIN = /admin\.tadatada\.(in|com)$/.test(location.hostname);
  const IS_ZD = /zendesk\.com$/.test(location.hostname);

  /* ══════════════════════════════════════════════════════════════════
   * 2-b. 공용 파서 유틸 — ADMIN 캡처와 꿀빠는 문자가 같은 함수를 쓴다.
   *      (기존엔 hbRunBeeForm 안에만 있어 captureFromDom/simplifyAddr에서
   *       참조 불가 → 주소 정규화 규칙이 두 갈래로 갈라져 있었다)
   * ══════════════════════════════════════════════════════════════════ */

  function simplifyAddress(text){
    if(!text)return"";
    let addr=text.trim();
    addr=addr.split('（').join('(').split('）').join(')'); // 전각 괄호 → 반각 정규화
    // 괄호 안 추출: 맨 마지막 최상위 괄호 그룹만 사용
    // (영문 건물명 괄호 + 한글 주소 괄호처럼 괄호가 2개 이상일 때 둘을 한 덩어리로 묶지 않도록.
    //  중첩 괄호 '명동1(il)가'는 depth 카운트로 안전 처리)
    let _depth=0,_gStart=-1,_gEnd=-1,_lastInner=null;
    for(let _i=0;_i<addr.length;_i++){
      const _ch=addr[_i];
      if(_ch==='('){if(_depth===0)_gStart=_i;_depth++;}
      else if(_ch===')'){if(_depth>0){_depth--;if(_depth===0&&_gStart>=0){_lastInner=addr.substring(_gStart+1,_i);_gEnd=_i;}}}
    }
    // 괄호 밖 장소명(건물명) — 괄호 안이 번지수뿐이라 주소를 못 뽑을 때 폴백용
    let _outer="";
    if(_lastInner!==null&&_gStart>=0){_outer=(addr.slice(0,_gStart)+addr.slice(_gEnd+1)).replace(/\s+/g," ").trim();}
    if(_lastInner!==null){
      addr=_lastInner.trim();
    }else{
      const dongMatch=addr.match(/.*?([가-힣]+[동읍면리])(\s|$)/);
      if(dongMatch){
        const idx=addr.indexOf(dongMatch[1]);
        addr=addr.substring(0,idx+dongMatch[1].length).trim();
      }
    }
    let parts=addr.split(/\s+/);
    while(parts.length&&/^[0-9-]+$/.test(parts[parts.length-1])){parts.pop();}
    let _result=parts.join(" ");
    // 괄호 안이 전부 숫자(번지 등)라 비워지면 괄호 밖 장소명으로 폴백 (공란 방지)
    if(!_result&&_outer)_result=_outer;
    return _result;
  }

  // ── 이름 추출 헬퍼 ───────────────────────────────────────────────────
  const NOISE_FILTERS=[
    "타다앱사용회원","만족","리뷰","핸드폰 번호","실제 탑승자"
  ];
  /* ── 발송 전 안전장치 ────────────────────────────────────────────
   * 허니베어가 뽑는 건 고객에게 그대로 나가는 요금·환불 금액 문자다.
   * 채움 표시 [   ] 나 [금액] 이 남은 채 복사되면 그대로 발송될 수 있어
   * 복사 단계에서 한 번 잡는다. 상담사가 의도한 경우엔 통과시킨다. */
  function guardPlaceholders(text){
    const hits=[...String(text||'').matchAll(/\[\s*\]|\[\s{2,}\]|\[(금액|요금|숫자|날짜|시각|사유)\]/g)]
      .map(m=>m[0]);
    if(!hits.length) return true;
    return confirm(
      '⚠️ 아직 채우지 않은 항목이 '+hits.length+'개 있습니다.\n\n'+
      [...new Set(hits)].slice(0,5).join('  ')+
      '\n\n이대로 복사할까요?'
    );
  }

  function extractName(rawText){
    return rawText.split("\n")
      .map(v=>v.trim())
      .find(v=>v&&!NOISE_FILTERS.some(f=>v.includes(f)))||"(이름 미확인)";
    // 빈값 대신 명시적 fallback → 문자에 "님" 앞이 비는 문제 방지
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 3. ADMIN — (A) API 가로채기 로거  (B) 캡처
   * ═══════════════════════════════════════════════════════════════════════ */
  if (IS_ADMIN) {

    /* (A) API 발굴 모드 ────────────────────────────────────────────────────
     * DOM 스크래핑(getRowValue)을 걷어내는 게 이번 이관의 최대 이득.
     * 그러려면 어드민이 어떤 API에서 라이드/예약 JSON을 받는지 알아야 한다.
     * 켜는 법: Tampermonkey 아이콘 클릭 → 허니베어 메뉴 → "API 로그 켜기" → 새로고침.
     *          (F12 콘솔은 페이지 컨텍스트라 GM 함수가 안 보임 — 콘솔 입력 불필요)
     * 라이드 상세를 열면 콘솔에 [HB api] 로 응답 JSON 요약이 찍힌다.
     * → 엔드포인트를 파악하면 아래 captureFromApi()를 채우고 DOM 파싱을 은퇴시킨다.
     */
    const API_LOG = GM_getValue('hb_api_log', false);
    try {
      GM_registerMenuCommand(API_LOG ? '🔴 API 로그 끄기 (새로고침 필요)' : '🟢 API 로그 켜기 (새로고침 필요)', () => {
        GM_setValue('hb_api_log', !API_LOG);
        location.reload();
      });
    } catch (e) {}
    const _lastApi = {}; // url pattern → 최근 응답 (captureFromApi에서 사용)

    // 가로채기 실패가 스크립트 전체를 죽이지 않도록 격리 (버튼·캡처는 이것 없이도 동작)
    try {
      const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
      const _fetch = uw.fetch;
      uw.fetch = async function (...args) {
        const res = await _fetch.apply(this, args);
        try {
          const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
          if (/\/(rides?|rideReservations?|users?|drivers?)\//.test(url)) {
            const clone = res.clone();
            clone.json().then(j => {
              const pat = url.replace(/[A-Z0-9]{10,}/g, ':id');
              _lastApi[pat] = { url, json: j, at: Date.now() };
              _bankPut(pat, j);
              if (API_LOG) console.log('[HB api]', url, j);
            }).catch(() => {});
          }
        } catch (e) {}
        return res;
      };
      // XHR도 동일하게 (어드민이 axios/XHR 기반일 수 있음)
      const _open = uw.XMLHttpRequest.prototype.open;
      uw.XMLHttpRequest.prototype.open = function (m, url, ...rest) {
        this._hbUrl = url;
        this.addEventListener('load', function () {
          try {
            if (/\/(rides?|rideReservations?|users?|drivers?)\//.test(this._hbUrl) &&
                /json/.test(this.getResponseHeader('content-type') || '')) {
              const j = JSON.parse(this.responseText);
              const pat = this._hbUrl.replace(/[A-Z0-9]{10,}/g, ':id');
              _lastApi[pat] = { url: this._hbUrl, json: j, at: Date.now() };
              _bankPut(pat, j);
              if (API_LOG) console.log('[HB api]', this._hbUrl, j);
            }
          } catch (e) {}
        });
        return _open.call(this, m, url, ...rest);
      };
      console.log('[HB] API 가로채기 활성', API_LOG ? '(로그 ON)' : '(로그 OFF — TM 메뉴에서 켤 수 있음)');
    } catch (e) {
      console.warn('[HB] API 가로채기 실패 — 버튼/캡처는 정상 동작:', e.message);
    }

    /* 응답 구조 덤프 — captureFromApi 설계용.
     * 값은 남기되 전화번호·이메일·9자리 이상 숫자(전화/주민 류)는 마스킹.
     * TM 메뉴 "📋 API 구조 복사" 클릭 → 클립보드에 JSON 트리 복사됨. */
    function _schema(v, d) {
      if (d > 7) return '…';
      if (v == null) return v;
      if (Array.isArray(v)) {
        if (!v.length) return [];
        return v.length > 1 ? [_schema(v[0], d + 1), '…외 ' + (v.length - 1) + '개'] : [_schema(v[0], d + 1)];
      }
      if (typeof v === 'object') {
        const o = {};
        Object.keys(v).forEach(k => { o[k] = _schema(v[k], d + 1); });
        return o;
      }
      if (typeof v === 'string') {
        if (/@/.test(v)) return '(email 마스킹)';
        if (/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/.test(v) || /^\d{9,}$/.test(v)) return '(전화/숫자열 마스킹)';
        return v.length > 48 ? v.slice(0, 48) + '…' : v;
      }
      if (typeof v === 'number' && String(Math.abs(Math.trunc(v))).length >= 9) return '(num' + String(Math.trunc(v)).length + ')'; // epoch 등
      return v;
    }
    /* 구조 은행 — 페이지 이동해도 마스킹된 구조가 GM 스토리지에 누적됨.
     * (v0.1.2에서 라이드→예약 이동 시 라이드 응답이 날아가던 문제 해결) */
    function _bankPut(pat, json) {
      try {
        const bank = JSON.parse(GM_getValue('hb_schema_bank', '{}'));
        bank[pat] = _schema(json, 0);
        GM_setValue('hb_schema_bank', JSON.stringify(bank));
      } catch (e) {}
    }
    try {
      GM_registerMenuCommand('📋 API 구조 복사 (누적 은행)', () => {
        const bank = GM_getValue('hb_schema_bank', '{}');
        const n = Object.keys(JSON.parse(bank)).length;
        if (!n) { toast('아직 수집된 응답이 없어요 — 라이드/예약 상세를 먼저 열어주세요'); return; }
        const txt = JSON.stringify(JSON.parse(bank), null, 2);
        try { GM_setClipboard(txt); toast('📋 ' + n + '개 엔드포인트 구조 복사됨'); }
        catch (e) { console.log('[HB schema]\n' + txt); toast('클립보드 실패 — 콘솔에 출력했어요'); }
      });
      GM_registerMenuCommand('🗑 구조 은행 비우기', () => { GM_deleteValue('hb_schema_bank'); toast('구조 은행 비움'); });
    } catch (e) {}

    /* (B) 캡처 ────────────────────────────────────────────────────────────
     * 우선순위: API 응답(captureFromApi) → 실패 시 DOM 파싱(captureFromDom).
     * /api/rides/:id, /api/rideReservations/:id 실제 구조(2026.08 덤프) 기준 정식 매핑.
     */
    function fmtDT(ms) {
      if (!ms) return '';
      const d = new Date(Number(ms));
      if (isNaN(d.getTime())) return '';
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    function apiOf(re) {
      const k = Object.keys(_lastApi).find(k => re.test(k));
      return k ? _lastApi[k].json : null;
    }
    /* 주소 단순화: "서울 서초구 잠원동 50" → "서울 서초구 잠원동"
     * (끝의 번지·숫자 토큰 제거. 동/읍/면/가 까지만 남김) */
    // 공용 simplifyAddress 로 단일화. 자체 구현은 괄호 처리가 없어
    // "롯데월드타워 (송파구 신천동" 처럼 여는 괄호가 남은 채
    // tada_msg_data → 고객 발송 문자로 나갈 수 있었다.
    const simplifyAddr = addr => simplifyAddress(addr || '');
    /* 장소 표기: address(행정동)에서 단순화한 게 있으면 우선, 없으면 name */
    function _locName(l) {
      if (!l) return '';
      const byAddr = simplifyAddr(l.address || '');
      return byAddr || l.name || l.address || '';
    }
    /* ── 써드파티 판정 ─────────────────────────────────────────────
     * 어드민 API 응답을 실측해서 나온 규칙이다.
     *   /api/users/:id            → thirdPartyUser 채워짐
     *   rides/page 목록 API      → rider.thirdPartyUser 채워짐
     *   /api/rides/:id            → rider.thirdPartyUser 가 null (같은 유저인데도!)
     * 즉 라이드 상세에서는 rider 로 판정 불가 → paymentMethod.type 으로 잡는다.
     *
     * ⚠ 전체 응답을 문자열로 훑으면 안 된다. 오탐 지뢰가 셋 있다.
     *   - 모든 드라이버 차량의 settlementAgency 가 "TMONEY"
     *   - 일반 카드 결제의 tokenType 이 "TOSS_PG" (타다 PG사)
     *   - pgTransactionId 가 "TM_NE..." 로 시작
     *   - paymentMethod.type "TOSS_APP" 은 토스앱 등록 카드일 뿐 써드파티 아님
     *     (thirdPartyUser=null 인 유저에게서 실제로 관측됨)
     *   따라서 THIRD_PARTY_ 접두사가 붙은 것만 인정한다. */
    function _tagOfCode(code) {
      const s = String(code || '').toUpperCase();
      if (s.includes('TOSS')) return '토스 택시타기';
      if (s.includes('TMONEY')) return '티머니 고';
      return '';
    }
    /* rider/user 객체 → 태그 (목록·유저 상세에서 유효) */
    function _thirdTag(u) {
      return _tagOfCode(u && u.thirdPartyUser && u.thirdPartyUser.thirdPartyType);
    }
    /* paymentMethod → 태그 (라이드 상세의 유일한 단서) */
    function _thirdTagOfPayment(pm) {
      const t = String((pm && pm.type) || '');
      if (!/^THIRD_PARTY_/.test(t)) return '';
      return _tagOfCode(t.slice('THIRD_PARTY_'.length));
    }

    function _isPlusOf(driver, rideType) {
      return (driver && (driver.typeDisplayName === 'PLUS' || /^DTX/i.test(driver.id || ''))) || rideType === 'PREMIUM';
    }
    /* receipt(영수증) → fare.items — 기존 꿀통의 "+항목 합산" 정규식을 대체.
     * 이용요금 구성분(기본/거리/시간/driveFee)은 제외하고 추가 항목만 담는다. */
    const RECEIPT_ITEM_MAP = [
      ['tollgateFee', '톨게이트 비용'],
      ['parkingFee', '주차 요금'],
      ['additionalDistanceFee', '거리추가요금'],
      ['additionalTimeFee', '시간추가요금'],
      ['carSeatAdditionalServiceFee', '카시트 부가서비스요금'],
      ['myDriverAdditionalServiceFee', '마이 드라이버'],
      ['rideWaitingAdditionalServiceFee', '대기요금'],
      ['directRideAdditionalServiceFee', '바로배정'],
      ['callFee', '호출료'],
      ['tipAmount', '팁']
    ];
    function receiptToFare(c, r) {
      if (!r) return;
      if (r.total) c.fare.total = r.total;
      if (r.adjustedPriceTotal) c.fare.total = r.adjustedPriceTotal; // 요금정정 반영가 우선
      if (r.cancellationFee) c.fare.cancel = r.cancellationFee;
      if (r.lossFee) c.fare.loss = r.lossFee;
      RECEIPT_ITEM_MAP.forEach(([k, label]) => {
        const v = Number(r[k] || 0);
        if (v > 0) c.fare.items.push({ label, amt: v });
      });
    }

    function captureFromApi() {
      const rideM = location.href.match(/\/rides\/([A-Za-z0-9]+)/);
      const resvM = location.href.match(/\/rideReservations\/([A-Za-z0-9]+)/);

      if (resvM) {
        const j = apiOf(/\/api\/rideReservations\/:id$/);
        if (!j || j.id !== resvM[1]) return null; // 응답-URL 불일치 시 API 캡처 포기
        const c = HBStore.emptyCase();
        c.ids.type = 'resv';
        c.ids.resv = j.id;
        c.ids.ride = (j.ride && j.ride.id) || '';
        c.ids.user = (j.user && j.user.id) || '';
        c.ids.driver = (j.driver && j.driver.id) || '';
        c.trip.name = (j.user && j.user.name) || '';
        c.trip.dateTime = fmtDT(j.expectedPickUpAt);
        c.trip.actionWord = '탑승';
        c.trip.timeSrc = 'resv';
        const wps = (j.waypoints || []).map(_locName).filter(Boolean);
        const chain = [_locName(j.origin), ...wps, _locName(j.destination)].filter(Boolean);
        if (chain.length >= 2) { c.trip.departure = chain.slice(0, -1).join(' > '); c.trip.destination = chain[chain.length - 1]; }
        else { c.trip.departure = _locName(j.origin); c.trip.destination = _locName(j.destination); }
        const est = j.estimation || {};
        c.fare.est = est.totalFee || 0;
        c.fare.surge = est.surgePercentage || 0;
        if (est.tollFee && !(j.ride && j.ride.receipt)) c.fare.items.push({ label: '톨게이트 비용(예상)', amt: est.tollFee });
        // 예약 자체 영수증(취소수수료 등) + 파생 라이드 영수증(최종요금) 모두 반영
        receiptToFare(c, j.receipt);
        if (j.ride) receiptToFare(c, j.ride.receipt);
        c.flags.isCash = !!j.isOnSitePayment;
        c.flags.thirdParty = _thirdTag(j.user)
          || _thirdTagOfPayment(j.paymentMethod);
        c.flags.isPlus = _isPlusOf(j.driver, j.rideType);
        return c;
      }

      if (rideM) {
        const j = apiOf(/\/api\/rides\/:id$/);
        if (!j || j.id !== rideM[1]) return null;
        const c = HBStore.emptyCase();
        c.ids.type = 'ride';
        c.ids.ride = j.id;
        c.ids.user = (j.rider && j.rider.id) || '';       // 라이드는 user가 아니라 rider
        c.ids.driver = (j.driver && j.driver.id) || '';
        c.trip.name = (j.rider && j.rider.name) || '';
        c.trip.dateTime = fmtDT(j.createdAt);              // 호출 시각
        c.trip.actionWord = '호출';
        c.trip.timeSrc = 'ride';
        const stops = [...(j.stopovers || []), ...(j.waypoints || [])].map(_locName).filter(Boolean);
        const chain = [_locName(j.origin), ...stops, _locName(j.destination)].filter(Boolean);
        if (chain.length >= 2) { c.trip.departure = chain.slice(0, -1).join(' > '); c.trip.destination = chain[chain.length - 1]; }
        else { c.trip.departure = _locName(j.origin); c.trip.destination = _locName(j.destination); }
        c.fare.est = (j.estimation && (j.estimation.minCost || j.estimation.maxCost)) || 0;
        c.fare.surge = j.surgePercentage || 0;
        receiptToFare(c, j.receipt);
        if (!c.fare.total && j.cost) c.fare.total = j.cost;
        // 예약 파생 라이드: 중첩 rideReservation에서 예약 ID까지 즉시 확보
        if (j.rideReservation && j.rideReservation.id) {
          c.ids.fromResv = j.rideReservation.id;
          c.ids.resv = j.rideReservation.id;
          c.flags.isFromResv = true;
          // 예약 탑승 시각·문구가 라이드 호출 시각보다 우선 (기존 꿀통 규칙과 동일)
          if (j.rideReservation.expectedPickUpAt) {
            c.trip.dateTime = fmtDT(j.rideReservation.expectedPickUpAt);
            c.trip.actionWord = '탑승';
            c.trip.timeSrc = 'resv';
          }
        }
        c.flags.isCash = !!j.isOnSitePayment;
        c.flags.thirdParty = _thirdTag(j.rider)
          || _thirdTagOfPayment(j.paymentMethod)
          || _thirdTagOfPayment(j.paymentProfile && j.paymentProfile.paymentMethod)
          || _thirdTagOfPayment(j.payment && j.payment.paymentMethod);
        c.flags.isPlus = _isPlusOf(j.driver, j.type);
        return c;
      }
      return null;
    }

    function getRowValue(label) {
      const row = [...document.querySelectorAll('tr')]
        .find(tr => tr.innerText.replace(/\s+/, ' ').trim().startsWith(label));
      if (!row) return '';
      return row.innerText.replace(/^[^\t]*\t/, '').trim();
    }

    /* DOM 폴백 — API 캡처가 실패했을 때 어드민 표를 직접 읽는다.
     * honey.html(꿀통 북마클릿)에서 검증된 파싱을 봉투 스키마로 이식.
     * API 분기와 같은 모양의 case 를 돌려주는 것이 계약이다. */
    function captureFromDom() {
      const ride = location.href.match(/\/rides\/([A-Za-z0-9]+)/);
      const resv = location.href.match(/\/rideReservations\/([A-Za-z0-9]+)/);
      if (!ride && !resv) return null;

      const c = HBStore.emptyCase();
      const body = document.body.innerText;

      // ── 공통: 이름 ──────────────────────────────────────────────
      c.trip.name = extractName(getRowValue('탑승자') + '\n' + getRowValue('호출자'));

      // ── 공통: 플러스 감지 (라인업 문구 or 드라이버 ID DTX 접두) ──
      const lineup = getRowValue('라인업 / 운행타입') || getRowValue('라인업') || getRowValue('운행타입');
      const driverIds = (getRowValue('드라이버').match(/[A-Za-z0-9]+/g) || []);
      c.flags.isPlus = /플러스/i.test(lineup) || driverIds.some(id => /^DTX/i.test(id));
      // '써드파티 정보' 행 자체는 라이드·예약 페이지에 없다. 다만 어드민이
      // 유저 표기를 "7580 (TOSS)" 형태로 렌더하므로 탑승자·호출자 칸에서 건질 수 있다.
      // 못 건지면 빈값을 넣지 않고 그대로 둔다 → mergeCase 가 유저 페이지 값을 보존.
      // 어드민이 유저 칸을 "7580 (TOSS)" 로 렌더 → 괄호 안 코드만 정확히 집는다.
      const _tpm = (getRowValue('탑승자') + ' ' + getRowValue('호출자'))
        .match(/[(（]\s*(TOSS|TMONEY)\s*[)）]/i);
      const _tp = _tpm ? _tagOfCode(_tpm[1]) : '';
      if (_tp) c.flags.thirdParty = _tp;

      // ── 공통: 취소수수료 (+N원(취소 수수료) 패턴, 라이드·예약 모두 표기됨) ──
      let cancel = 0;
      for (const mm of body.matchAll(/\+\s*([\d,]+)\s*원?\s*[(（]([^)）]*취소\s*수수료[^)）]*)[)）]/g)) {
        cancel += Number(mm[1].replace(/,/g, ''));
      }
      c.fare.cancel = cancel;

      // ── 경로 조립 헬퍼: [출발, ...경유, 도착] → departure / destination ──
      const chainTo = (dep, vias, dest) => {
        const chain = [dep, ...vias, dest].filter(Boolean);
        if (chain.length >= 2) {
          c.trip.departure = chain.slice(0, -1).join(' > ');
          c.trip.destination = chain[chain.length - 1];
        } else { c.trip.departure = dep || ''; c.trip.destination = dest || ''; }
      };

      if (ride) {
        c.ids.type = 'ride';
        c.ids.ride = ride[1];
        c.flags.isCash = getRowValue('탑승자').includes('현장결제');
        c.trip.dateTime = getRowValue('호출 시각') || getRowValue('요청 탑승 일시');
        c.trip.actionWord = '호출';
        c.trip.timeSrc = 'ride';

        // 경로: "출발:/경유N:/도착:" 복합 행이 있으면 우선, 없으면 출발지·도착지 행
        const route = getRowValue('경로');
        if (route) {
          let dep = '', dest = ''; const vias = [];
          route.split('\n').map(v => v.trim()).filter(Boolean).forEach(line => {
            if (line.startsWith('출발:')) dep = simplifyAddress(line.replace('출발:', '').trim());
            else if (line.startsWith('도착:')) dest = simplifyAddress(line.replace('도착:', '').trim());
            else if (line.startsWith('경유')) vias.push(simplifyAddress(line.replace(/^경유\s*\d+:\s*/, '').trim()));
          });
          chainTo(dep, vias, dest);
        } else {
          chainTo(simplifyAddress(getRowValue('출발지')), [], simplifyAddress(getRowValue('도착지')));
        }

        // 실제요금: "총N원" > "= N" > "N원" 순
        const realRaw = getRowValue('실제요금').replace(/,/g, '');
        const mTot = realRaw.match(/총\s*([0-9]+)\s*원/);
        const mEq  = realRaw.match(/=\s*([0-9]+)/);
        const mNum = realRaw.match(/^([0-9]+)\s*원/);
        c.fare.total = Number((mTot || mEq || mNum || [0, 0])[1]) || 0;

        // 영수증 "+금액(항목)" 합산이 있으면 그쪽이 정본 (할인·크레딧 제외)
        // 합산 범위를 영수증 칸으로 한정 — 실제요금 행의 계산식까지 긁으면 이중 계상된다.
        const EXCLUDE = /할인|크레딧|계좌\s*이체|포인트/;
        const norm = l => l.replace(/\s+/g, '')
                           .replace(/^추가거리요금$/, '거리추가요금')
                           .replace(/^추가시간요금$/, '시간추가요금');
        let sum = 0; const seen = new Set();
        for (const mm of getRowValue('영수증').matchAll(/\+\s*([\d,]+)\s*[(（]([^)）]+)[)）]/g)) {
          const amt = Number(mm[1].replace(/,/g, '')); const label = norm(mm[2].trim());
          if (!amt || EXCLUDE.test(label) || seen.has(label)) continue;
          seen.add(label); sum += amt;
        }
        if (sum > 0) c.fare.total = sum;

        // 요금정정 세부항목 (이용요금 제외한 추가 항목만)
        const itemSeen = new Set();
        for (const mm of body.matchAll(/\+\s*([\d,]+)\s*[(（]([^)）]+)[)）]/g)) {
          const amt = Number(mm[1].replace(/,/g, '')); const label = norm(mm[2].trim());
          if (!amt || /이용요금/.test(label) || itemSeen.has(label)) continue;
          itemSeen.add(label); c.fare.items.push({ label, amt });
        }

        const mEst = getRowValue('예상요금').replace(/,/g, '').match(/([0-9]+)/);
        c.fare.est = mEst ? Number(mEst[1]) : 0;

        // 예약 파생 라이드 — "호출 예약" 행에서 예약 ID 확보
        const resvRow = [...document.querySelectorAll('tr')]
          .find(tr => tr.innerText.replace(/\s+/, ' ').trim().startsWith('호출 예약'));
        const raw = resvRow ? resvRow.innerText.replace(/^호출\s*예약[\s\t\n]*/, '').trim() : '';
        const rid = (raw.match(/[A-Z0-9]{10,}/) || [''])[0];
        if (rid.length >= 10 && !/해당\s*없음/.test(raw)) {
          c.ids.fromResv = rid; c.ids.resv = rid; c.flags.isFromResv = true;
        }
      } else {
        c.ids.type = 'resv';
        c.ids.resv = resv[1];
        c.flags.isCash = false;
        c.trip.dateTime = getRowValue('요청 탑승 일시') || getRowValue('호출 시각');
        c.trip.actionWord = '탑승';
        c.trip.timeSrc = 'resv';

        const via = getRowValue('경유지');
        let vias = [];
        if (via && via.trim() && via.trim() !== '-') {
          vias = via.split('\n').map(l => l.trim())
            .filter(l => l && l !== '-' && !/^총\s*경유지/.test(l))
            .map(l => { const mm = l.match(/^-?\s*경유지\s*\d+\s*:\s*(.+)$/); return simplifyAddress(mm ? mm[1].trim() : l); })
            .filter(Boolean);
        }
        chainTo(simplifyAddress(getRowValue('출발지')), vias, simplifyAddress(getRowValue('도착지')));

        // 예약의 "예상요금 구성항목"은 실제 청구액이 아니라 신뢰하지 않는다.
        // 라이드 페이지를 거쳐 이미 실제요금을 모은 경우는 mergeCase 가 살려준다.
        c.fare.total = 0;

        // 예약 파생 라이드 ID (운행 정보 행)
        const rr = (getRowValue('운행 정보').match(/[A-Z0-9]{10,}/) || [''])[0];
        if (rr) c.ids.ride = rr;
      }

      c.ids.user = (getRowValue('탑승자').match(/[A-Z0-9]{10,}/) || [''])[0] || c.ids.user;
      c.ids.driver = (getRowValue('드라이버').match(/[A-Z0-9]{10,}/) || [''])[0] || c.ids.driver;
      return c;
    }

    /* API 우선, 빈칸은 DOM 으로 메운다.
     * 기존엔 API 성공 시 DOM 을 아예 안 봐서, API 응답에 없는 필드
     * (써드파티 태그, 영수증 세부항목 등)가 통째로 비는 경우가 있었다.
     * 반대로 API 실패 시엔 DOM 단독으로 완결되어야 한다. */
    /* 유저·파트너 페이지 — 라이드/예약과 달리 '건'이 아니라 '주체' 정보다.
     * 통째 교체하면 진행 중인 케이스가 날아가므로 기존 봉투에 덧칠만 한다.
     * (써드파티 정보 행은 /users/{id} 에만 존재 — 라이드·예약 페이지엔 없다) */
    function capturePartyPage() {
      const u = location.href.match(/\/users\/([A-Za-z0-9]+)/);
      const d = location.href.match(/\/drivers\/([A-Za-z0-9]+)/);
      if (!u && !d) return null;

      const c = HBStore.loadCase();
      let label = '';
      if (u) {
        c.ids.user = u[1];
        const tag = _tagOfCode(getRowValue('써드파티 정보'));
        c.flags.thirdParty = tag;   // 없는 유저면 명시적으로 비운다
        label = tag ? '👤 유저 저장 (' + tag + ')' : '👤 유저 저장';
      } else {
        c.ids.driver = d[1];
        label = '🚕 파트너 저장';
      }
      HBStore.saveCase(c);
      toast(label);
      return true;
    }

    function capture() {
      try { if (capturePartyPage()) return; } catch (e) { console.warn('[HB] 주체 캡처 오류:', e.message); }
      let api = null, dom = null;
      try { api = captureFromApi(); } catch (e) { console.warn('[HB] API 캡처 오류:', e.message); }
      try { dom = captureFromDom(); } catch (e) { console.warn('[HB] DOM 캡처 오류:', e.message); }
      if (!api && !dom) { toast('🍯 캡처할 라이드/예약을 찾지 못했습니다'); return; }

      let cur, src;
      if (api && dom) { cur = fillBlanks(api, dom); src = 'API+DOM'; }
      else { cur = api || dom; src = api ? 'API' : 'DOM'; }

      const merged = mergeCase(HBStore.loadCase(), cur);
      HBStore.saveCase(merged);

      const gaps = missingFields(merged);
      toast(gaps.length
        ? '🍯 캡처 완료 (' + src + ') — 미확보: ' + gaps.join(', ')
        : '🍯 캡처 완료 (' + src + ') → 젠데스크 패널 실시간 갱신');
    }

    /* base 의 빈 값만 alt 로 채운다. 0·''·[] 를 빈 값으로 본다. */
    function fillBlanks(base, alt) {
      const blank = v => v === '' || v === 0 || v === null || v === undefined ||
                         (Array.isArray(v) && v.length === 0);
      ['ids', 'trip', 'fare', 'flags'].forEach(g => {
        Object.keys(base[g] || {}).forEach(k => {
          if (blank(base[g][k]) && !blank(alt[g] && alt[g][k])) base[g][k] = alt[g][k];
        });
      });
      return base;
    }

    /* 문자 양식에서 [   ] 로 비어 나갈 항목을 미리 알려준다 */
    function missingFields(c) {
      const out = [];
      if (!c.trip.name || c.trip.name === '(이름 미확인)') out.push('이름');
      if (!c.trip.dateTime) out.push('일시');
      if (!c.trip.departure && !c.trip.destination) out.push('경로');
      if (!c.fare.total && !c.fare.cancel) out.push('요금');
      return out;
    }

    /* 플로팅 버튼 — 누르면 자동 캡처 후 도구 선택창 (드래그 이동 가능) */
    onReady(() => {
      const isRideResvPage = () => /\/(rides|rideReservations)\/[A-Za-z0-9]+/.test(location.pathname);

      function openPicker() {
        const old = document.getElementById('hb_picker'); if (old) { old.remove(); return; }
        // 누르는 즉시 캡처 → 젠데스크 패널로 자동 전송
        try { capture(); } catch (e) { console.warn('[HB] 캡처 오류:', e.message); }

        const ok = isRideResvPage();
        if (!ok) return; // 유저·파트너 페이지: 캡처만 하고 선택창 없음

        const r = fab.getBoundingClientRect();
        const wrap = el('div', `position:fixed;left:${Math.max(8, r.left - 150)}px;top:${Math.max(8, r.top - 108)}px;z-index:1000000;display:flex;flex-direction:column;gap:6px;min-width:186px;background:#fff;border:1px solid #e6eae8;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.2);padding:10px;font-family:-apple-system,sans-serif;`);
        wrap.id = 'hb_picker';
        const c = HBStore.loadCase();
        if (c && c.ts) {
          wrap.appendChild(el('div', 'font-size:10px;color:#7b857f;margin-bottom:2px;line-height:1.4;',
            '✅ 캡처됨 · 젠데스크 전송<br>' + (c.trip.name ? c.trip.name + ' · ' : '') + (c.trip.dateTime || '')));
        }
        const mk = (label, fn) => {
          const b = el('button', 'padding:9px;border-radius:8px;border:1px solid #e6eae8;background:#fff;color:#243027;font-size:12.5px;font-weight:bold;cursor:pointer;text-align:left;', label);
          b.onclick = () => { wrap.remove(); fn(); };
          return b;
        };
        wrap.appendChild(mk('🍯 꿀통양식', () => { try { hbRunHoneyForm(); } catch (e) { console.warn('[HB] 꿀통 오류:', e.message); toast('🍯 실행 오류 — 콘솔 확인'); } }));
        wrap.appendChild(mk('🐻 꿀빠는 문자', () => { try { hbRunBeeForm(); } catch (e) { console.warn('[HB] 꿀빠는곰 오류:', e.message); toast('🐻 실행 오류 — 콘솔 확인'); } }));
        document.body.appendChild(wrap);
        const off = e => { if (!wrap.contains(e.target) && e.target !== fab) { wrap.remove(); document.removeEventListener('mousedown', off); } };
        setTimeout(() => document.addEventListener('mousedown', off), 0);
      }

      const fab = el('button', 'position:fixed;right:18px;bottom:18px;z-index:999999;width:46px;height:46px;border-radius:50%;border:none;background:#0a7d72;color:#fff;font-size:20px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;', '🍯');
      fab.id = 'hb_fab';
      fab.title = '허니베어 — 캡처 + 도구 (드래그로 이동)';
      document.body.appendChild(fab);

      // 드래그 이동 (움직였으면 클릭으로 치지 않음)
      let dx = 0, dy = 0, sx = 0, sy = 0, moved = false, dragging = false;
      fab.addEventListener('mousedown', e => {
        dragging = true; moved = false;
        const r = fab.getBoundingClientRect();
        fab.style.right = 'auto'; fab.style.bottom = 'auto';
        fab.style.left = r.left + 'px'; fab.style.top = r.top + 'px';
        sx = e.clientX; sy = e.clientY; dx = r.left; dy = r.top;
        e.preventDefault();
      });
      document.addEventListener('mousemove', e => {
        if (!dragging) return;
        if (Math.abs(e.clientX - sx) > 3 || Math.abs(e.clientY - sy) > 3) moved = true;
        fab.style.left = Math.max(0, dx + e.clientX - sx) + 'px';
        fab.style.top = Math.max(0, dy + e.clientY - sy) + 'px';
      });
      document.addEventListener('mouseup', () => {
        if (dragging && !moved) openPicker();
        dragging = false;
      });

      document.addEventListener('keydown', e => {
        if (!e.altKey) return;
        if (e.code === 'KeyH') capture();
        else if (e.code === 'KeyK' && isRideResvPage()) { try { hbRunHoneyForm(); } catch (err) {} }
        else if (e.code === 'KeyB' && isRideResvPage()) { try { hbRunBeeForm(); } catch (err) {} }
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 4. ZENDESK — 라이브 패널 (티켓뷰 이식 목적지)
   * ═══════════════════════════════════════════════════════════════════════ */
  if (IS_ZD) {

    /* 멘트 분리 로드: GM_xmlhttpRequest는 페이지 CSP·CORS의 영향을 받지 않음.
     * ments.json = { v, updatedAt, ments:[...] }. (캐시 10분, 실패 시 캐시 폴백) */
    const MENTS_URL = 'https://raw.githubusercontent.com/zyersndogpig/honeybear/main/ments.json';
    function loadMents(cb) {
      const cached = GM_getValue('hb_ments_cache', null);
      const at = GM_getValue('hb_ments_at', 0);
      const parse = s => { try { const j = JSON.parse(s); return Array.isArray(j) ? j : (j.ments || []); } catch (e) { return []; } };
      if (cached && Date.now() - at < 10 * 60 * 1000) { cb(parse(cached)); return; }
      GM_xmlhttpRequest({
        method: 'GET', url: MENTS_URL + '?t=' + Date.now(),
        onload: r => {
          const arr = parse(r.responseText);
          if (arr.length) { GM_setValue('hb_ments_cache', r.responseText); GM_setValue('hb_ments_at', Date.now()); cb(arr); }
          else cb(cached ? parse(cached) : []);
        },
        onerror: () => cb(cached ? parse(cached) : [])
      });
    }

    /* ── 토큰 치환 — 봉투에서 직접 ── */
    function tokensOf(c) {
      const toll = (c.fare.items || []).find(i => /톨게이트|통행료|톨/.test(i.label));
      const IS_RESV = c.trip.actionWord === '탑승' || c.trip.timeSrc === 'resv' || c.flags.isFromResv;
      const dt = c.trip.dateTime || '[   ]';
      const route = (!c.trip.departure && !c.trip.destination) ? '[   ]'
        : '[' + (c.trip.departure || '   ') + ' > ' + (c.trip.destination || '   ') + ']';
      return {
        name: c.trip.name, dateTime: c.trip.dateTime,
        departure: c.trip.departure, destination: c.trip.destination,
        actionWord: c.trip.actionWord || (IS_RESV ? '탑승' : '호출'),
        lostItem: c.trip.lostItem,
        rideId: c.ids.ride, resvId: c.ids.resv,
        totalFare: won(c.fare.total), estFare: won(c.fare.est), cancelFee: won(c.fare.cancel),
        surge: c.fare.surge ? (c.fare.surge + '%') : '',
        toll: toll ? won(toll.amt) : '', lossAmount: won(c.fare.loss),
        fixOld: c.fare.fix ? won(c.fare.fix.old) : won(c.fare.total),
        fixNew: c.fare.fix ? won(c.fare.fix.new) : won(c.fare.est),
        fareFix: c.fare.fix ? (won(c.fare.fix.old) + ' > ' + won(c.fare.fix.new)) : '',
        fixLines: c.fare.fix ? (c.fare.fix.items || []).map(i => i.label + ' : ' + won(i.from) + ' > ' + won(i.to)).join('\n') : '',
        fixItems: c.fare.fix && (c.fare.fix.items || []).length ? ('\n' + (c.fare.fix.items || []).map(i => i.label + ' : ' + won(i.from) + ' > ' + won(i.to)).join('\n')) : '',
        fixIntro: '', lossPara: '',
        rideLine: (IS_RESV ? (dt + ' 탑승하시어') : (dt + '에 호출하시어')) + ' ' + route
      };
    }
    function fillTokens(text, c) {
      const T = tokensOf(c);
      return (text || '').replace(/\{(\w+)\}/g, (w, k) => (T[k] != null && T[k] !== '') ? T[k] : '[   ]');
    }

    /* ── 대괄호 처리 (원본 processBrackets 동일) ──
     * 긴 문장형 [..] = 선택 문단(토글), 짧은 [   ]/[금액] = 채움 표시(유지) */
    function processBrackets(text, includeOptional) {
      return text.replace(/\n*\[([\s\S]*?)\]\n*/g, (whole, inner) => {
        const optional = inner.trim().length > 15 || /[.!?。]/.test(inner);
        if (!optional) return whole;
        return includeOptional ? ('\n\n' + inner.trim() + '\n\n') : '\n\n';
      }).replace(/\n{3,}/g, '\n\n').trim();
    }
    function hasOptionalBracket(t) {
      const re = /\[([\s\S]*?)\]/g; let m;
      while ((m = re.exec(t))) { const i = m[1].trim(); if (i.length > 15 || /[.!?。]/.test(i)) return true; }
      return false;
    }
    function optionalBracketName(t) {
      const re = /\[([\s\S]*?)\]/g; let m;
      while ((m = re.exec(t))) { const i = m[1].trim();
        if (!(i.length > 15 || /[.!?。]/.test(i))) continue;
        if (/차단/.test(i)) return '영구 차단';
        if (/환불/.test(i)) return '운행요금 전액 환불 불가';
        return '선택 문구';
      }
      return '선택 문구';
    }

    /* ── 고객 인입 파싱 (원본 로직 이식: 메시징/이메일/일반 티켓) ── */
    function isNoiseLine(ml) {
      return (!ml || ml === '•' || ml === 'A form was sent:' || ml === '내부' ||
        ml === '드라이버 상담사' || /^TADA /.test(ml) || /^Web User [a-f0-9]/.test(ml) ||
        ml === '대화' || /님과의 대화$/.test(ml) || /^메시징을 통해$|^웹 양식을 통해$|^이메일을 통해$|^전화를 통해$|^티켓 요약 보기$|^대화 로그$/.test(ml) ||
        /^(오늘|어제|그제|월요일|화요일|수요일|목요일|금요일|토요일|일요일) \d{1,2}:\d{2}$/.test(ml) ||
        /^\d{1,2}:\d{2}$/.test(ml) || /^메시지 작성기$|^메시징$|^보내기$/.test(ml) ||
        /^존함을 말씀|^필요시 추가확인|^사진 또는 자료/.test(ml) ||
        /^상담 중인 날짜|^감사합니다|^오늘도 안전/.test(ml) ||
        /^\d{4}-\d{2}-\d{2}$|^\d{2}-\d{2}$/.test(ml) ||
        /^오류 제보|^유선 상담 중 자료|^계약 및 해지|^기타$/.test(ml) ||
        /^\d{10,11}$/.test(ml) || /^\d{3,4}-\d{3,4}-\d{4}$/.test(ml));
    }
    /* 고객 인입 파싱 — 원본 zendesk.html 103~361줄 그대로 (검증된 티켓뷰 코드) */
    function parseInboundOriginal() {
      // ── 고객 메시지 추출 ──
      let customerMsg='';
      let customerMsgs=[]; // 고객이 여러 번 인입한 경우 모두 수집
      
      // 이메일/일반 티켓: 첫 문의가 제목에 담기는 경우가 있어 티켓 제목을 인입 후보로 확보
      function cleanSubj(t){
      return (t||'')
      .replace(/^\s*\(\d+\)\s*/,'')                                                          // (3) 안읽음 카운트 접두
      .replace(/^\s*(티켓|제목|subject)\s*[:：]\s*/i,'')                                       // 라벨 접두
      .replace(/\s*[–—\-|·]\s*(VCNC|TADA|타다|Zendesk|젠데스크|Agent\s*Workspace)\b.*$/i,'')   // 사이트 접미(+뒤따르는 잡텍스트까지)
      .replace(/:\s*[^\s:]+\.(png|jpe?g|gif|pdf|heic|webp)\s*$/i,'')                          // 첨부 파일명 접미
      .replace(/\s*[.…]{1,3}\s*$/,'')                                                          // 말줄임표
      .trim();
      }
      function getTicketSubject(){
      try{
      const sels=['[data-test-id="ticketHeader-subject"]','[data-test-id="ticket-pane-subject"]','input[data-test-id="ticket-subject-field"]','input[name="subject"]','[data-test-id="ticketFieldSubject"] input'];
      for(const s of sels){
      const el=document.querySelector(s);
      if(el){ const t=(el.value||el.innerText||'').trim(); if(t.length>1) return cleanSubj(t); }
      }
      let t=(document.title||'').trim().replace(/^\(\d+\)\s*/,'');
      if(t.length>1 && !/^https?:/i.test(t) && !/응대 도우미|티켓 뷰|적재 복사|적재 완료/.test(t)) return cleanSubj(t);
      }catch(e){}
      return '';
      }
      
      try{
      const bodyText=document.body.innerText;
      const bodyLimit=bodyText.indexOf('메시지 작성기');
      
      let activeConv=null;
      const allConvs=[...document.querySelectorAll('[data-test-id="ticket-main-conversation"]')];
      if(allConvs.length===0){
      allConvs.push(...document.querySelectorAll('[class*="conversation"]'));
      }
      for(const c of allConvs){
      const r=c.getBoundingClientRect();
      const st=getComputedStyle(c);
      const isVisible=r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none';
      const hasContent=(c.innerText||'').trim().length>5;
      if(isVisible&&hasContent){activeConv=c;break;}
      }
      const convEl=activeConv
      ||document.querySelector('[data-test-id="ticket-main-conversation"]')
      ||document.querySelector('[class*="conversation"]')
      ||document.querySelector('main')
      ||document.body;
      
      const scopedComments=(convEl&&convEl.querySelectorAll('.zd-comment').length>0)
      ?convEl.querySelectorAll('.zd-comment')
      :document.querySelectorAll('.zd-comment');
      
      const isMessaging = !!(convEl && /Web User [a-f0-9]+/.test(convEl.innerText));
      if(isMessaging){
      const rawLines=convEl.innerText.split('\n');
      const cutLineIdx=rawLines.findIndex(l=>l.trim()==='메시지 작성기');
      const allLines=cutLineIdx>=0?rawLines.slice(0,cutLineIdx):rawLines;
      
      let lastAgentIdx=-1;
      for(let k=0;k<allLines.length;k++){
      if(allLines[k].trim()==='드라이버 상담사') lastAgentIdx=k;
      }
      const scanFrom=0; void lastAgentIdx;
      
      const isNoise=(ml)=>(
      !ml||ml==='•'||ml==='A form was sent:'||ml==='내부'||
      ml==='드라이버 상담사'||/^TADA /.test(ml)||/^Web User [a-f0-9]/.test(ml)||
      ml==='대화'||/님과의 대화$/.test(ml)||/^메시징을 통해$|^웹 양식을 통해$|^이메일을 통해$|^전화를 통해$|^티켓 요약 보기$|^대화 로그$/.test(ml)||
      /^(오늘|어제|그제|월요일|화요일|수요일|목요일|금요일|토요일|일요일) \d{1,2}:\d{2}$/.test(ml)||
      /^\d{1,2}:\d{2}$/.test(ml)||
      /^메시지 작성기$|^메시징$|^보내기$/.test(ml)||
      /^존함을 말씀|^필요시 추가확인|^사진 또는 자료/.test(ml)||
      /^상담 중인 날짜|^감사합니다|^오늘도 안전/.test(ml)||
      /^\d{4}-\d{2}-\d{2}$|^\d{2}-\d{2}$/.test(ml)||
      /^오류 제보|^유선 상담 중 자료|^계약 및 해지|^기타$/.test(ml)||
      /^\d{10,11}$/.test(ml)||
      /^\d{3,4}-\d{3,4}-\d{4}$/.test(ml)
      );
      
      const blocks=[];
      let i=scanFrom;
      while(i<allLines.length){
      const l=allLines[i].trim();
      if(/^Web User [a-f0-9]/.test(l)){
      let j=i+1;
      const msgLines=[];
      let skipName=false; // '존함을 말씀' 폼 직후 이름 답변 1회 제외
      while(j<allLines.length){
      const ml=allLines[j].trim();
      if(ml==='드라이버 상담사'||/^TADA /.test(ml)||/^Web User [a-f0-9]/.test(ml)) break;
      if(ml==='메시지 작성기') break;
      if(/^존함을 말씀/.test(ml)){ skipName=true; j++; continue; }
      if(skipName && ml && !isNoise(ml)){
      if(/^[가-힣]{2,5}$/.test(ml)){ skipName=false; j++; continue; }
      skipName=false;
      }
      if(!isNoise(ml)) msgLines.push(ml);
      j++;
      }
      if(msgLines.length>0) blocks.push(msgLines.join('\n'));
      i=j;
      }else{
      i++;
      }
      }
      if(blocks.length>0){
      customerMsgs=blocks.map(b=>b.trim()).filter(b=>b.length>0);
      customerMsg=customerMsgs.length>0?customerMsgs[customerMsgs.length-1]:'';
      }
      }
      
      if(!customerMsg){
      const bubbleSelectors=[
      '[data-test-id*="message"][class*="end"]',
      '[class*="message-bubble"]',
      '[class*="chat-bubble"]',
      ];
      const _scope=convEl||document;
      for(const sel of bubbleSelectors){
      const bubbles=_scope.querySelectorAll(sel);
      if(bubbles.length>0){
      const texts=[...bubbles].map(b=>b.innerText?.trim()).filter(Boolean);
      if(texts.length>0){customerMsg=texts[texts.length-1];break;}
      }
      }
      }
      
      if(!customerMsg&&convEl){
      const fullT=convEl.innerText||'';
      const webUserBlocks=fullT.split(/Web User [a-f0-9]+\n•\n/);
      if(webUserBlocks.length>1){
      const lastBlock=webUserBlocks[webUserBlocks.length-1];
      const msgLines=lastBlock.split('\n');
      const msgContent=[];
      for(const line of msgLines){
      if(/^오늘 \d|^어제 \d|^드라이버|^TADA|^사진 또는|^상담 중인|^감사합니다|^오늘도/.test(line.trim())) break;
      const l=line.trim();
      if(!l||/^\d{1,2}:\d{2}$/.test(l)) continue;
      if(l==='기타'||l==='오류 제보 하기'||l==='대화'||/님과의 대화$/.test(l)) continue;
      if(/^메시징을 통해$|^웹 양식을 통해$|^이메일을 통해$|^전화를 통해$|^티켓 요약 보기$|^대화 로그$/.test(l)) continue;
      msgContent.push(l);
      }
      const _m=msgContent.join('\n').trim();
      if(_m.length>0) customerMsg=_m;
      }
      }
      
      if(!customerMsg && !isMessaging){
      const comments=scopedComments;
      for(let i=0;i<comments.length;i++){
      const _box=comments[i].closest('article, li, [data-comment-id], [class*="event"]')||comments[i].parentElement;
      const _boxTxt=_box?_box.innerText:'';
      const _author=(_boxTxt.split('\n').map(x=>x.trim()).filter(Boolean)[0])||'';
      if(/^TADA\b/.test(_author)||/(^|\n)\s*내부\s*(\n|$)/.test(_boxTxt)) continue;
      const tmp=document.createElement('div');
      tmp.innerHTML=comments[i].innerHTML;
      let rawTxt=tmp.innerText||tmp.textContent||'';
      if(/전화구분\s*[:：]|통화시간\s*[:：]|발신내선\s*[:：]|수신번호\s*[:：]/.test(rawTxt)){continue;}
      const origMailIdx=rawTxt.search(/-{2,}\s*원본 메일|원본 메일\s*-{2,}|-{3,}\s*Original/);
      if(origMailIdx>=0) rawTxt=rawTxt.slice(0,origMailIdx);
      if(bodyLimit>=0){
      const commentPosInBody=bodyText.indexOf(rawTxt.slice(0,20).trim());
      if(commentPosInBody>=0&&commentPosInBody>bodyLimit) continue;
      }
              if(/타다 팀 드림|타다를 이용해 주셔서|이용 경험 평가하기|안녕하세요\.\s*[가-힣]+님\s*타다/.test(rawTxt)){
              // 타다 발신(아웃바운드) 자동안내 코멘트는 제외.
              // 단, 고객이 안내문을 "인용"하고 그 뒤에 실제 문의(예: 발송경위 확인)를 덧붙인 경우는 살린다.
              const OUT_SIG=[/타다 팀 드림/,/타다를 이용해 주셔서/,/이용 경험 평가하기/,/안녕하세요\.\s*[가-힣]+님\s*타다/];
              let sigEnd=-1;
              for(const re of OUT_SIG){ const m=rawTxt.match(re); if(m){ const e=rawTxt.lastIndexOf(m[0])+m[0].length; if(e>sigEnd) sigEnd=e; } }
              if(sigEnd>=0){
                const after=rawTxt.slice(sigEnd)
                  .split('\n').map(s=>s.trim())
                  .filter(s=>s && !/^[·•\-]$/.test(s) && !/^\d{1,2}:\d{2}$/.test(s)
                    && !/^타다를 이용해 주셔서|^이용 경험 평가하기|^타다 팀 드림/.test(s))
                  .join(' ').trim();
                if(after.length<2){ continue; } // 시그니처 뒤 실질 발화 없음 → 순수 아웃바운드 제외
                // 인용+문의 코멘트: 노이즈만 제거하고 인용 본문·문단 빈 줄은 보존하여 그대로 적재
                const quoted=rawTxt.split('\n').filter(l=>{ const t=l.trim();
                  if(/^https?:\/\//.test(t)) return false;
                  if(/^\d{1,2}:\d{2}$/.test(t)) return false;
                  if(/\.(png|jpg|jpeg|gif|pdf)$/i.test(t)) return false;
                  if(/^수신자:$|^자세히 보기$|^원본 메일|^-{3,}/.test(t)) return false;
                  if(/^메시지 작성기$|^메시징$|^보내기$|^사진 또는 자료|^상담 중인 날짜/.test(t)) return false;
                  return true;
                }).join('\n').replace(/[ \t]+$/gm,'').replace(/\n{3,}/g,'\n\n').trim();
                if(quoted.length>0) customerMsgs.push(quoted);
      continue;
      }
      }
      const cutIdx=rawTxt.indexOf('메시지 작성기');
      const txt=cutIdx>=0?rawTxt.slice(0,cutIdx):rawTxt;
      const lines=txt.split('\n').map(l=>l.trim()).filter(l=>{
      if(!l) return false;
      if(/^https?:\/\//.test(l)) return false;
      if(/^\d{4}\.\d{2}\.\d{2}( \d{1,2}:\d{2}(:\d{2})?)?$/.test(l)) return false;
      if(/^(오늘|어제|그제) \d{1,2}:\d{2}$/.test(l)) return false;
      if(/^\d+분 전$/.test(l)||/^\d+시간 전$/.test(l)) return false;
      if(/^\d{1,2}:\d{2}$/.test(l)) return false;
      if(/\.(png|jpg|jpeg|gif|pdf)$/i.test(l)) return false;
      if(l==='·'||l==='•'||l==='-') return false;
      if(/^수신자:$|^자세히 보기$|^원본 메일|^-{3,}/.test(l)) return false;
      if(/^메시지 작성기$|^메시징$|^보내기$|^사진 또는 자료|^상담 중인 날짜/.test(l)) return false;
      if(l==='대화'||/님과의 대화$/.test(l)||/^메시징을 통해$|^웹 양식을 통해$|^이메일을 통해$|^전화를 통해$|^티켓 요약 보기$|^대화 로그$/.test(l)) return false;
      if(l==='기타'||l==='오류 제보 하기'||/^타다에 전달 하고 싶은/.test(l)||/^이외 문의를 남겨주시면/.test(l)) return false;
      return true;
      });
      if(lines.length>0){
      const msg=lines.join('\n').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
      if(msg.length>0) customerMsgs.push(msg);
      }
      }
      if(customerMsgs.length>0) customerMsg=customerMsgs[0];
      }
      
      // 비메시징(이메일/일반) 티켓: 첫 문의가 제목에만 담긴 경우 대비해 제목을 후보로 추가
      // (단, 제목이 본문 발화와 사실상 같으면 추가하지 않음 → 중복 칩 방지)
      if(!isMessaging){
      try{
      const subj=getTicketSubject(); // cleanSubj가 라벨·사이트접미·말줄임까지 정리
      if(subj){
      const key=s=>s.replace(/[^0-9a-z가-힣]/gi,'').toLowerCase(); // 비교용 핵심 키
      const sk=key(subj);
      const dup = sk.length<6 || customerMsgs.some(b=>{
      const bk=key(b);
      if(bk.length<6) return false;
      if(bk.includes(sk)||sk.includes(bk)||bk.startsWith(sk)||sk.startsWith(bk)) return true;
      // 잘린 제목 대응: 공통 앞부분이 12자 이상이면 같은 글로 간주
      let n=0; while(n<sk.length&&n<bk.length&&sk[n]===bk[n]) n++;
      return n>=12;
      });
      if(!dup) customerMsgs.unshift(subj);
      }
      }catch(e){}
      if(customerMsgs.length>0 && !customerMsg) customerMsg=customerMsgs[0];
      }
      
      // ── 인입 최종 중복 제거: 제목/본문 등 사실상 같은 내용은 하나로 합침 (칩 중복 방지) ──
      if(customerMsgs && customerMsgs.length>1){
      const nk=s=>(s||'').replace(/[^0-9a-z가-힣]/gi,'').toLowerCase();
      const out=[];
      for(const b of customerMsgs){
      const bk=nk(b); if(!bk) continue;
      const di=out.findIndex(o=>{const ok=nk(o);
      if(ok===bk) return true;                                              // 완전 동일
      if(ok.length>=6&&bk.length>=6&&(ok.includes(bk)||bk.includes(ok))) return true; // 한쪽이 다른 쪽을 포함
      return false;});
      if(di>=0){ if(b.length>out[di].length) out[di]=b; } // 더 긴(정보 많은) 쪽 유지
      else out.push(b);
      }
      if(out.length>0){
      customerMsgs=out;
      if(!customerMsg||/^\(/.test(customerMsg)||!customerMsgs.includes(customerMsg)) customerMsg=customerMsgs[customerMsgs.length-1];
      }
      }
      
      if(!customerMsg) customerMsg='(내용을 직접 입력해주세요)';
      }catch(e){customerMsg='(내용 파싱 실패 - 직접 입력해주세요)';}
      return (customerMsgs && customerMsgs.length) ? customerMsgs
        : ((customerMsg && !/^\(/.test(customerMsg)) ? [customerMsg] : []);
    }
    function getDraftText() {
      const sels = ['[data-test-id="omni-log-editor"]', '.ProseMirror', '.zendesk-editor--rich-text-comment', '[contenteditable="true"]', 'textarea'];
      let best = '';
      sels.forEach(s => document.querySelectorAll(s).forEach(e => {
        if (e.closest('#hb_zd_panel')) return;
        const r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return;
        const t = (e.innerText || e.value || '').trim(); if (t.length > best.length) best = t;
      }));
      return best;
    }

    /* ── 멘트 스코어링 (원본 scoreMent 동일: key +3, trig +1) ── */
    const norm = s => (s || '').toLowerCase();
    function scoreMent(m, txt) {
      let s = 0;
      (m.key || []).forEach(k => { if (txt.includes(norm(k))) s += 3; });
      (m.trig || []).forEach(k => { if (txt.includes(norm(k))) s += 1; });
      return s;
    }

    /* ── ID 대조 (젠데스크 페이지 ↔ 봉투) ── */
    function collectZdIds(snap) {
      const t = snap || ''; const u = [], d = []; let m;
      const reD = /admin\.tadatada\.(?:com|in)\/drivers\/([A-Za-z0-9]+)/g;
      while ((m = reD.exec(t))) d.push(m[1]);
      const reU = /admin\.tadatada\.(?:com|in)\/users\/([A-Za-z0-9]+)/g;
      while ((m = reU.exec(t))) u.push(m[1]);
      // 외부 ID: 라벨과 값 사이 줄바꿈·잡텍스트 허용([\s\S]{0,40}?) — 기존 [\s:：]* 는 실제 DOM innerText에서 매칭 실패 (티켓뷰 zendesk.html 방식 이식)
      const reE = /외부\s*(?:ID|아이디)[\s\S]{0,40}?([A-Za-z0-9:_-]{6,40})/g;
      while ((m = reE.exec(t))) {
        const id = m[1];
        const wu = id.match(/^webuser[:_-]?([A-Za-z0-9]*)$/i);            // webuser… → 웹 이용자
        if (wu) { u.push(/^U[A-Za-z0-9]{5,}$/i.test(wu[1] || '') ? wu[1] : id); continue; } // webuser:U123… 이면 내장 U-ID로, 아니면 토큰 통째로
        if (/^U[A-Za-z0-9]{6,}$/i.test(id)) u.push(id);
        else if (/^D/i.test(id) && /\d/.test(id)) d.push(id);              // DNX1234 등 — D 접두 + 숫자 포함
      }
      const uniq = a => a.filter((v, i) => v && a.indexOf(v) === i);
      return { user: uniq(u), driver: uniq(d) };
    }
    /* ── 파트너/이용자 자동 판별 — 티켓뷰(zendesk.html) detectPartyAuto 이식 ──
     * 요청자 외부 ID 접두로 확정: D…(DNX…)→파트너 / webuser…·U… 등 그 외→이용자.
     * 외부 ID를 못 찾은 경우에만 드라이버 어드민 링크(정확한 href)로 보조 판별. */
    function detectParty(snap) {
      try {
        const blob = snap || document.body.innerText || '';
        const m = blob.match(/외부\s*(?:ID|아이디)[\s\S]{0,40}?([A-Za-z0-9:_-]{6,})/);
        if (m) {
          const extId = m[1];
          if (/^webuser/i.test(extId)) return '이용자';        // 웹 이용자 — D 검사보다 먼저
          return /^D/i.test(extId) ? '파트너' : '이용자';
        }
        // Web User <해시> — 메시징 웹 채널 인입(외부 ID 없음): 사이드바 '조회한 페이지'로 어느 센터에서 왔는지 판별
        // 예) '조회한 페이지 … 타다 드라이버 센터' → 파트너. 메모에 붙은 어드민 링크보다 요청자 자체 신호라 우선.
        if (/Web\s*User\s+[0-9a-f]{12,}/i.test(blob)) {
          const i = blob.indexOf('조회한 페이지');
          const seg = i >= 0 ? blob.slice(i, i + 200) : '';
          if (/드라이버/.test(seg)) return '파트너';
          if (seg) return '이용자';
        }
        if ([...document.querySelectorAll('a[href]')].some(a => /admin\.tadatada\.(?:com|in)\/drivers\//i.test(a.getAttribute('href') || ''))) return '파트너';
      } catch (e) {}
      return '이용자';
    }
    function idStatus(mine, zd) {
      if (!mine && !zd.length) return 'none';
      if (!mine) return 'nomine';
      if (!zd.length) return 'nozd';
      return zd.indexOf(mine) >= 0 ? 'ok' : 'bad';
    }

    function fresh(ts) {
      if (!ts) return '';
      const m = Math.round((Date.now() - ts) / 60000);
      return m < 1 ? '방금' : m + '분 전';
    }

    /* ═══ 패널 빌드 ═══ */
    onReady(() => {
      const TN = (location.href.match(/tickets\/(\d+)/) || [])[1] || '';
      const ticketUrl = 'https://tadatadahelp.zendesk.com/agent/tickets/' + TN;
      const pageSnap = (() => { try { return document.body.innerText || ''; } catch (e) { return ''; } })();

      const panel = el('div',
        'position:fixed;top:16px;right:16px;width:360px;max-height:92vh;overflow-y:auto;z-index:999999;background:#fff;border:1px solid #e6eae8;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);font-family:-apple-system,sans-serif;color:#243027;display:none;color-scheme:light;');
      panel.id = 'hb_zd_panel';
      panel.innerHTML = `
        <style>
          #hb_zd_panel *{box-sizing:border-box;}
          #hb_zd_panel .h{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #e6eae8;position:sticky;top:0;background:#fff;border-radius:12px 12px 0 0;z-index:2;}
          #hb_zd_panel .h b{font-size:14px;} #hb_zd_panel .tn{font-size:11px;font-weight:bold;color:#0a5d54;background:#e6f7f4;border:1px solid #bfe6de;padding:1px 7px;border-radius:20px;}
          #hb_zd_panel .x{margin-left:auto;border:none;background:#f1f3f5;border-radius:6px;width:24px;height:24px;cursor:pointer;color:#7b857f;}
          #hb_zd_panel .body{padding:12px 14px;}
          #hb_zd_panel .card{border:1px solid #bfe6de;background:#f4fbfa;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:11px;}
          #hb_zd_panel .card.none{border-color:#e3e6e8;background:#f6f7f8;}
          #hb_zd_panel .card.warn{border-color:#e8b4ad;background:#fdf5f4;}
          #hb_zd_panel .chead{display:flex;align-items:center;gap:6px;font-weight:bold;color:#0a5d54;}
          #hb_zd_panel .badge{font-size:9.5px;padding:1px 6px;border-radius:20px;color:#fff;}
          #hb_zd_panel .grid{display:grid;grid-template-columns:52px 1fr;gap:1px 8px;margin-top:6px;line-height:1.5;color:#243027;}
          #hb_zd_panel .grid .k{color:#7b857f;} #hb_zd_panel .grid .miss{color:#c0c7c4;} #hb_zd_panel .grid .bad{color:#c0392b;font-weight:bold;} #hb_zd_panel .grid .good{color:#0a7d72;}
          #hb_zd_panel textarea,#hb_zd_panel input.s{width:100%;border:1px solid #e6eae8;border-radius:8px;font-family:inherit;color:#243027;background:#fff;caret-color:#243027;padding:8px;font-size:12.5px;line-height:1.6;}
          #hb_zd_panel textarea::placeholder,#hb_zd_panel input.s::placeholder{color:#9aa39e;opacity:1;}
          #hb_zd_panel textarea:focus,#hb_zd_panel input.s:focus{outline:none;border-color:#0a7d72;box-shadow:0 0 0 3px #e6f7f4;}
          #hb_zd_panel .lbl{font-size:11px;color:#7b857f;margin:8px 0 5px;}
          #hb_zd_panel .btn{background:#0a7d72;color:#fff;border:none;border-radius:8px;padding:9px;font-size:13px;font-weight:bold;cursor:pointer;width:100%;}
          #hb_zd_panel .btn:hover{background:#0a5d54;}
          #hb_zd_panel .ghost{background:#fff;border:1px solid #e6eae8;color:#7b857f;border-radius:8px;padding:7px 12px;font-size:12px;font-weight:bold;cursor:pointer;}
          #hb_zd_panel .seg{display:flex;background:#fbfdfc;border:1px solid #e6eae8;border-radius:8px;padding:2px;gap:2px;}
          #hb_zd_panel .seg button{border:none;background:transparent;font-size:11px;font-weight:bold;color:#7b857f;padding:3px 11px;border-radius:6px;cursor:pointer;}
          #hb_zd_panel .seg button.on{background:#0a7d72;color:#fff;}
          #hb_zd_panel .pick{font-size:11px;padding:5px 10px;border-radius:20px;border:1px solid #e6eae8;background:#fff;color:#243027;cursor:pointer;text-align:left;max-width:100%;}
          #hb_zd_panel .pick.on{background:#0a7d72;border-color:#0a7d72;color:#fff;font-weight:bold;}
          #hb_zd_panel .chip{padding:4px 10px;border-radius:20px;font-size:11px;border:1px solid #cfd6d4;background:#fff;color:#555;cursor:pointer;}
          #hb_zd_panel .chip.rec{border-color:#bfe6de;background:#e6f7f4;color:#0a5d54;font-weight:bold;}
          #hb_zd_panel .div{height:1px;background:#e6eae8;margin:12px 0;}
          #hb_zd_panel .row{display:flex;align-items:center;gap:6px;}
          #hb_zd_panel .sel{flex:1;padding:5px 8px;border:1px solid #bfe6de;border-radius:6px;font-size:11.5px;background:#fff;color:#243027;cursor:pointer;}
          #hb_zd_panel .sel option{background:#fff;color:#243027;}
          #hb_zd_panel .opt{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#0a5d54;cursor:pointer;margin:6px 0;}
          #hb_zd_panel input[type=checkbox]{accent-color:#0a7d72;width:13px;height:13px;cursor:pointer;}
        </style>
        <div class="h"><span>🎫</span><b>티켓 뷰</b><span class="tn">#${TN}</span><button class="x" id="hb_x">✕</button></div>
        <div class="body">
          <div id="hb_card"></div>
          <div class="row" style="justify-content:space-between;">
            <strong style="font-size:12px;color:#0a5d54;">📋 슬랙 적재</strong>
            <div class="seg"><button id="hb_user" class="on">이용자</button><button id="hb_partner">파트너</button></div>
          </div>
          <div id="hb_pick_wrap" style="display:none;margin-top:8px;"><div class="lbl">인입 선택 · 복수 가능</div><div id="hb_pick" style="display:flex;flex-wrap:wrap;gap:6px;"></div></div>
          <textarea id="hb_content" rows="6" style="margin-top:8px;"></textarea>
          <button id="hb_slack" class="btn" style="margin-top:8px;">티켓 적재 복사</button>
          <div class="div"></div>
          <div class="row"><strong style="font-size:12px;color:#0a5d54;">💬 추천 멘트</strong><span id="hb_mc" class="badge" style="background:#0a7d72;"></span><button id="hb_refresh" class="ghost" style="margin-left:auto;padding:3px 9px;font-size:10.5px;">🔄 다시 읽기</button></div>
          <input id="hb_filter" class="s" type="text" placeholder="멘트 검색 (예: 요금, 바우처, 배차)" style="margin:8px 0;">
          <div id="hb_status" style="font-size:10px;color:#8a8f92;margin-bottom:6px;"></div>
          <div id="hb_chips" style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;"></div>
          <div id="hb_variant" style="display:none;margin-bottom:8px;"></div>
          <label id="hb_optwrap" class="opt" style="display:none;"><input type="checkbox" id="hb_opt"> <span id="hb_optlabel">선택 문구 포함</span></label>
          <div id="hb_addon" style="display:none;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:6px;"></div>
          <textarea id="hb_preview" rows="6" placeholder="멘트 칩을 누르면 여기에 누적됩니다. 자유롭게 수정 후 복사하세요." style="margin-bottom:8px;"></textarea>
          <div class="row"><button id="hb_copy" class="btn" style="flex:1;">📋 복사하기</button><button id="hb_clear2" class="ghost">비우기</button></div>
        </div>`;
      document.body.appendChild(panel);

      const btn = el('button', 'position:fixed;right:18px;bottom:18px;z-index:999999;width:44px;height:44px;border-radius:50%;border:none;background:#0a7d72;color:#fff;font-size:19px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;', '🎫');
      btn.title = '허니베어 패널 (Alt+H · 드래그로 이동)';
      document.body.appendChild(btn);

      const g = id => panel.querySelector('#' + id);
      let ZDIDS = collectZdIds(pageSnap);

      /* 케이스 카드 렌더 + ID 대조 */
      function renderCard() {
        const c = HBStore.loadCase();
        const has = !!(c && c.ts);
        const stale = has && (Date.now() - c.ts > 30 * 60 * 1000);
        const uSt = idStatus(c.ids.user, ZDIDS.user), dSt = idStatus(c.ids.driver, ZDIDS.driver);
        const mism = uSt === 'bad' || dSt === 'bad';
        const idCell = (mine, st, zd) => {
          if (!mine) return { v: zd.length ? ('— (젠데스크 ' + zd.join(', ') + ')') : '—', cls: zd.length ? 'bad' : 'miss' };
          if (st === 'ok') return { v: mine + ' ✅', cls: 'good' };
          if (st === 'bad') return { v: mine + ' ⚠️젠데스크 ' + zd.join(', '), cls: 'bad' };
          return { v: mine, cls: '' };
        };
        const ur = idCell(c.ids.user, uSt, ZDIDS.user), dr = idCell(c.ids.driver, dSt, ZDIDS.driver);
        const flags = [];
        if (c.flags.isCash) flags.push('현장결제');
        if (c.flags.isPlus) flags.push('플러스');
        if (c.flags.thirdParty) flags.push(c.flags.thirdParty);
        const rows = !has ? '' : [
          ['구분', c.trip.timeSrc === 'resv' || c.flags.isFromResv ? '예약' : '실시간', ''],
          ['일시', c.trip.dateTime, ''], ['출발', c.trip.departure, ''], ['도착', c.trip.destination, ''],
          ['이름', c.trip.name, ''], ['총요금', won(c.fare.total), ''], ['예상요금', won(c.fare.est), ''],
          ['탄력', c.fare.surge ? c.fare.surge + '%' : '', ''], ['취소료', won(c.fare.cancel), ''],
          ['영손비', won(c.fare.loss), ''],
          ['라이드', c.ids.ride, ''], ['예약', c.ids.resv, ''],
          ['유저', ur.v, ur.cls], ['파트너', dr.v, dr.cls]
        ].concat(flags.length ? [['기타', flags.join(' · '), '']] : [])
          .map(r => `<div class="k">${r[0]}</div><div class="${r[2] || (r[1] ? '' : 'miss')}">${r[1] || '—'}</div>`).join('');
        const badgeBg = !has ? '#c3c9c6' : mism ? '#c0392b' : stale ? '#d97706' : '#0a7d72';
        const badgeTx = !has ? '데이터 없음' : mism ? 'ID 불일치' : (fresh(c.ts) + (stale ? '·오래됨' : ''));
        const cardEl = g('hb_card');
        cardEl.className = 'card' + (!has ? ' none' : mism ? ' warn' : '');
        cardEl.innerHTML = `<div class="chead">🍯 케이스 <span class="badge" style="background:${badgeBg};">${badgeTx}</span>
          <button id="hb_clear" class="ghost" style="margin-left:auto;padding:1px 8px;font-size:10px;">비우기</button></div>
          ${has ? `<div class="grid">${rows}</div>` : ''}`;
        const cb = g('hb_clear'); if (cb) cb.onclick = () => { HBStore.clearCase(); renderCard(); renderMents(); };
      }

      /* 인입 선택 칩 */
      const contentBox = g('hb_content');
      let blocks = parseInboundOriginal();
      const sel = new Set();
      if (blocks.length) sel.add(blocks.length - 1);
      function rebuild() { contentBox.value = blocks.filter((b, i) => sel.has(i)).join('\n\n'); }
      function renderPick() {
        const pw = g('hb_pick'); pw.innerHTML = '';
        blocks.forEach((b, i) => {
          const one = b.replace(/\n/g, ' '); const short = one.slice(0, 18) + (one.length > 18 ? '…' : '');
          const c = el('button', null, (sel.has(i) ? '✓ ' : '') + (i + 1) + '. ' + short);
          c.className = 'pick' + (sel.has(i) ? ' on' : ''); c.title = b;
          c.onclick = () => { sel.has(i) ? sel.delete(i) : sel.add(i); rebuild(); renderPick(); };
          pw.appendChild(c);
        });
      }
      if (blocks.length) { g('hb_pick_wrap').style.display = 'block'; renderPick(); rebuild(); }

      /* 슬랙 적재 */
      let party = '이용자';
      const bu = g('hb_user'), bp = g('hb_partner');
      function setParty(p) {
        party = p;
        (p === '파트너' ? bp : bu).classList.add('on');
        (p === '파트너' ? bu : bp).classList.remove('on');
      }
      bu.onclick = () => setParty('이용자');
      bp.onclick = () => setParty('파트너');
      // 자동판별: 외부 ID 접두 우선 (D→파트너 / webuser·U 등→이용자), 없으면 드라이버 링크 보조 — 티켓뷰와 동일
      setParty(detectParty(pageSnap));
      g('hb_slack').onclick = function () {
        const content = contentBox.value.trim();
        const esc = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const _tn = (location.href.match(/tickets\/(\d+)/) || [])[1] || TN;   // 현재 티켓 (SPA 전환 대응)
        const _turl = 'https://tadatadahelp.zendesk.com/agent/tickets/' + _tn;
        const html = `<a href="${_turl}">#${_tn}</a> ${party} 인입<br><pre style="background:#f3f4f6;padding:8px;border-radius:4px;font-size:12px;white-space:pre-wrap;">${esc}</pre>`;
        const plain = `<${_turl}|#${_tn}> ${party} 인입\n\`\`\`\n${content}\n\`\`\``;
        copyRich(html, plain);
        toast('🎫 적재 복사 완료');
        const t = this.textContent; this.textContent = '✅ 적재 복사 완료'; setTimeout(() => this.textContent = t, 1500);
      };

      /* 추천 멘트 */
      const previewEl = g('hb_preview'), chipsBox = g('hb_chips'), statusEl = g('hb_status'),
        filterEl = g('hb_filter'), optBox = g('hb_opt'), optwrap = g('hb_optwrap'),
        variantBox = g('hb_variant'), addonBox = g('hb_addon');
      let MENTS = [], draftText = getDraftText(), lastMent = null, lastSeg = '';

      function signalText() {
        const inq = blocks.length ? blocks.join('\n') : '';
        return norm(inq + '\n' + (draftText || ''));
      }
      function addMent(m, textOverride) {
        const raw = textOverride != null ? textOverride : m.text;
        const seg = fillTokens(processBrackets(raw, optBox.checked), HBStore.loadCase());
        const cur = previewEl.value;
        previewEl.value = cur.trim() ? (cur.replace(/\s+$/, '') + '\n\n' + seg) : seg;
        lastMent = { text: raw }; lastSeg = seg;
        if (hasOptionalBracket(raw)) { optwrap.style.display = 'flex'; g('hb_optlabel').textContent = optionalBracketName(raw) + ' 포함'; }
        else { optwrap.style.display = 'none'; optBox.checked = false; }
        if (m && m.addons && m.addons.length) {
          addonBox.innerHTML = ''; const lb = el('span', 'font-size:11px;color:#0a5d54;font-weight:bold;', '날씨 인사말:'); addonBox.appendChild(lb);
          m.addons.forEach(ad => {
            const l = el('label', 'display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:#0a5d54;border:1px solid #bfe6de;border-radius:20px;padding:3px 9px;cursor:pointer;');
            const cb = el('input'); cb.type = 'checkbox'; const sp = el('span', null, ad.label); l.append(cb, sp);
            cb.onchange = () => { const line = fillTokens(ad.text, HBStore.loadCase()).trim(); let v = previewEl.value; const idx = v.indexOf(line); if (idx >= 0) v = v.slice(0, idx) + v.slice(idx + line.length); if (cb.checked) v = v.replace(/\s+$/, '') + '\n\n' + line; previewEl.value = v.replace(/\n{3,}/g, '\n\n').trim(); };
            addonBox.appendChild(l);
          });
          addonBox.style.display = 'flex';
        } else { addonBox.style.display = 'none'; addonBox.innerHTML = ''; }
        previewEl.focus(); previewEl.scrollTop = previewEl.scrollHeight;
      }
      function showVariants(m) {
        variantBox.innerHTML = '';
        const wrap = el('div', 'display:flex;align-items:center;gap:6px;');
        wrap.appendChild(el('span', 'font-size:11px;color:#0a5d54;font-weight:bold;white-space:nowrap;', m.label + ' →'));
        const s = el('select'); s.className = 'sel';
        s.appendChild(new Option('경우 선택…', ''));
        m.variants.forEach((v, i) => s.appendChild(new Option(v.label, String(i))));
        s.onchange = () => { if (s.value === '') return; addMent(m, m.variants[+s.value].text); variantBox.style.display = 'none'; };
        wrap.appendChild(s); variantBox.appendChild(wrap); variantBox.style.display = 'block'; s.focus();
      }
      function renderMents() {
        const txt = signalText(); const q = norm(filterEl.value); const hasSig = txt.trim().length > 0;
        let scored = MENTS.map((m, idx) => ({ m, idx, score: scoreMent(m, txt) }));
        if (q) scored = scored.filter(x => norm(x.m.label).includes(q) || norm(x.m.id).includes(q));
        const matched = scored.filter(x => x.score > 0).sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
        const rest = scored.filter(x => x.score === 0).sort((a, b) => a.idx - b.idx);
        const ordered = hasSig ? matched.concat(rest) : scored;
        statusEl.textContent = q ? ('"' + filterEl.value + '" 검색 ' + scored.length + '건')
          : (hasSig ? (matched.length ? '문의·작성 글 기준 추천 (★=관련도 높음)' : '단서 없음 — 전체 표시') : '문의 기준 정렬. 작성 후 🔄로 갱신');
        chipsBox.innerHTML = ''; variantBox.style.display = 'none';
        ordered.forEach(({ m, score }) => {
          const hot = score > 0;
          const b = el('button', null, (hot ? '★ ' : '') + m.label + (m.variants ? ' ▾' : ''));
          b.className = 'chip' + (hot ? ' rec' : '');
          b.title = m.variants ? ('경우: ' + m.variants.map(v => v.label).join(' / ')) : fillTokens(m.text, HBStore.loadCase());
          b.onclick = m.variants ? (() => showVariants(m)) : (() => addMent(m));
          chipsBox.appendChild(b);
        });
      }
      filterEl.oninput = renderMents;
      g('hb_refresh').onclick = () => { draftText = getDraftText(); blocks = parseInboundOriginal(); renderMents(); };
      optBox.onchange = () => {
        if (lastMent && hasOptionalBracket(lastMent.text) && previewEl.value.endsWith(lastSeg)) {
          const seg2 = fillTokens(processBrackets(lastMent.text, optBox.checked), HBStore.loadCase());
          previewEl.value = previewEl.value.slice(0, previewEl.value.length - lastSeg.length) + seg2; lastSeg = seg2;
        }
      };
      g('hb_copy').onclick = function () { copyText(previewEl.value); toast('📋 복사 완료'); const t = this.textContent; this.textContent = '✅ 복사됨'; setTimeout(() => this.textContent = t, 1200); };
      g('hb_clear2').onclick = () => { previewEl.value = ''; lastMent = null; lastSeg = ''; optwrap.style.display = 'none'; optBox.checked = false; addonBox.style.display = 'none'; };

      loadMents(arr => { MENTS = arr; g('hb_mc').textContent = arr.length; renderMents(); });


      /* 열고 닫기 + 실시간 동기화 + 티켓 전환 감지 */
      let curTN = TN;
      // 젠데스크는 SPA — 티켓 탭을 바꿔도 새로고침되지 않으므로 인입을 다시 읽어야 한다.
      function refreshForTicket() {
        const nowTN = (location.href.match(/tickets\/(\d+)/) || [])[1] || '';
        if (!nowTN) return;
        const changed = nowTN !== curTN;
        if (changed) {
          curTN = nowTN;
          const tn = panel.querySelector('.tn'); if (tn) tn.textContent = '#' + nowTN;
          // 티켓이 바뀌면 외부 ID·어드민 링크를 다시 읽어 대조/파트너 판별 갱신 (같은 티켓 내 수동 토글은 보존)
          ZDIDS = collectZdIds(document.body.innerText || '');
          setParty(detectParty(''));
          renderCard();
        }
        // 인입 재파싱 (티켓이 바뀌었거나 패널을 새로 열 때)
        blocks = parseInboundOriginal();
        sel.clear(); if (blocks.length) sel.add(blocks.length - 1);
        if (blocks.length) { g('hb_pick_wrap').style.display = 'block'; renderPick(); rebuild(); }
        else { g('hb_pick_wrap').style.display = 'none'; contentBox.value = ''; }
        draftText = getDraftText();
        renderMents();
      }
      function toggle() {
        const open = panel.style.display === 'none';
        panel.style.display = open ? 'block' : 'none';
        if (open) { renderCard(); refreshForTicket(); }
      }
      /* FAB 드래그 이동 — admin 🍯 버튼과 동일 패턴 (3px 이상 움직였으면 클릭으로 치지 않음) */
      (function () {
        let fdx = 0, fdy = 0, fsx = 0, fsy = 0, fMoved = false, fDrag = false;
        btn.addEventListener('mousedown', e => {
          fDrag = true; fMoved = false;
          const r = btn.getBoundingClientRect();
          btn.style.right = 'auto'; btn.style.bottom = 'auto';
          btn.style.left = r.left + 'px'; btn.style.top = r.top + 'px';
          fsx = e.clientX; fsy = e.clientY; fdx = r.left; fdy = r.top;
          e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
          if (!fDrag) return;
          if (Math.abs(e.clientX - fsx) > 3 || Math.abs(e.clientY - fsy) > 3) fMoved = true;
          btn.style.left = Math.max(0, fdx + e.clientX - fsx) + 'px';
          btn.style.top = Math.max(0, fdy + e.clientY - fsy) + 'px';
        });
        document.addEventListener('mouseup', () => { if (fDrag && !fMoved) toggle(); fDrag = false; });
      })();
      g('hb_x').onclick = () => panel.style.display = 'none';
      document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyH') toggle(); if (e.key === 'Escape' && panel.style.display !== 'none') panel.style.display = 'none'; });
      // 패널이 열려있는 동안 티켓 전환 감시 (SPA 대응)
      setInterval(() => {
        if (panel.style.display === 'none') return;
        const nowTN = (location.href.match(/tickets\/(\d+)/) || [])[1] || '';
        if (nowTN && nowTN !== curTN) refreshForTicket();
      }, 1200);
      g('hb_refresh').onclick = () => refreshForTicket();
      HBStore.onChange(c => { renderCard(); renderMents(); if (panel.style.display === 'none') toast('🍯 새 케이스 수신'); });
      renderCard();

      /* 패널 드래그 이동 (헤더 잡고) */
      (function () {
        const head = panel.querySelector('.h');
        if (!head) return;
        head.style.cursor = 'move';
        let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        head.addEventListener('mousedown', e => {
          if (e.target.id === 'hb_x') return;
          dragging = true;
          const r = panel.getBoundingClientRect();
          panel.style.right = 'auto'; panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
          sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
          e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
          if (!dragging) return;
          panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
          panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
      })();
    });
  }

    /* ══ 꿀통 양식 (원본 honey.html 팝업부 그대로 + 봉투 어댑터) ══
     * 원본의 DOM 수집부(1~424줄)는 버리고, 팝업 출력부만 사용.
     * 봉투(hb_case)를 원본이 읽던 tada_* 키로 펼친 뒤 원본 팝업 실행. */
    function hbSpreadCaseToTada(c) {
      // 봉투 → tada_* localStorage (원본 꿀통/꿀빠는곰이 읽는 형태)
      const S = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
      const IS_RESV = c.trip.timeSrc === 'resv' || c.flags.isFromResv || c.trip.actionWord === '탑승';
      // msg_data (원본 핵심 객체)
      const md = {
        name: c.trip.name || '', dateTime: c.trip.dateTime || '',
        departure: c.trip.departure || '', destination: c.trip.destination || '',
        actionWord: c.trip.actionWord || (IS_RESV ? '탑승' : '호출'),
        timePhrase: (c.trip.dateTime || '') + (IS_RESV ? ' 탑승하시어' : '에 호출하시어'),
        rideId: c.ids.ride || '', resvId: c.ids.resv || '',
        _timeSrc: c.trip.timeSrc || (IS_RESV ? 'resv' : 'ride'),
        lostItem: c.trip.lostItem || ''
      };
      S('tada_msg_data', JSON.stringify(md));
      S('tada_id_type', c.ids.type === 'resv' ? 'resv' : 'ride');
      S('tada_main_id', c.ids.type === 'resv' ? (c.ids.resv || c.ids.ride) : c.ids.ride);
      S('tada_ride_id', c.ids.ride || '');
      S('tada_resv_id', c.ids.resv || '');
      S('tada_resv_ride_id', c.ids.type === 'resv' ? (c.ids.ride || '') : '');
      S('tada_from_resv_id', c.ids.fromResv || '');
      S('tada_is_from_resv', c.flags.isFromResv ? '1' : '0');
      S('tada_last_user_id', c.ids.user || '');
      S('tada_last_driver_id', c.ids.driver || '');
      S('tada_is_cash', c.flags.isCash ? '1' : '0');
      S('tada_is_plus', c.flags.isPlus ? '1' : '0');
      S('tada_third_party_tag', c.flags.thirdParty || '');
      S('tada_total_fare', c.fare.total ? String(c.fare.total) : '');
      S('tada_est_fare', c.fare.est ? String(c.fare.est) : '');
      S('tada_cancel_fee', c.fare.cancel ? String(c.fare.cancel) : '');
      S('tada_fare_items', (c.fare.items && c.fare.items.length) ? JSON.stringify(c.fare.items) : '');
      // 영손비는 loss_amount로 (원본 loss 탭 기본값)
      if (c.fare.loss) S('tada_loss_amount', String(c.fare.loss)); else localStorage.removeItem('tada_loss_amount');
    }

    async function hbRunHoneyForm() {
      const c = HBStore.loadCase();
      if (!(c && c.ts && (c.ids.type === 'ride' || c.ids.type === 'resv'))) {
        toast('🍯 라이드/예약 캡처 후 사용하세요'); return;
      }
      hbSpreadCaseToTada(c);
function blinkTitle(msg){
    const old=document.title;
    document.title=msg;
    setTimeout(()=>document.title=old,1200);
  }
function clearIds(keepMsgData){
    const keys=['tada_id_type','tada_main_id','tada_resv_id','tada_from_resv_id',
     'tada_last_user_id','tada_last_driver_id',
     'tada_is_cash','tada_third_party_tag','tada_is_plus','tada_total_fare',
     'tada_cancel_fee','tada_is_from_resv','tada_est_fare','tada_ride_id','tada_last_tab',
     'tada_resv_ride_id'];
    // 복사 직후엔 msg_data 유지 (꿀빠는 곰 연동용), 초기화 버튼은 전부 삭제
    // tada_fare_items도 fresh 실행 시 함께 정리 — 이전 라이드의 통행료/요금항목 stale 누수 방지
    // (복사 시 clearIds(true)에선 유지되어 라이드→예약 통행료 폴백은 정상 동작)
    if(!keepMsgData){ keys.push('tada_msg_data'); keys.push('tada_fare_items'); }
    keys.forEach(k=>localStorage.removeItem(k));
  }

  const type       =localStorage.getItem('tada_id_type')||'ride';
  const mainId     =localStorage.getItem('tada_main_id')||'';
  const resvId     =localStorage.getItem('tada_resv_id')||'';
  const uId        =localStorage.getItem('tada_last_user_id')||'';
  const dId        =localStorage.getItem('tada_last_driver_id')||'';
  const isCash     =localStorage.getItem('tada_is_cash')==='1';
  const thirdTag   =localStorage.getItem('tada_third_party_tag')||'';
  const isPlus     =localStorage.getItem('tada_is_plus')==='1';
  const totalFare  =localStorage.getItem('tada_total_fare')||'';
  const cancelFee  =localStorage.getItem('tada_cancel_fee')||'';
  const estFare    =localStorage.getItem('tada_est_fare')||'';
  const isFromResv =localStorage.getItem('tada_is_from_resv')==='1';
  const rideId     =localStorage.getItem('tada_ride_id')||'';
  const resvRideId =localStorage.getItem('tada_resv_ride_id')||''; // 예약 페이지 파생 라이드 ID

  // ── 플러스면 템플릿 "/ 넥스트" → "/ 플러스" 치환 ────────────────────
  function applyLineup(title){
    return isPlus?title.replace('/ 넥스트','/ 플러스'):title;
  }

  // ── 요금 포맷 헬퍼 ──────────────────────────────────────────────────
  function fmtWon(val){
    return val?Number(val).toLocaleString()+'원':'';
  }

  const fareDetected=totalFare>0;
  const fareStr  =fmtWon(totalFare)||'25,000원';
  const fareItemsRaw=localStorage.getItem('tada_fare_items')||'';
  let fareItems=[];
  try{if(fareItemsRaw)fareItems=JSON.parse(fareItemsRaw);}catch(e){}
  // 통행료(톨게이트) 파싱값 — 통행료 정정 템플릿 기본값용
  const tollItem=fareItems.find(fi=>/톨게이트|통행료|톨/.test(fi.label));
  const tollAmt=tollItem?tollItem.amt:0;
  const tollStr=tollAmt?Number(tollAmt).toLocaleString()+'원':'0원';
  const cancelStr=fmtWon(cancelFee);

  // ── 3개 모두 수집되어야 팝업 ────────────────────────────────────────
  if(!mainId||!uId||!dId){
    const missing=!mainId?`${type==='resv'?'예약':'라이드'}/호출`:!uId?'유저':'파트너';
    blinkTitle(`❌ ${missing} 필요!`);
    return;
  }

  // ── 예약 파생 라이드인데 예약 미수집 → alert만 띄우고 팝업 없이 종료 ──
  localStorage.removeItem('tada_auto_popup');

  // ── 예상요금도 저장해두기 (요금정정 기본값용) ────────────────────────
  const estDetected=estFare>0;
  const estStr   =fmtWon(estFare)||'34,000원';

  const templates=[
    {title:applyLineup('[분실물 습득 공유의 건 / 넥스트]'),         extra:'분실물 : 립스틱', beeTab:'lost'},
    {title:applyLineup('[분실물 확인 요청의 건 / 넥스트]'),         extra:'분실물 : 립스틱', beeTab:'lost'},
    {title:applyLineup('[요금 정정 요청의 건 / 넥스트]'),
     extra:rideId?`결제요금 : ${fareStr} > ${estStr}`:'⚠️ 라이드에서 한번 더 실행 필요',
     // 라이드 미수집(rideId 없음)이거나 요금/예상 미감지면 라이드에서 ㄱㄱ
     // rideId가 있으면 이미 라이드 거친 것 → 경고 불필요
     extraWarning:!rideId||!(fareDetected&&estDetected),
     hasFareItems:true},
    {title:applyLineup('[오염 영업손실비 청구 요청의 건 / 넥스트]'), extra:'영업손실비 : 150,000원', beeTab:'loss', carseatOption:true},
    {title:applyLineup('[분실물 영업손실비 청구 요청의 건 / 넥스트]'), extra:'분실물 : \n영업손실비 : 30,000원', beeTab:'loss', lossSubtype:'분실물'},
    {title:'[드라이버 경위 확인 요청의 건]',                        extra:''},
    {title:applyLineup('[이용자 인입 가능성의 건 / 넥스트]'),        extra:''},
    {title:applyLineup('[취소수수료 환불 요청의 건 / 넥스트]'),
     beeTab:'refund',
     extra:cancelStr?`취소수수료 : ${cancelStr} > 0원`:fareStr?`취소수수료 : ${fareStr} > 0원`:'취소수수료 : 원 > 0원',
     // 예약 페이지인데 파생 라이드 있으면 라이드에서 ㄱㄱ
     extraWarning:type==='resv'&&!!resvRideId},
    {title:applyLineup('[취소수수료 청구 요청의 건 / 넥스트]'),
     beeTab:'charge',
     extra:cancelStr?`취소수수료 : 0원 > ${cancelStr}`:'취소수수료 : 0원 > 3,000원'},
    {title:applyLineup('[미탑승 수수료 환불 요청의 건 / 넥스트]'),  extra:'미탑승수수료 : 4,000원 > 0원', beeTab:'refund'},
    {title:applyLineup('[미탑승 수수료 청구 요청의 건 / 넥스트]'),  extra:'미탑승수수료 : 0원 > 4,000원', beeTab:'charge'},
    {title:applyLineup('[통행료 정정 요청의 건 / 넥스트]'),          extra:`통행료 : ${tollStr} > 2,500원`, beeTab:'toll'},
    {title:applyLineup('[밴 배상 이의제기 요청의 건 / 넥스트]'),     extra:''},
    {title:applyLineup('[지각 배상 이의제기 요청의 건 / 넥스트]'),   extra:''},
    {title:'[이용자 배상 크레딧 지급 공유]',                         extra:''},
  ];

  const tags=[];
  if(thirdTag) tags.push(thirdTag);
  if(isCash)   tags.push('비회원 현장결제');

  // ── 라이드 ID 표시: 실제 라이드 ID(tada_ride_id) 우선, 없으면 미수집 ──
  // type이 'resv'(예약 파생)여도 라이드를 거쳤으면 rideId가 있음
  const rideIdDisplay=(type==='ride'?mainId:rideId)||'미수집';
  const statusHtml=[
    `✅ 라이드 ID : <b>${rideIdDisplay}</b>${isPlus?' <span style="background:#dbeafe;padding:1px 5px;border-radius:3px;font-size:11px;color:#1d4ed8;">플러스</span>':''}`,
    resvId?`✅ 예약 ID : <b>${resvId}</b>`:type==='resv'?`✅ 예약 ID : <b>${mainId}</b>`:'',
    `✅ 유저 ID : <b>${uId}</b>${thirdTag?` <span style="background:#fef9c3;padding:1px 5px;border-radius:3px;font-size:11px;">${thirdTag}</span>`:''}`,
    `✅ 파트너 ID : <b>${dId}</b>`,
    fareDetected?`<span style="color:#059669;">💰 결제요금 감지: ${fareStr}</span>`:`<span style="color:#9ca3af;">💰 결제요금 미감지 (기본값 세팅)</span>`,
    !rideId&&type==='resv'?`<span style="color:#d97706;font-weight:bold;">⚠️ 요금 정정 필요 시 라이드에서도 실행하세요</span>`:'',
    cancelStr?`<span style="color:#059669;">💰 취소수수료 감지: ${cancelStr}</span>`:'',
    isCash?`<span style="color:#dc2626;font-weight:bold;">💴 비회원 현장결제 감지됨</span>`:'',
    false?'':''  // 봉투 환경: 경고 불필요,
  ].filter(Boolean).join('<br>');

  // ── 결제수단/회원 경고 배너 (토스·티머니 결제 변경 금지 / 비회원 전산수정 불가) ─────────────
  const warnHtml=[
    thirdTag?`🛑 <b>${thirdTag}</b> 결제 건이에요. 결제 변경(요금 정정) 시 전산이 꼬일 수 있으니 결제 변경하지 마세요! (참고)`:'',
    isCash?`🛑 <b>비회원</b> 건이에요. 비회원은 전산 수정이 안 됩니다! (참고)`:'',
  ].filter(Boolean).join('<br>');

  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:999999;';

  const box=document.createElement('div');
  box.style.cssText='background:#fff;padding:20px;border-radius:12px;min-width:500px;font-family:sans-serif;box-shadow:0 4px 15px rgba(0,0,0,0.2);';

  box.innerHTML=`
    <h3 style='margin-top:0;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #eee;font-size:15px;'>
      🍯 꿀통
    </h3>
    <div style='background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#0369a1;line-height:1.9;'>
      ${statusHtml}
    </div>
    ${warnHtml?`<div style='background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#b91c1c;line-height:1.8;font-weight:bold;'>${warnHtml}</div>`:''}`;

  const form=document.createElement('div');
  form.style.cssText='max-height:320px;overflow-y:auto;padding-right:5px;';

  templates.forEach((t,idx)=>{
    const row=document.createElement('div');
    row.style.cssText='margin:6px 0;padding:7px 8px;border-radius:6px;background:#f9f9f9;border:1px solid transparent;display:flex;flex-direction:column;gap:4px;';

    const label=document.createElement('label');
    label.style.cssText='display:flex;align-items:center;gap:8px;font-weight:bold;cursor:pointer;font-size:13px;';

    const radio=document.createElement('input');
    radio.type='radio';radio.name='tada_template';radio.value=idx;
    if(idx===0)radio.checked=true;
    label.appendChild(radio);
    const titleSpan=document.createElement('span');
    titleSpan.textContent=t.title;
    label.appendChild(titleSpan);
    row.appendChild(label);

    // ── 카시트 옵션 체크박스: 체크 시 제목 앞에 "카시트 " 접두 ──
    if(t.carseatOption){
      const csWrap=document.createElement('label');
      csWrap.style.cssText='margin-left:22px;display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;cursor:pointer;';
      const csCb=document.createElement('input');
      csCb.type='checkbox';csCb.className='carseat-cb';csCb.id='carseat_cb_'+idx;
      csCb.style.cssText='cursor:pointer;flex-shrink:0;';
      const csTxt=document.createElement('span');
      csTxt.textContent='🚼 카시트 오염 (체크 시 제목 앞에 "카시트" 추가)';
      csWrap.append(csCb,csTxt);
      csCb.onchange=()=>{
        titleSpan.textContent=csCb.checked?t.title.replace('[','[카시트 '):t.title;
        // 카시트 오염 시 기본 영업손실비 80,000원 / 해제 시 150,000원 원복
        input.value=csCb.checked?'영업손실비 : 80,000원':t.extra;
        input.rows=input.value.split('\n').length+1;
        if(input.style.display==='none'){input.style.display='';toggleBtn.textContent='−';}
      };
      row.appendChild(csWrap);
    }

    const inputWrap=document.createElement('div');
    inputWrap.style.cssText='margin-left:22px;display:flex;gap:6px;align-items:center;';

    const input=document.createElement('textarea');
    input.id='extra_'+idx;input.value=t.extra;
    input.placeholder='추가 내용 (선택)';
    input.rows=t.extra?(t.extra.split('\n').length+1):2;
    input.style.cssText='flex:1;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;resize:vertical;line-height:1.5;';
    if(!t.extra)input.style.display='none';

    const toggleBtn=document.createElement('button');
    toggleBtn.textContent=t.extra?'−':'+';
    toggleBtn.style.cssText='padding:2px 7px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;color:#555;flex-shrink:0;';
    toggleBtn.onclick=()=>{
      const hidden=input.style.display==='none';
      input.style.display=hidden?'':'none';
      toggleBtn.textContent=hidden?'−':'+';
      if(hidden)input.focus();
    };
    inputWrap.append(input,toggleBtn);
    row.appendChild(inputWrap);

    radio.onchange=()=>{
      document.querySelectorAll('[data-trow]').forEach(r=>{
        r.style.borderColor='transparent';r.style.background='#f9f9f9';
      });
      row.style.borderColor='#0052cc';row.style.background='#eff6ff';
      // ✅ Fix: 라디오 선택 시 extra 입력창 있으면 자동으로 열고 포커스
      if(t.extra&&input.style.display==='none'){
        input.style.display='';
        toggleBtn.textContent='−';
      }
      if(input.style.display!=='none') setTimeout(()=>input.focus(),50);
      updateCopyBtn();
    };
    // ── 요금 정정: 항목별 추가/환불 체크박스 ──────────────────────────
    if(t.hasFareItems){
      const itemsWrap=document.createElement('div');
      itemsWrap.id='fare_items_wrap_'+idx;
      itemsWrap.style.cssText='margin-left:22px;margin-top:6px;display:none;';

      const itemsLabel=document.createElement('div');
      itemsLabel.style.cssText='font-size:11px;color:#6b7280;margin-bottom:4px;';
      itemsLabel.textContent='항목별 정정 (선택 시 extra에 자동 반영)';
      itemsWrap.appendChild(itemsLabel);

      // ── 공통 updateExtra ──────────────────────────────────────────────────────────────────────────────────────────
      const updateExtra=()=>{
        const checkedCbs=[...itemsWrap.querySelectorAll('input.fi-cb:checked')];
        if(checkedCbs.length===0){
          input.value=rideId?`결제요금 : ${fareStr} > ${estStr}`:'⚠️ 라이드에서 한번 더 실행 필요';
          return;
        }
        let adjFare=Number(localStorage.getItem('tada_total_fare')||'0');
        const lines=[];
        checkedCbs.forEach(c=>{
          const origAmt=Number(c.dataset.origAmt);
          const ai=c.parentElement.querySelector('input.fi-amt');
          const newAmt=ai?Number(ai.value.replace(/[^0-9]/g,'')): 0;
          adjFare+=(newAmt-origAmt);
          lines.push(`${c.dataset.label} : ${Number(origAmt).toLocaleString()}원 > ${Number(newAmt).toLocaleString()}원`);
        });
        const newFareStr=Number(adjFare>0?adjFare:0).toLocaleString()+'원';
        const newVal=`결제요금 : ${fareStr} > ${newFareStr}\n`+lines.join('\n');
        input.value=newVal;
        input.rows=newVal.split('\n').length+1;
      };

      // ── 파싱된 항목 ──────────────────────────────────────────────────────────────────────────────────────────────
      fareItems.forEach(fi=>{
        const itemRow=document.createElement('div');
        itemRow.style.cssText='display:flex;align-items:center;gap:6px;margin:3px 0;flex-wrap:wrap;';

        const cb=document.createElement('input');
        cb.type='checkbox';cb.className='fi-cb';
        cb.dataset.label=fi.label;cb.dataset.origAmt=fi.amt;
        cb.style.cssText='cursor:pointer;flex-shrink:0;';

        const cbLabel=document.createElement('span');
        cbLabel.style.cssText='font-size:12px;color:#374151;min-width:150px;flex-shrink:0;';
        cbLabel.textContent=`${fi.label} (${Number(fi.amt).toLocaleString()}원)`;

        const amtInput=document.createElement('input');
        amtInput.type='text';amtInput.className='fi-amt';
        amtInput.placeholder='변경 금액';
        amtInput.style.cssText='width:75px;padding:2px 5px;border:1px solid #ddd;border-radius:4px;font-size:11px;';

        const refundCb=document.createElement('input');
        refundCb.type='checkbox';
        const refundLbl=document.createElement('label');
        refundLbl.style.cssText='font-size:11px;color:#6b7280;display:flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap;';
        refundLbl.append(refundCb,'환불');

        refundCb.onchange=()=>{
          if(refundCb.checked){amtInput.value='0';amtInput.disabled=true;}
          else{amtInput.value='';amtInput.disabled=false;amtInput.focus();}
          if(cb.checked)updateExtra();
        };
        amtInput.oninput=()=>{
          let v=amtInput.value.replace(/[^0-9]/g,'');
          amtInput.value=v?Number(v).toLocaleString():'';
          if(cb.checked)updateExtra();
        };
        cb.onchange=updateExtra;

        itemRow.append(cb,cbLabel,amtInput,refundLbl);
        itemsWrap.appendChild(itemRow);
      });

      // ── 기본 제공 항목 (파싱 여부 무관) ──────────────────────────────────────────────────────────────────────────
      const _sep=document.createElement('div');
      _sep.style.cssText='border-top:1px dashed #e5e7eb;margin:5px 0 4px;font-size:10px;color:#9ca3af;';
      _sep.textContent='기본 제공 항목';
      itemsWrap.appendChild(_sep);

      // 카시트 부가서비스요금 (고정 5,000원)
      const hasCarseat=fareItems.some(fi=>/카시트/.test(fi.label));
      if(!hasCarseat){
        const csRow=document.createElement('div');
        csRow.style.cssText='display:flex;align-items:center;gap:6px;margin:3px 0;flex-wrap:wrap;background:#fffbeb;border-radius:4px;padding:2px 4px;';
        const csCb=document.createElement('input');
        csCb.type='checkbox';csCb.className='fi-cb';
        csCb.dataset.label='카시트 부가서비스요금';csCb.dataset.origAmt=0;
        csCb.style.cssText='cursor:pointer;flex-shrink:0;';
        const csLbl=document.createElement('span');
        csLbl.style.cssText='font-size:12px;color:#374151;min-width:150px;flex-shrink:0;';
        csLbl.textContent='카시트 부가서비스요금 (0→5,000원)';
        const csAmt=document.createElement('input');
        csAmt.type='text';csAmt.className='fi-amt';csAmt.value='5,000';
        csAmt.style.cssText='width:75px;padding:2px 5px;border:1px solid #fcd34d;border-radius:4px;font-size:11px;background:#fefce8;';
        csAmt.oninput=()=>{let v=csAmt.value.replace(/[^0-9]/g,'');csAmt.value=v?Number(v).toLocaleString():'';if(csCb.checked)updateExtra();};
        csCb.onchange=updateExtra;
        csRow.append(csCb,csLbl,csAmt);
        itemsWrap.appendChild(csRow);
      }

      // 대기요금 (금액 직접입력)
      const hasWaiting=fareItems.some(fi=>/대기/.test(fi.label));
      if(!hasWaiting){
        const wRow=document.createElement('div');
        wRow.style.cssText='display:flex;align-items:center;gap:6px;margin:3px 0;flex-wrap:wrap;background:#f0f9ff;border-radius:4px;padding:2px 4px;';
        const wCb=document.createElement('input');
        wCb.type='checkbox';wCb.className='fi-cb';
        wCb.dataset.label='대기요금';wCb.dataset.origAmt=0;
        wCb.style.cssText='cursor:pointer;flex-shrink:0;';
        const wLbl=document.createElement('span');
        wLbl.style.cssText='font-size:12px;color:#374151;min-width:150px;flex-shrink:0;';
        wLbl.textContent='대기요금 (금액 입력)';
        const wAmt=document.createElement('input');
        wAmt.type='text';wAmt.className='fi-amt';wAmt.placeholder='금액';
        wAmt.style.cssText='width:75px;padding:2px 5px;border:1px solid #bae6fd;border-radius:4px;font-size:11px;';
        wAmt.oninput=()=>{let v=wAmt.value.replace(/[^0-9]/g,'');wAmt.value=v?Number(v).toLocaleString():'';if(wCb.checked)updateExtra();};
        wCb.onchange=updateExtra;
        wRow.append(wCb,wLbl,wAmt);
        itemsWrap.appendChild(wRow);
      }

      // 직접 입력
      const cusRow=document.createElement('div');
      cusRow.style.cssText='display:flex;align-items:center;gap:6px;margin:4px 0 2px;flex-wrap:wrap;border-top:1px solid #f3f4f6;padding-top:4px;';
      const cusCb=document.createElement('input');
      cusCb.type='checkbox';cusCb.className='fi-cb';
      cusCb.dataset.label='';cusCb.dataset.origAmt=0;
      cusCb.style.cssText='cursor:pointer;flex-shrink:0;';
      const cusName=document.createElement('input');
      cusName.type='text';cusName.placeholder='항목명 직접입력';
      cusName.style.cssText='flex:1;min-width:100px;max-width:160px;padding:2px 5px;border:1px solid #ddd;border-radius:4px;font-size:11px;';
      const cusAmt=document.createElement('input');
      cusAmt.type='text';cusAmt.className='fi-amt';cusAmt.placeholder='금액';
      cusAmt.style.cssText='width:75px;padding:2px 5px;border:1px solid #ddd;border-radius:4px;font-size:11px;';
      cusName.oninput=()=>{cusCb.dataset.label=cusName.value.trim();if(cusCb.checked)updateExtra();};
      cusAmt.oninput=()=>{let v=cusAmt.value.replace(/[^0-9]/g,'');cusAmt.value=v?Number(v).toLocaleString():'';if(cusCb.checked)updateExtra();};
      cusCb.onchange=()=>{
        if(cusCb.checked&&!cusName.value.trim()){alert('항목명을 입력해주세요.');cusCb.checked=false;return;}
        updateExtra();
      };
      cusRow.append(cusCb,cusName,cusAmt);
      itemsWrap.appendChild(cusRow);

      row.appendChild(itemsWrap);

      // 라디오 선택 시 항목 패널 토글
      const origOnchange=radio.onchange;
      radio.onchange=()=>{
        origOnchange&&origOnchange();
        itemsWrap.style.display=rideId?'block':'none';
      };
    }

    row.setAttribute('data-trow',idx);
    if(idx===0){
      row.style.borderColor='#0052cc';row.style.background='#eff6ff';
      // 첫 번째 항목도 포커스
      if(t.extra) setTimeout(()=>input.focus(),50);
    }
    form.appendChild(row);
  });

  box.appendChild(form);

  const btnWrap=document.createElement('div');
  btnWrap.style.cssText='margin-top:12px;display:flex;justify-content:space-between;align-items:center;';

  const resetBtn=document.createElement('button');
  resetBtn.textContent='🗑 ID 초기화';
  resetBtn.style.cssText='padding:6px 12px;background:#fff;color:#dc2626;border:1px solid #fca5a5;border-radius:4px;cursor:pointer;font-size:12px;';

  const rightBtns=document.createElement('div');
  rightBtns.style.cssText='display:flex;gap:8px;';

  const copyBtn=document.createElement('button');
  copyBtn.textContent='복사하기';
  copyBtn.style.cssText='padding:6px 16px;background:#0052cc;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;';

  // ── 선택된 템플릿에 따라 버튼 텍스트 업데이트 ─────────────────────────
  function updateCopyBtn(){
    const sel=form.querySelector('input[name="tada_template"]:checked');
    if(!sel) return;
    const idx=parseInt(sel.value,10);
    const t=templates[idx];
    const needsRide=t.extraWarning&&!rideId;
    // 예약 파생 라이드인데 요금정정 탭이면 라이드에서 ㄱㄱ
    const needsRideFromResv=false; // 봉투 환경: 라이드 재실행 불필요
    const isWaiting=needsRide||needsRideFromResv;
    copyBtn.textContent=isWaiting?'라이드에서 ㄱㄱ':'복사하기';
    copyBtn.style.background=isWaiting?'#d97706':'#0052cc';
    // 항목 패널 표시 여부
    const itemsWrap=document.getElementById('fare_items_wrap_'+idx);
    if(itemsWrap) itemsWrap.style.display=(rideId&&!isWaiting)?'block':'none';
  }
  updateCopyBtn();

  const cancelBtn=document.createElement('button');
  cancelBtn.textContent='취소';
  cancelBtn.style.cssText='padding:6px 16px;background:#eee;color:#333;border:none;border-radius:4px;cursor:pointer;';

  rightBtns.append(copyBtn,cancelBtn);
  btnWrap.append(resetBtn,rightBtns);
  box.appendChild(btnWrap);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // ── 저장된 탭 자동선택 ───────────────────────────────────────────────
  const lastTabIdx=localStorage.getItem('tada_last_tab');
  if(lastTabIdx!==null){
    const targetIdx=parseInt(lastTabIdx,10);
    const targetRadio=form.querySelector(`input[name="tada_template"][value="${targetIdx}"]`);
    if(targetRadio){
      targetRadio.checked=true;
      targetRadio.dispatchEvent(new Event('change'));
    }
    localStorage.removeItem('tada_last_tab');
  }



  // ✅ Fix: ESC 키로 팝업 닫기
  function onKeydown(e){
    if(e.key==='Escape'){overlay.remove();document.removeEventListener('keydown',onKeydown);}
  }
  document.addEventListener('keydown',onKeydown);

  resetBtn.onclick=()=>{
    clearIds();
    overlay.remove();
    document.removeEventListener('keydown',onKeydown);
    blinkTitle('🗑 초기화 완료');
  };
  cancelBtn.onclick=()=>{
    overlay.remove();
    document.removeEventListener('keydown',onKeydown);
  };

  copyBtn.onclick=async()=>{
    const sel=form.querySelector('input[name="tada_template"]:checked');
    if(!sel)return;
    const idx=parseInt(sel.value,10);
    const tpl=templates[idx];

    // 라이드에서 ㄱㄱ 상태면 탭 저장 후 팝업만 닫고 ID 유지
    const needsRideNow=tpl.extraWarning&&!rideId;
    if(needsRideNow){
      localStorage.setItem('tada_last_tab', String(idx));
      overlay.remove();
      document.removeEventListener('keydown',onKeydown);
      blinkTitle('📍 라이드 페이지에서 실행해주세요!');
      return;
    }

    const inputEl=document.getElementById('extra_'+idx);
    const finalExtra=inputEl&&inputEl.style.display!=='none'?inputEl.value.trim():'';

    // ── 요금 정정 탭이면 fix 값 + 항목 저장 (꿀빠는 곰 연동용) ──────────
    if(tpl.hasFareItems&&finalExtra){
      const fixMatch=finalExtra.match(/결제요금\s*:\s*([\d,]+)원\s*>\s*([\d,]+)원/);
      if(fixMatch){
        localStorage.setItem('tada_fix_old', fixMatch[1].replace(/,/g,''));
        localStorage.setItem('tada_fix_new', fixMatch[2].replace(/,/g,''));
        localStorage.setItem('tada_fix_ride_id', rideId||'');
        localStorage.setItem('tada_fix_resv_id', resvId||'');
        // 항목별 정정 내역 파싱 후 저장
        // "카시트 부가서비스요금 : 5,000원 > 0원" 형태
        const itemLines=finalExtra.split('\n').slice(1).filter(Boolean);
        const fixItems=itemLines.map(line=>{
          const m=line.match(/^(.+?)\s*:\s*([\d,]+)원\s*>\s*([\d,]+)원$/);
          return m?{label:m[1].trim(),from:m[2].replace(/,/g,''),to:m[3].replace(/,/g,'')}:null;
        }).filter(Boolean);
        localStorage.setItem('tada_fix_items', fixItems.length?JSON.stringify(fixItems):'');
      }
      localStorage.setItem('tada_last_bee_tab','fix');
      localStorage.removeItem('tada_loss_subtype');
      localStorage.removeItem('tada_loss_amount');
    }else if(tpl.beeTab){
      // 요금정정 외 탭도 bee tab 저장 — 라이드/예약 ID 각각 분리 저장
      localStorage.setItem('tada_last_bee_tab', tpl.beeTab);
      localStorage.setItem('tada_fix_ride_id', rideId||'');   // 실제 라이드 ID
      localStorage.setItem('tada_fix_resv_id', resvId||'');   // 실제 예약 ID
      localStorage.removeItem('tada_fix_items');
      // 영업손실비 금액을 extra에서 파싱해 저장 (꿀빠는 곰 loss 탭 lossPrice 기본값 연동)
      if(tpl.beeTab==='loss'){
        const _lossM=finalExtra.match(/영업손실비\s*[:：]\s*([\d,]+)\s*원/);
        if(_lossM){localStorage.setItem('tada_loss_amount', _lossM[1].replace(/,/g,''));}
        else{localStorage.removeItem('tada_loss_amount');}
      }else{
        localStorage.removeItem('tada_loss_amount');
      }
      // 분실물 물품명을 msg_data에 저장 (꿀빠는 곰 분실물 칸 자동입력)
      if(tpl.beeTab==='lost'){
        try{
          const _md=JSON.parse(localStorage.getItem('tada_msg_data')||'{}');
          const _m=finalExtra.match(/분실물\s*[:：]\s*([\s\S]+)/);
          _md.lostItem=(_m?_m[1]:finalExtra).split('\n')[0].trim();
          localStorage.setItem('tada_msg_data', JSON.stringify(_md));
        }catch(e){}
      }
      // 분실물 영손비: subtype 플래그 + 분실물명 저장 (꿀빠는 곰 loss 탭 자동선택용)
      if(tpl.lossSubtype){
        localStorage.setItem('tada_loss_subtype', tpl.lossSubtype);
        if(tpl.lossSubtype==='분실물'){
          try{
            const _md2=JSON.parse(localStorage.getItem('tada_msg_data')||'{}');
            const _m2=finalExtra.match(/분실물[ \t]*[:：][ \t]*([^\n]+)/);
            if(_m2&&_m2[1].trim())_md2.lostItem=_m2[1].trim();
            localStorage.setItem('tada_msg_data', JSON.stringify(_md2));
          }catch(e){}
        }
      }else{
        localStorage.removeItem('tada_loss_subtype');
      }
    }else{
      localStorage.removeItem('tada_last_bee_tab');
      localStorage.removeItem('tada_fix_items');
      localStorage.removeItem('tada_loss_subtype');
      localStorage.removeItem('tada_loss_amount');
    }

    const BASE=(/(^|\.)tadatada\.(com|in)$/i.test(location.hostname)?location.origin:'https://admin.tadatada.in');
    const uHtml=`<a href="${BASE}/users/${uId}">${uId}</a>`;
    const dHtml=`<a href="${BASE}/drivers/${dId}">${dId}</a>`;
    const mainPath=type==='resv'?'rideReservations':'rides';
    const labelText=type==='resv'?'호출 예약 ID':'라이드 ID';
    const mainHtml=`<a href="${BASE}/${mainPath}/${mainId}">${mainId}</a>`;

    // ✅ Fix: 태그 없을 때 빈값 보장 (백틱 잔재 제거)
    const tagPlain=tags.length?' '+tags.map(t=>'*`'+t+'`*').join(' '):'';
    const tagHtml =tags.length?' '+tags.map(t=>`<code><b>${t}</b></code>`).join(' '):'';
    let effTitle=tpl.title;
    if(tpl.carseatOption){
      const _csCb=document.getElementById('carseat_cb_'+idx);
      if(_csCb&&_csCb.checked)effTitle=effTitle.replace('[','[카시트 ');
    }
    const titleLine=`[${effTitle.replace(/^\[|\]$/g,'')}]`;

    let plain=`*${titleLine}*${tagPlain}\n유저 : ${uId} / 드라이버 : ${dId}\n${labelText} : ${mainId}`;
    let html=`<b>${titleLine}${tagHtml}</b><br>유저 : ${uHtml} / 드라이버 : ${dHtml}<br>${labelText} : ${mainHtml}`;
    if(finalExtra){plain+=`\n${finalExtra}`;html+='<br>'+finalExtra.split('\n').join('<br>');}

    // 티켓뷰 연동은 GM 스토리지(hb_case)로 두 도메인이 직접 공유한다.
    // TADACTX 클립보드 마커는 읽는 쪽이 없어 제거 — 남기면 젠데스크 티켓
    // 본문 HTML에 유저ID·드라이버ID·요금 base64가 계속 쌓인다.

    let copied=false;
    try{
      function listener(e){
        e.clipboardData.setData('text/html',html);
        e.clipboardData.setData('text/plain',plain);
        e.preventDefault();
      }
      document.addEventListener('copy',listener,{once:true});
      copied=document.execCommand('copy');
      if(!copied)document.removeEventListener('copy',listener);
    }catch(e){copied=false;}
    if(!copied){
      try{await navigator.clipboard.writeText(plain);}
      catch(e){alert('클립보드 복사 실패');return;}
    }

    clearIds(true); // msg_data는 유지 (꿀빠는 곰 연동)
    overlay.remove();
    document.removeEventListener('keydown',onKeydown);

    try{
      const ctx=new(window.AudioContext||window.webkitAudioContext)();
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      osc.type='sine';
      osc.frequency.setValueAtTime(587.33,ctx.currentTime);
      osc.frequency.setValueAtTime(880,ctx.currentTime+0.1);
      gain.gain.setValueAtTime(0.1,ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01,ctx.currentTime+0.3);
      osc.connect(gain);gain.connect(ctx.destination);
      osc.start();osc.stop(ctx.currentTime+0.3);
    }catch(e){}
    const savedBeeTab=localStorage.getItem('tada_last_bee_tab')||'';
    blinkTitle(savedBeeTab?`🍯 꿀통 복사 완료! (꿀빠는곰→${savedBeeTab})`:'🍯 꿀통 복사 완료!');
  };
    }

    /* ══ 꿀빠는 문자 (원본 index.html 그대로) ══
     * 어드민 라이드/예약 페이지에서 실행 → 원본의 URL·DOM 체크가 정상 통과.
     * 봉투를 tada_* 로 펼친 뒤 실행하므로 꿀통 미실행 상태에서도 값이 채워짐. */
    async function hbRunBeeForm() {
      try { const c = HBStore.loadCase(); if (c && c.ts) hbSpreadCaseToTada(c); } catch (e) {}

  const tollMap={
    "영종대교":3200,"인천대교":2000,"판교통행료":1000,
    "신월지하차도":2700,"우면산터널":2500,"금토통행료":1100,
    "광암IC":2000,"북고양설문통행료":2200,"아천통행료":1700,
    "의왕통행료":1000
  };

  const isReservation=location.pathname.includes("/rideReservations/");
  const isRide=location.pathname.includes("/rides/");

  if(!isReservation&&!isRide){
    alert("Ride 또는 RideReservation 화면에서 실행해주세요.");
    return;
  }

  // ── 예약 파생 라이드 여부 (DOM 직접 감지 — 꿀통/msgData 경유 여부와 무관) ──
  // 라이드 페이지의 "호출 예약" 행에 예약 ID가 실제로 존재하면 예약 파생 라이드로 인정
  let isFromResvRide=false;
  if(isRide){
    const _rsvRow=[...document.querySelectorAll("tr")]
      .find(tr=>tr.innerText.replace(/\s+/," ").startsWith("호출 예약"));
    const _rsvTxt=_rsvRow?_rsvRow.innerText.replace(/^호출\s*예약[\s\t\n]*/,"").trim():"";
    const _rsvId=_rsvTxt.match(/[A-Z0-9]{10,}/)?.[0]||"";
    isFromResvRide=_rsvId.length>5&&!/해당\s*없음/.test(_rsvTxt)&&!/^[-\s]+$/.test(_rsvTxt);
  }
  // 수수료청구 탭에서 예약 양식을 써야 하는 컨텍스트: 예약 페이지 OR 예약 파생 라이드
  const isResvCharge=isReservation||isFromResvRide;

  function blinkTitle(msg){
    const old=document.title;
    document.title=msg;
    setTimeout(()=>document.title=old,1500);
  }

  // ── 유틸: 행 값 추출 (탭 외 공백도 허용) ──────────────────────────────
  function getRowValue(label){
    const row=[...document.querySelectorAll("tr")]
      .find(tr=>tr.innerText.replace(/\s+/," ").trim().startsWith(label));
    if(!row)return"";
    return row.innerText.replace(/^[^\t]*\t/,"").trim();
  }

  // ── 유틸: 주소 단순화 ────────────────────────────────────────────────

  // ── 유틸: Rich Text 클립보드 복사 ────────────────────────────────────
  // execCommand는 deprecated지만 HTML clipboardData 설정은 현재 유일한 방법.
  // text/plain은 navigator.clipboard.writeText 병행으로 fallback 확보.
  async function copyRichText(text){
    if(!guardPlaceholders(text)) return;   // 미기입 [   ] 방치 방지
    const escaped=text
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;");
    const html=escaped.split(/\r?\n/)
      .map(line=>line?"<div>"+line+"</div>":"<div><br></div>")
      .join("");

    // 1차: execCommand (rich text 포함)
    let richOk=false;
    try{
      function listener(e){
        e.clipboardData.setData("text/plain",text);
        e.clipboardData.setData("text/html",html);
        e.preventDefault();
      }
      document.addEventListener("copy",listener,{once:true});
      richOk=document.execCommand("copy");
      if(!richOk)document.removeEventListener("copy",listener);
    }catch(e){richOk=false;}

    // 2차: Clipboard API fallback (plain text)
    if(!richOk){
      try{
        await navigator.clipboard.writeText(text);
      }catch(e){
        alert("클립보드 복사 실패. 수동으로 복사해주세요.");
      }
    }
  }


  // ── info 초기화 ──────────────────────────────────────────────────────
  let info={
    name:"",timePhrase:"",departure:"",destination:"",
    dateTime:"",actionWord:"",isStoredRes:false,lastTab:"",rideId:""
  };
  let estPrice="",realPrice="";
  let savedTab="";

  // ── 꿀통 연동: tada_msg_data 확인 ────────────────────────────────────
  // 꿀통에서 라이드/예약 처리하며 저장한 문자정보가 현재 페이지와 일치하면
  // 라이드↔예약 2단계 과정 없이 바로 사용 (내가 직접 꿀통까지 한 케이스)
  let msgDataUsed=false;
  function applyMsgData(md){
    info.name=md.name;
    info.timePhrase=md.timePhrase||'';
    info.dateTime=md.dateTime||'';
    info.actionWord=md.actionWord||'';
    info.departure=md.departure;
    info.destination=md.destination;
    info.rideId=md.rideId||'';
    info.isStoredRes=true;
    info.isFromResv=false;
    msgDataUsed=true;
  }
  try{
    const msgRaw=localStorage.getItem('tada_msg_data');
    if(msgRaw){
      const md=JSON.parse(msgRaw);
      const curRid=location.pathname.match(/rides\/([A-Za-z0-9]+)/)?.[1]||'';
      const curRsv=location.pathname.match(/rideReservations\/([A-Za-z0-9]+)/)?.[1]||'';
      const ridMatch=curRid&&md.rideId&&curRid===md.rideId;
      const rsvMatch=curRsv&&md.resvId&&curRsv===md.resvId;
      // timePhrase까지 있어야 완전한 데이터 (예약 파생 라이드를 라이드만 실행하면
      // 탑승시각이 없어 timePhrase 비어있음 → 예약 거치도록 유도)
      const hasFull=md.name&&md.departure&&md.destination&&md.timePhrase;

      if((ridMatch||rsvMatch)&&hasFull){
        // 일치 → 바로 사용
        applyMsgData(md);
      }else if(hasFull&&(md.rideId||md.resvId)){
        // ⚠️ 휴먼에러: 꿀통 저장값 있는데 현재 페이지와 불일치 → 경고창
        const savedLabel=md.resvId?`예약 ${md.resvId}`:`라이드 ${md.rideId}`;
        const curLabel=curRsv?`예약 ${curRsv}`:`라이드 ${curRid}`;
        const choice=await new Promise(resolve=>{
          const ov=document.createElement('div');
          ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;justify-content:center;align-items:center;z-index:9999999;';
          const bx=document.createElement('div');
          bx.style.cssText='background:#fff;padding:24px;border-radius:12px;width:440px;font-family:sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
          bx.innerHTML=`
            <div style="font-size:18px;margin-bottom:12px;">⚠️ <b>휴먼에러 주의!</b></div>
            <div style="font-size:13px;line-height:1.9;color:#374151;margin-bottom:16px;">
              꿀통에서 저장한 건과 현재 페이지가 다릅니다.<br><br>
              📋 저장된 ID: <b>${savedLabel}</b><br>
              📍 현재 ID: <b>${curLabel}</b>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;">
              <button id='hme_saved' style="padding:10px;background:#0052cc;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px;">저장된 정보로 진행</button>
              <button id='hme_cur' style="padding:10px;background:#059669;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px;">현재 페이지로 진행 (저장값 리셋)</button>
              <button id='hme_cancel' style="padding:8px;background:#eee;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:13px;">취소</button>
            </div>`;
          ov.appendChild(bx);document.body.appendChild(ov);
          document.getElementById('hme_saved').onclick=()=>{ov.remove();resolve('saved');};
          document.getElementById('hme_cur').onclick=()=>{ov.remove();resolve('current');};
          document.getElementById('hme_cancel').onclick=()=>{ov.remove();resolve('cancel');};
        });
        if(choice==='cancel') return;
        if(choice==='saved'){
          applyMsgData(md);
        }else if(choice==='current'){
          // 저장값 전부 리셋
          ['tada_msg_data','tada_fix_old','tada_fix_new','tada_fix_items',
           'tada_fix_ride_id','tada_fix_resv_id','tada_fare_items','tada_last_bee_tab',
           'tada_loss_subtype','tada_loss_amount',
           'tada_ride_data','tada_res_data'].forEach(k=>localStorage.removeItem(k));
        }
      }
    }
  }catch(e){}

  // ── 예약 페이지 ──────────────────────────────────────────────────────
  if(!msgDataUsed&&isReservation){
    const userText=getRowValue("탑승자")+"\n"+getRowValue("호출자");
    info.name=extractName(userText);
    info.dateTime=getRowValue("요청 탑승 일시")||getRowValue("호출 시각");
    info.timePhrase=info.dateTime+" 탑승하시어";
    info.actionWord="탑승";

    // ── 경유지 파싱 (예약 페이지용) ────────────────────────────────────
    // 예약 페이지는 "경유지" 행에 "- 경유지 N: 주소" 형식으로 분리되어 있음
    const depAddr=simplifyAddress(getRowValue("출발지"));
    const destAddr=simplifyAddress(getRowValue("도착지"));
    const waypointRaw=getRowValue("경유지");

    if(waypointRaw&&waypointRaw.trim()&&waypointRaw.trim()!=="-"){
      // "총 경유지: N개\n- 경유지 1: 주소\n- 경유지 2: 주소" 형태 파싱
      const viaLines=waypointRaw.split("\n")
        .map(l=>l.trim())
        .filter(l=>l&&l!=="-"&&!/^총\s*경유지/.test(l)); // "총 경유지: N개" 줄 제외
      const viaParts=viaLines.map(line=>{
        // "- 경유지 N: 주소" 또는 "경유지 N: 주소" 형식에서 주소만 추출
        const m=line.match(/^-?\s*경유지\s*\d+\s*:\s*(.+)$/);
        return m?simplifyAddress(m[1].trim()):simplifyAddress(line);
      }).filter(Boolean);

      const pathParts=[depAddr,...viaParts,destAddr];
      info.departure=pathParts.slice(0,-1).join(" > ");
      info.destination=pathParts[pathParts.length-1];
    }else{
      // 경유지 없으면 출발지/도착지만
      info.departure=depAddr;
      info.destination=destAddr;
    }

    info.isStoredRes=false; // 예약 단독 실행 — 라이드 데이터 없음
    info.rideId=getRowValue("운행 정보");

    // ── 예약 예상 요금 파싱 ─────────────────────────────────────────────
    // 예약 페이지의 "예상요금" 행: "136200원\n82629 미터\n약 77 분" 형태
    const resEstRaw=getRowValue("예상요금");
    if(resEstRaw){
      const m=resEstRaw.replace(/,/g,"").match(/([0-9]+)\s*원/);
      if(m)info.resEstPrice=m[1];
    }

  // ── 라이드 페이지 ────────────────────────────────────────────────────
  }else if(!msgDataUsed){
    const saved=localStorage.getItem("tada_res_data");
    if(saved){
      const parsed=JSON.parse(saved);

      // rideId 없으면 검증 건너뜀 (취소 예약 등 라이드 없는 케이스)
      if(!parsed.rideId){
        info=parsed;
        savedTab=info.lastTab;
        localStorage.removeItem("tada_res_data");
      }else if(!location.pathname.includes(parsed.rideId)){
        const errOverlay=document.createElement("div");
        errOverlay.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;justify-content:center;align-items:center;z-index:999999;";
        const errBox=document.createElement("div");
        errBox.style.cssText="background:#fff;padding:24px;border-radius:12px;width:420px;font-family:sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.3);";
        errBox.innerHTML=`
          <div style="font-size:18px;margin-bottom:12px;">🛑 <b>휴먼에러 주의!</b></div>
          <div style="font-size:13px;line-height:1.9;color:#374151;margin-bottom:16px;">
            저장된 예약의 운행 정보 ID와 현재 라이드가 다릅니다.<br><br>
            📋 저장된 운행 정보 ID: <b>${parsed.rideId}</b><br>
            📍 현재 라이드 ID: <b>${location.pathname.match(/rides\/([A-Za-z0-9]+)/)?.[1]||''}</b>
          </div>
          <div style="display:flex;gap:8px;">
            <button id='err_reset' style="flex:1;padding:8px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px;">🗑 초기화</button>
            <button id='err_ok' style="flex:1;padding:8px;background:#eee;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:13px;">확인</button>
          </div>`;
        errOverlay.appendChild(errBox);
        document.body.appendChild(errOverlay);
        document.getElementById("err_ok").onclick=()=>errOverlay.remove();
        document.getElementById("err_reset").onclick=()=>{
          localStorage.removeItem("tada_res_data");
          errOverlay.remove();
        };
        return;
      }else{
        info=parsed;
        savedTab=info.lastTab;
        localStorage.removeItem("tada_res_data");
      }

    }else{
      const userText=getRowValue("탑승자")+"\n"+getRowValue("호출자");
      info.name=extractName(userText);
      info.dateTime=getRowValue("호출 시각")||getRowValue("요청 탑승 일시");
      info.timePhrase=info.dateTime+"에 호출하시어";
      info.actionWord="호출";

      const route=getRowValue("경로");
      if(route){
        const lines=route.split("\n").map(v=>v.trim()).filter(Boolean);
        let pathParts=[],depStr="",destStr="";
        lines.forEach(line=>{
          if(line.startsWith("출발:")){
            depStr=simplifyAddress(line.replace("출발:","").trim());
          }else if(line.startsWith("도착:")){
            destStr=simplifyAddress(line.replace("도착:","").trim());
          }else if(line.startsWith("경유")){
            const cleanVia=line.replace(/^경유\s*\d+:\s*/,"").trim();
            pathParts.push(simplifyAddress(cleanVia));
          }
        });
        if(depStr)pathParts.unshift(depStr);
        if(destStr)pathParts.push(destStr);
        if(pathParts.length>=2){
          info.departure=pathParts.slice(0,-1).join(" > ");
          info.destination=pathParts[pathParts.length-1];
        }else{
          info.departure=depStr;
          info.destination=destStr;
        }
      }else{
        info.departure=simplifyAddress(getRowValue("출발지"));
        info.destination=simplifyAddress(getRowValue("도착지"));
      }
      info.isStoredRes=false;

      // ── 호출예약 파생 라이드 감지 ───────────────────────────────────────
      const resvRow=[...document.querySelectorAll("tr")]
        .find(tr=>tr.innerText.replace(/\s+/," ").startsWith("호출 예약"));
      const resvLinkText=resvRow?resvRow.innerText.replace(/^호출\s*예약[\s\t\n]*/,"").trim():"";
      const resvIdFromRide=resvLinkText.match(/[A-Z0-9]{10,}/)?.[0]||"";
      // resvIdFromRide 가 실제로 파싱되어야 파생 라이드로 인정
      info.isFromResv=resvIdFromRide.length>5&&!/해당\s*없음/.test(resvLinkText)&&!/^[-\s]+$/.test(resvLinkText);

      // ── 예약 파생 라이드면 fromResvId만 저장 ───────────────────────
      // 탑승요청시각은 라이드 페이지에 없고 예약 페이지에만 있음
      // → 라이드에선 호출시각/호출하시어 유지, 예약 거치면 탑승시각으로 덮어써짐
      if(info.isFromResv){
        info.fromResvId=resvIdFromRide;
      }
    }
  }

  // ── 라이드에서 저장된 데이터가 있으면 불러오기 (예약 페이지 실행 시) ───────
  if(isReservation&&!msgDataUsed){
    const savedRide=localStorage.getItem("tada_ride_data");
    if(savedRide){
      const parsedRide=JSON.parse(savedRide);
      // 호출 ID 검증
      const currentResvId=location.pathname.match(/rideReservations\/([A-Za-z0-9]+)/)?.[1]||"";
      if(parsedRide.fromResvId&&parsedRide.fromResvId!==currentResvId){
        const errOverlay=document.createElement("div");
        errOverlay.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;justify-content:center;align-items:center;z-index:999999;";
        const errBox=document.createElement("div");
        errBox.style.cssText="background:#fff;padding:24px;border-radius:12px;width:420px;font-family:sans-serif;box-shadow:0 4px 20px rgba(0,0,0,0.3);";
        errBox.innerHTML=`
          <div style="font-size:18px;margin-bottom:12px;">🛑 <b>휴먼에러 주의!</b></div>
          <div style="font-size:13px;line-height:1.9;color:#374151;margin-bottom:16px;">
            저장된 라이드의 호출예약 ID와 현재 예약 페이지가 다릅니다.<br><br>
            📋 저장된 호출예약 ID: <b>${parsedRide.fromResvId}</b><br>
            📍 현재 예약 ID: <b>${currentResvId}</b>
          </div>
          <div style="display:flex;gap:8px;">
            <button id='err_reset' style="flex:1;padding:8px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:13px;">🗑 초기화</button>
            <button id='err_ok' style="flex:1;padding:8px;background:#eee;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:13px;">확인</button>
          </div>`;
        errOverlay.appendChild(errBox);
        document.body.appendChild(errOverlay);
        document.getElementById("err_ok").onclick=()=>errOverlay.remove();
        document.getElementById("err_reset").onclick=()=>{
          localStorage.removeItem("tada_ride_data");
          errOverlay.remove();
        };
        return;
      }
      // 검증 통과 — 라이드 info에 예약 정보(탑승일시) 보완
      // 예약의 탑승일시가 더 정확하므로 덮어씀
      const resvDateTime=getRowValue("요청 탑승 일시")||getRowValue("호출 시각");
      if(resvDateTime){
        parsedRide.dateTime=resvDateTime;
        parsedRide.timePhrase=resvDateTime+" 탑승하시어";
        parsedRide.actionWord="탑승";
      }
      // 저장된 라이드 info로 현재 info 대체
      Object.assign(info, parsedRide);
      info.isStoredRes=true;
      savedTab=parsedRide.lastTab||"";
      if(parsedRide.savedRealPrice) realPrice=parsedRide.savedRealPrice;
      if(parsedRide.savedEstPrice)  estPrice=parsedRide.savedEstPrice;
      localStorage.removeItem("tada_ride_data");
    }
  }

  // ── 라이드 요금 파싱 ─────────────────────────────────────────────────
  if(isRide){    const estRow=[...document.querySelectorAll("tr")]
      .find(tr=>tr.innerText.startsWith("예상요금\t"));
    if(estRow){
      const delEl=estRow.querySelector("del")||estRow.querySelector("s")
        ||estRow.querySelector("[style*='line-through']");
      if(delEl){
        const nums=delEl.innerText.replace(/[^0-9]/g,"");
        if(nums.length>0){
          const half=Math.floor(nums.length/2);
          if(half>0&&nums.substring(0,half)===nums.substring(half)){
            estPrice=nums.substring(0,half);
          }else{
            const firstMatch=delEl.innerText.match(/[0-9,]+/);
            estPrice=firstMatch?firstMatch[0].replace(/[^0-9]/g,""):"";
          }
        }
      }else{
        const match=estRow.innerText.replace(/,/g,"").match(/([0-9]+)~/);
        if(match)estPrice=match[1];
      }
    }

    // ── 1순위: "영수증" 칸의 "+ 항목"만 합산 (할인·크레딧 미적용 기준, 꿀통 양식과 동일) ──
    // ✅ Fix: 기존엔 document.body.innerText(페이지 전체)를 긁어, 실제요금 행의 계산식
    //   "기본 + N(추가 거리요금) = 총합"에 들어있는 거리추가요금까지 같이 잡혀 이중 계상됐다
    //   (영수증 +N + 실제요금식 +N → 예: 96,800이 98,000으로). 합산 범위를 영수증 칸으로 한정.
    //   영수증이 없으면 sumPrice=0 → 아래 2순위(실제요금 행)로 자동 폴백된다.
    //   ※ 실제요금 행은 "추가 거리요금", 영수증은 "거리추가요금"으로 철자가 달라 단순 dedup으론
    //     못 거르므로, 범위 한정 + 정규화 dedup 둘 다 적용한다.
    {
      const _receiptRow=[...document.querySelectorAll("tr")]
        .find(tr=>tr.innerText.replace(/\s+/," ").startsWith("영수증"));
      const receiptText=_receiptRow?_receiptRow.innerText:"";
      const plusMatches=[...receiptText.matchAll(/\+\s*([\d,]+)\s*[\(\（]([^\)\）]+)[\)\）]/g)];
      const EXCLUDE=/할인|크레딧|계좌\s*이체|포인트/;
      let sumPrice=0;
      const sumSeen=new Set();
      plusMatches.forEach(m=>{
        const label=m[2].trim();
        const amt=Number(m[1].replace(/,/g,""));
        if(amt===0) return;
        if(EXCLUDE.test(label)) return; // 할인·크레딧·계좌이체·포인트 제외
        const nlabel=label.replace(/\s+/g,"").replace(/^추가거리요금$/,"거리추가요금").replace(/^추가시간요금$/,"시간추가요금");
        if(sumSeen.has(nlabel)) return;
        sumSeen.add(nlabel);
        sumPrice+=amt;                  // 그 외 +항목은 모두 청구로 합산
      });
      if(sumPrice>0) realPrice=String(sumPrice);
    }

    // ── 2순위: +항목 합산이 0이면 실제요금 행 파싱으로 fallback ──
    if(!realPrice||realPrice==="0"){
      const realRow=[...document.querySelectorAll("tr")]
        .find(tr=>tr.innerText.startsWith("실제요금\t"));
      if(realRow){
        const totMatch=realRow.innerText.match(/총\s*([0-9,]+)\s*원/);
        if(totMatch){
          realPrice=totMatch[1].replace(/[^0-9]/g,"");
        }else{
          const lines=realRow.innerText.replace("실제요금\t","").trim()
            .split("\n").map(v=>v.trim()).filter(Boolean);
          let targetText=lines[0];
          if(lines.length>1&&lines[1].includes("원")) targetText=lines[1];
          realPrice=targetText.replace(/[^0-9]/g,"");
        }
      }
    }

    // ── 예약 파생 라이드면 요금 파싱 완료 후 저장 & return ─────────────────
    if(info.isFromResv){
      info.savedRealPrice=realPrice;
      info.savedEstPrice=estPrice;
      localStorage.setItem("tada_ride_data", JSON.stringify(info));
      blinkTitle('💾 라이드 저장됨 — 예약에서 실행 ㄱㄱ');
      alert('💾 라이드 저장 완료!\n문자 양식 탑승요청시간 때문에\n연결된 예약에서 다시 눌러줘요!!');
      return;
    }
  }

  // 예약 단독 실행 시 예상요금을 estPrice로 사용
  if(isReservation&&!estPrice&&info.resEstPrice){
    estPrice=info.resEstPrice;
  }

  // ── UI 생성 ──────────────────────────────────────────────────────────
  const overlay=document.createElement("div");
  overlay.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;justify-content:center;align-items:center;z-index:999999;";

  const box=document.createElement("div");
  box.style.cssText="background:#fff;padding:20px;border-radius:12px;min-width:480px;font-family:sans-serif;box-shadow:0 4px 15px rgba(0,0,0,0.2);";
  box.innerHTML="<h3 style='margin-top:0;margin-bottom:15px;color:#333;text-align:center;'>🐻 꿀빠는 곰</h3>";

  const modeWrap=document.createElement("div");
  modeWrap.style.cssText="display:flex;flex-direction:column;gap:6px;margin-bottom:15px;";
  const row1=document.createElement("div");row1.style.cssText="display:flex;gap:6px;";
  const row2=document.createElement("div");row2.style.cssText="display:flex;gap:6px;";

  const tabLost=document.createElement("button");tabLost.textContent="🎒 분실물";
  const tabToll=document.createElement("button");tabToll.textContent="🛣️ 통행료";
  const tabFix=document.createElement("button");tabFix.textContent="💵 요금 정정";
  const tabLoss=document.createElement("button");tabLoss.textContent="💸 영손비";
  const tabRefund=document.createElement("button");tabRefund.textContent="💸 수수료환불";
  const tabCharge=document.createElement("button");tabCharge.textContent="🧾 수수료청구";

  const TAB_BASE="flex:1;padding:10px 2px;border:1px solid #ccc;background:#f5f5f5;color:#333;border-radius:6px;cursor:pointer;font-weight:bold;font-size:12px;text-align:center;";
  [tabLost,tabToll,tabFix,tabLoss,tabRefund,tabCharge].forEach(b=>{b.style.cssText=TAB_BASE;});

  row1.append(tabLost,tabToll,tabLoss);
  row2.append(tabFix,tabRefund,tabCharge);
  modeWrap.append(row1,row2);
  box.appendChild(modeWrap);

  const contentArea=document.createElement("div");
  box.appendChild(contentArea);

  const btnWrap=document.createElement("div");
  btnWrap.style.cssText="margin-top:15px;text-align:right;";

  const copyBtn=document.createElement("button");
  copyBtn.textContent="복사하기";
  copyBtn.style.cssText="padding:8px 16px;background:#0052cc;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;";

  const cancelBtn=document.createElement("button");
  cancelBtn.textContent="취소";
  cancelBtn.style.cssText="padding:8px 16px;background:#eee;color:#333;border:none;border-radius:4px;margin-left:10px;cursor:pointer;";

  btnWrap.append(copyBtn,cancelBtn);
  box.appendChild(btnWrap);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let currentMode="lost";
  // 꿀통 탭 자동 선택:
  //  (1) msgData가 현재 페이지와 일치(상단에서 검증 완료)했으면 저장된 탭을 그대로 신뢰
  //      → 예약에서 꿀통 실행 후 라이드만 열어도 fix_resv_id 불일치로 탭이 안 바뀌던 문제 해결
  //  (2) 그 외엔 fix_ride_id/fix_resv_id가 현재 페이지와 일치할 때만 적용
  const _btRid=localStorage.getItem('tada_fix_ride_id')||'';
  const _btRsv=localStorage.getItem('tada_fix_resv_id')||'';
  const _btCurRid=location.pathname.match(/rides\/([A-Za-z0-9]+)/)?.[1]||'';
  const _btCurRsv=location.pathname.match(/rideReservations\/([A-Za-z0-9]+)/)?.[1]||'';
  const _btIdMatch=(_btRid&&_btCurRid&&_btRid===_btCurRid)||(_btRsv&&_btCurRsv&&_btRsv===_btCurRsv);
  const beeTab=(msgDataUsed||_btIdMatch)?(localStorage.getItem('tada_last_bee_tab')||''):'';
  let _lossSubtypeOnce=(msgDataUsed||_btIdMatch)?(localStorage.getItem('tada_loss_subtype')||''):'';
  let _lossAmountOnce=(msgDataUsed||_btIdMatch)?(localStorage.getItem('tada_loss_amount')||''):'';
  if(beeTab){currentMode=beeTab;}
  else if(savedTab){currentMode=savedTab;}

  // ── 탭별 폼 렌더링 ──────────────────────────────────────────────────
  function renderForm(){
    contentArea.innerHTML="";
    [tabLost,tabToll,tabFix,tabLoss,tabRefund,tabCharge].forEach(b=>{
      b.style.background="#f5f5f5";b.style.color="#333";b.style.borderColor="#ccc";
    });

    const noRide=!info.rideId||info.rideId.trim()==="-"||info.rideId.trim()==="";
    const needsRideRerun=isReservation
      && !info.isStoredRes
      &&(currentMode==="fix"||currentMode==="loss"||currentMode==="toll"||(currentMode==="refund"&&!noRide));
    // 라이드 단독 실행인데 예약 파생 라이드 + 요금/영손비/수수료 탭
    // 라이드 파생 건은 라이드 실행 시 이미 저장 후 return됨 → 여기선 항상 false
    const needsResvFirst=false;
    copyBtn.textContent=needsRideRerun?"라이드에서 재실행 ㄱㄱ":"복사하기";
    copyBtn.style.background=needsRideRerun?"#d97706":"#0052cc";

    const ACT="background:#0052cc;color:#fff;border-color:#0052cc;";

    // ── 분실물 탭 ────────────────────────────────────────────────────
    if(currentMode==="lost"){
      tabLost.style.cssText=TAB_BASE+ACT;
      // 꿀통에서 입력한 분실물 물품명 자동 채우기
      let storedLostItem='';
      try{storedLostItem=(JSON.parse(localStorage.getItem('tada_msg_data')||'{}').lostItem)||'';}catch(e){}
      contentArea.innerHTML=`
        <div style='margin:10px 0;'>
          <label style='display:block;font-weight:bold;margin-bottom:5px;'>습득한 분실물 입력:</label>
          <input id='lostItem' placeholder='예: 아이폰13, 검은색 우산' value="${storedLostItem.replace(/"/g,'&quot;')}"
            style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;'>
        </div>
        <div style='margin:12px 0 4px;'>
          <label style='display:block;font-weight:bold;margin-bottom:6px;'>영업손실비 결제 방식:</label>
          <label style='margin-right:14px;cursor:pointer;font-weight:bold;'>
            <input type='radio' name='lostPayType' value='card' checked> 카드 자동결제
          </label>
          <label style='cursor:pointer;font-weight:bold;'>
            <input type='radio' name='lostPayType' value='field'> 현장결제 <span style='font-weight:normal;color:#6b7280;font-size:12px;'>(비회원·토스·티머니)</span>
          </label>
        </div>`;
      setTimeout(()=>document.getElementById("lostItem")?.focus(),50);

    // ── 통행료 탭 ────────────────────────────────────────────────────
    }else if(currentMode==="toll"){
      tabToll.style.cssText=TAB_BASE+ACT;
      // fareItems에서 기존 통행료 파싱
      let parsedBaseTotal=0;
      // 1차: 현재 페이지 직접 파싱 (가장 정확 — 항상 현재 라이드 기준)
      try{
        const pageText=document.body.innerText;
        const pageMatches=[...pageText.matchAll(/\+\s*([\d,]+)\s*[\(\（]([^\)\）]+)[\)\）]/g)];
        const _tollSeen=new Set();  // 같은 통행료 라벨이 여러 행(영수증·실제요금 계산식 등)에 중복 노출돼도 1회만 합산 (꿀통 fareItems와 동일 기준)
        pageMatches.forEach(m=>{
          const lbl=m[2].trim();
          const amt=Number(m[1].replace(/,/g,''));
          if(amt>0&&/통행료|톨게이트|터널|대교|지하차도|IC/.test(lbl)){
            if(_tollSeen.has(lbl)) return;
            _tollSeen.add(lbl);
            parsedBaseTotal+=amt;
          }
        });
      }catch(e){}
      // 2차: 현재 페이지에 없을 때만 tada_fare_items (라이드 ID 일치 검증)
      if(parsedBaseTotal===0){
        try{
          const _fRid=localStorage.getItem('tada_fix_ride_id')||'';
          const _fRsv=localStorage.getItem('tada_fix_resv_id')||'';
          const _cRid=location.pathname.match(/rides\/([A-Za-z0-9]+)/)?.[1]||'';
          const _cRsv=location.pathname.match(/rideReservations\/([A-Za-z0-9]+)/)?.[1]||'';
          const _match=(_fRid&&_cRid&&_fRid===_cRid)||(_fRsv&&_cRsv&&_fRsv===_cRsv);
          if(_match){
            const fi=JSON.parse(localStorage.getItem('tada_fare_items')||'[]');
            fi.forEach(item=>{
              if(/통행료|톨게이트|터널|대교|지하차도|IC/.test(item.label)) parsedBaseTotal+=Number(item.amt);
            });
          }
        }catch(e){}
      }

      let tollHtml=`<div>
        <div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;'>
          <span style='font-size:13px;font-weight:bold;color:#374151;'>통행료 구간 선택</span>
          <label id='addModeLabel' style='display:flex;align-items:center;gap:4px;cursor:pointer;font-size:11px;font-weight:bold;color:#374151;padding:3px 8px;border:1.5px solid #d1d5db;border-radius:12px;background:#f9fafb;user-select:none;'><input type='checkbox' id='addModeCheck' style='accent-color:#059669;width:12px;height:12px;cursor:pointer;'> 기존+추가</label><span id='tollTotalBadge' style='background:#0052cc;color:#fff;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:bold;'>합계 0원</span>
        </div>
        <div style='max-height:160px;overflow-y:auto;border:1px solid #eee;padding:8px;border-radius:6px;background:#fafafa;'>`;
      Object.entries(tollMap).forEach(([tName,price])=>{
        tollHtml+=`<label style='display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;font-size:13px;'>
          <input type='checkbox' name='tollCheck' value='${tName}' style='accent-color:#0052cc;width:14px;height:14px;cursor:pointer;flex-shrink:0;'>
          <span>${tName}</span><span style='margin-left:auto;color:#374151;font-weight:bold;'>${price.toLocaleString()}원</span>
        </label>`;
      });
      tollHtml+=`</div></div>
        <hr style='border:0;border-top:1px solid #eee;margin:10px 0;'>
        <label style='cursor:pointer;font-weight:bold;font-size:13px;display:flex;align-items:center;gap:6px;'>
          <input type='checkbox' id='customCheck' style='accent-color:#374151;width:14px;height:14px;cursor:pointer;'> 🔧 기타 직접입력
        </label>
        <div id='customInputArea' style='display:none;margin-top:8px;'>
          <div id='customRows'></div>
          <button id='addCustomRow' type='button' style='margin-top:6px;width:100%;padding:6px;background:#f0f7ff;border:1px dashed #93c5fd;border-radius:6px;color:#0052cc;font-size:12px;font-weight:bold;cursor:pointer;'>+ 항목 추가</button>
        </div>
        <hr style='border:0;border-top:1px solid #eee;margin:10px 0;'>
        <div style='display:flex;gap:8px;align-items:flex-end;'>
          <div style='flex:1;'>
            <div style='font-size:12px;font-weight:bold;margin-bottom:4px;color:#374151;'>기존 통행료<span style='font-weight:normal;color:#9ca3af;font-size:11px;'> (이미 청구된 금액)</span></div>
            <input id='tollOldPrice' placeholder='예: 2,000'
              style='width:100%;padding:6px 8px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px;font-size:13px;'>
          </div>
          <div style='display:flex;flex-direction:column;align-items:center;padding-bottom:6px;flex-shrink:0;gap:2px;'>
            <span style='color:#9ca3af;font-size:18px;'>→</span>
            <span id='tollDiffBadge' style='font-size:10px;font-weight:bold;white-space:nowrap;'></span>
          </div>
          <div style='flex:1;'>
            <div style='display:flex;align-items:center;gap:6px;margin-bottom:4px;'>
              <span style='font-size:12px;font-weight:bold;color:#374151;'>변경 통행료</span>
              <label style='display:flex;align-items:center;gap:3px;cursor:pointer;font-size:11px;color:#dc2626;font-weight:bold;margin-left:auto;'>
                <input type='checkbox' id='refundCheck' style='accent-color:#dc2626;width:12px;height:12px;cursor:pointer;'> 환불
              </label>
            </div>
            <input id='tollNewPrice' placeholder='자동 계산'
              style='width:100%;padding:6px 8px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#f0f7ff;'>
          </div>
        </div>`;
      contentArea.innerHTML=tollHtml;

      document.getElementById('tollOldPrice').value=parsedBaseTotal>0?parsedBaseTotal.toLocaleString():'0';

      function recalcToll(){
        if(document.getElementById('refundCheck')?.checked) return;
        const checks=[...contentArea.querySelectorAll('input[name="tollCheck"]:checked')];
        let sum=checks.reduce((s,v)=>s+(tollMap[v.value]||0),0);
        if(document.getElementById('customCheck')?.checked){
          // 여러 기타 직접입력 행 합산
          contentArea.querySelectorAll('.customPrice').forEach(el=>{
            const cp=Number((el.value||'0').replace(/[^0-9]/g,''));
            if(cp>0) sum+=cp;
          });
        }
        // 추가 모드: 변경 통행료 = 기존 통행료 + 선택 항목
        const isAddMode=document.getElementById('addModeCheck')?.checked;
        const oldBaseNum=Number((document.getElementById('tollOldPrice')?.value||'0').replace(/[^0-9]/g,''))||0;
        if(isAddMode&&oldBaseNum>0) sum+=oldBaseNum;
        const badge=document.getElementById('tollTotalBadge');
        if(badge){
          if(isAddMode&&oldBaseNum>0&&sum>oldBaseNum)
            badge.textContent='합계 '+sum.toLocaleString()+'원 (+추가)';
          else
            badge.textContent=sum>0?'합계 '+sum.toLocaleString()+'원':'합계 0원';
        }
        const newEl=document.getElementById('tollNewPrice');
        if(newEl){ newEl.style.background='#f0f7ff'; newEl.value=sum>0?sum.toLocaleString():''; }
        // 차액 배지 업데이트
        const oldNum=Number((document.getElementById('tollOldPrice')?.value||'0').replace(/[^0-9]/g,''))||0;
        const diffBadge=document.getElementById('tollDiffBadge');
        if(diffBadge){
          const diff=sum-oldNum;
          if(oldNum>0&&diff!==0){
            diffBadge.textContent=diff>0?'+'+diff.toLocaleString()+'원':diff.toLocaleString()+'원';
            diffBadge.style.color=diff>0?'#0052cc':'#dc2626';
          }else{ diffBadge.textContent=''; }
        }
      }
      contentArea.querySelectorAll('input[name="tollCheck"]').forEach(cb=>{
        cb.addEventListener('change',recalcToll);
      });

      // 추가 모드 토글
      document.getElementById('addModeCheck').onchange=function(){
        const lbl=document.getElementById('addModeLabel');
        if(lbl){
          lbl.style.borderColor=this.checked?'#059669':'#d1d5db';
          lbl.style.background=this.checked?'#ecfdf5':'#f9fafb';
          lbl.style.color=this.checked?'#059669':'#374151';
        }
        recalcToll();
      };

      // ── 기타 직접입력: 동적 행 추가 ──────────────────────────────────
      let customRowSeq=0;
      function addCustomRow(){
        const rows=document.getElementById('customRows');
        if(!rows) return;
        const id=customRowSeq++;
        const row=document.createElement('div');
        row.style.cssText='display:flex;gap:8px;align-items:flex-end;margin-bottom:6px;';
        row.innerHTML=`
          <div style='flex:2;'>
            <div style='font-size:11px;color:#6b7280;margin-bottom:3px;font-weight:bold;'>명칭</div>
            <input class='customName' placeholder='예: 성남톨게이트' style='width:100%;padding:6px 8px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;font-size:13px;'>
          </div>
          <div style='flex:1;'>
            <div style='font-size:11px;color:#6b7280;margin-bottom:3px;font-weight:bold;'>금액 (원)</div>
            <input class='customPrice' type='number' placeholder='0' min='0' style='width:100%;padding:6px 8px;box-sizing:border-box;border:1px solid #d1d5db;border-radius:6px;font-size:13px;'>
          </div>
          <button type='button' class='delCustomRow' style='flex-shrink:0;padding:6px 10px;background:#fee2e2;border:1px solid #fca5a5;border-radius:6px;color:#dc2626;font-size:13px;cursor:pointer;margin-bottom:0;'>✕</button>`;
        rows.appendChild(row);
        // 이벤트
        row.querySelector('.customPrice').addEventListener('input',function(){
          let v=this.value.replace(/[^0-9]/g,'');this.value=v||'';recalcToll();
        });
        row.querySelector('.customName').addEventListener('input',recalcToll);
        row.querySelector('.delCustomRow').onclick=()=>{row.remove();recalcToll();};
        return row;
      }

      document.getElementById('addCustomRow').onclick=()=>{addCustomRow();};

      document.getElementById('customCheck').onchange=function(){
        const area=document.getElementById('customInputArea');
        area.style.display=this.checked?'block':'none';
        if(this.checked){
          // 첫 행 자동 생성
          if(document.getElementById('customRows').children.length===0){
            const row=addCustomRow();
            setTimeout(()=>row?.querySelector('.customName')?.focus(),50);
          }
        }
        recalcToll();
      };

      document.getElementById('refundCheck').onchange=function(){
        const newEl=document.getElementById('tollNewPrice');
        const badge=document.getElementById('tollTotalBadge');
        const diffBadgeR=document.getElementById('tollDiffBadge');
        if(this.checked){
          newEl.value='0'; newEl.style.background='#fef2f2';
          if(badge) badge.textContent='환불';
          if(diffBadgeR){ const oN=Number((document.getElementById('tollOldPrice')?.value||'0').replace(/[^0-9]/g,''))||0; diffBadgeR.textContent=oN>0?'-'+oN.toLocaleString()+'원':''; diffBadgeR.style.color='#dc2626'; }
        }else{
          newEl.style.background='#f0f7ff';
          if(badge) badge.textContent='합계 0원';
          if(diffBadgeR) diffBadgeR.textContent='';
          recalcToll();
        }
      };

      setTimeout(()=>{
        document.getElementById('tollOldPrice').oninput=function(){
          let v=this.value.replace(/[^0-9]/g,''); this.value=v?Number(v).toLocaleString():'';
          recalcToll();
        };
        const newEl=document.getElementById('tollNewPrice');
        if(newEl) newEl.oninput=()=>{
          if(document.getElementById('refundCheck')?.checked) return;
          let v=newEl.value.replace(/[^0-9]/g,''); newEl.value=v?Number(v).toLocaleString():'';
        };
      },0);

    // ── 요금 정정 탭 ─────────────────────────────────────────────────
    }else if(currentMode==="fix"){
      tabFix.style.cssText=TAB_BASE+ACT;
      if(isReservation&&!info.isStoredRes){
        contentArea.innerHTML=`
          <div style='margin:20px 0;padding:15px;background:#fff7ed;border:1px solid #fed7aa;
            border-radius:8px;color:#c2410c;font-weight:bold;text-align:center;line-height:1.8;font-size:14px;'>
            ⚠️ 요금 정정은 라이드 페이지에서만 완성 가능합니다<br>
            아래 버튼으로 예약 정보를 저장한 뒤<br>
            해당 라이드 페이지에서 다시 실행해주세요
          </div>`;
        return;
      }
      if(needsResvFirst){
        info.lastTab=currentMode;
        info.fromResvId=info.fromResvId||"";
        localStorage.setItem("tada_ride_data", JSON.stringify(info));
        overlay.remove();
        blinkTitle('💾 라이드 저장됨 — 예약에서 실행 ㄱㄱ');
        return;
      }
      contentArea.innerHTML=`
        <div style='margin:5px 0;'>
          <label style='display:block;font-weight:bold;margin-bottom:5px;'>정정 사유 선택:</label>
          <select id='fixReason' style='width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;'>
            <option value='' selected>기본 (사유 없음)</option>
            <option value='GPS 이상으로 인하여'>GPS 이상으로 인하여</option>
            <option value='경로 우회로 인하여'>경로 우회로 인하여</option>
            <option value='custom'>기타 직접 입력</option>
          </select>
        </div>
        <div id='customReasonWrap' style='margin-top:8px;display:none;'>
          <input id='customReason' placeholder='사유를 직접 입력하세요'
            style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;'>
        </div>
        <div style='margin-top:12px;display:flex;gap:10px;'>
          <div style='flex:1;'>
            <label style='display:block;font-weight:bold;margin-bottom:3px;'>기존 금액:</label>
            <input id='fixOldPrice' value='${(()=>{
              const fixRideId=localStorage.getItem("tada_fix_ride_id")||"";
              const fixResvId=localStorage.getItem("tada_fix_resv_id")||"";
              const curRideId=location.pathname.match(/rides\/([A-Za-z0-9]+)/)?.[1]||"";
              const curResvId=location.pathname.match(/rideReservations\/([A-Za-z0-9]+)/)?.[1]||"";
              const rideMatch=(fixRideId&&curRideId&&fixRideId===curRideId)||(fixResvId&&curResvId&&fixResvId===curResvId);
              // 라이드/예약 ID 일치하면 fix 값 우선 사용
              const v=rideMatch?localStorage.getItem("tada_fix_old"):null;
              return realPrice?Number(realPrice).toLocaleString():v?Number(v).toLocaleString():"";
            })()}'
              style='width:100%;padding:6px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;'>
          </div>
          <div style='flex:1;'>
            <label style='display:block;font-weight:bold;margin-bottom:3px;'>정정 금액 (예상최저):</label>
            <input id='fixNewPrice' value='${(()=>{
              const fixRideId2=localStorage.getItem("tada_fix_ride_id")||"";
              const fixResvId2=localStorage.getItem("tada_fix_resv_id")||"";
              const curRideId2=location.pathname.match(/rides\/([A-Za-z0-9]+)/)?.[1]||"";
              const curResvId2=location.pathname.match(/rideReservations\/([A-Za-z0-9]+)/)?.[1]||"";
              const rideMatch2=(fixRideId2&&curRideId2&&fixRideId2===curRideId2)||(fixResvId2&&curResvId2&&fixResvId2===curResvId2);
              const v=rideMatch2?localStorage.getItem("tada_fix_new"):null;
              return v?Number(v).toLocaleString():estPrice?Number(estPrice).toLocaleString():"";
            })()}'
              style='width:100%;padding:6px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;'>
          </div>
        </div>`;

      // ── 꿀통 항목별 정정 내역 있으면 추가 칸 렌더링 ─────────────────────
      const fixRideIdCheck=localStorage.getItem('tada_fix_ride_id')||'';
      const fixResvIdCheck=localStorage.getItem('tada_fix_resv_id')||'';
      const curRideIdCheck=location.pathname.match(/rides\/([A-Za-z0-9]+)/)?.[1]||'';
      const curResvIdCheck=location.pathname.match(/rideReservations\/([A-Za-z0-9]+)/)?.[1]||'';
      const fixRideMatch=(fixRideIdCheck&&curRideIdCheck&&fixRideIdCheck===curRideIdCheck)||
                         (fixResvIdCheck&&curResvIdCheck&&fixResvIdCheck===curResvIdCheck);
      const fixItemsRaw=(fixRideMatch?localStorage.getItem('tada_fix_items'):'')||'';
      let fixItemsList=[];
      try{if(fixItemsRaw)fixItemsList=JSON.parse(fixItemsRaw);}catch(e){}
      if(fixItemsList.length>0){
        const itemsDiv=document.createElement('div');
        itemsDiv.style.cssText='margin-top:10px;';
        const itemsTitle=document.createElement('div');
        itemsTitle.style.cssText='font-size:12px;color:#6b7280;margin-bottom:6px;font-weight:bold;';
        itemsTitle.textContent='항목별 정정:';
        itemsDiv.appendChild(itemsTitle);
        fixItemsList.forEach((fi,i)=>{
          const row=document.createElement('div');
          row.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:6px;';
          const lbl=document.createElement('span');
          lbl.style.cssText='font-size:12px;color:#374151;min-width:140px;flex-shrink:0;';
          lbl.textContent=fi.label;
          const fromIn=document.createElement('input');
          fromIn.value=Number(fi.from).toLocaleString();
          fromIn.id='fixItem_from_'+i;
          fromIn.style.cssText='width:80px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px;text-align:right;';
          const arrow=document.createElement('span');
          arrow.textContent='>';arrow.style.cssText='color:#6b7280;font-size:12px;flex-shrink:0;';
          const toIn=document.createElement('input');
          toIn.value=Number(fi.to).toLocaleString();
          toIn.id='fixItem_to_'+i;
          toIn.style.cssText='width:80px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px;text-align:right;';
          [fromIn,toIn].forEach(el=>{
            el.oninput=()=>{let v=el.value.replace(/[^0-9]/g,"");el.value=v?Number(v).toLocaleString():"";};
          });
          row.append(lbl,fromIn,arrow,toIn);
          itemsDiv.appendChild(row);
        });
        contentArea.appendChild(itemsDiv);
      }

      const selectEl=document.getElementById("fixReason");
      const customWrap=document.getElementById("customReasonWrap");
      selectEl.onchange=()=>{
        customWrap.style.display=selectEl.value==="custom"?"block":"none";
        if(selectEl.value==="custom")document.getElementById("customReason").focus();
      };
      [["fixOldPrice"],["fixNewPrice"]].forEach(([id])=>{
        const el=document.getElementById(id);
        el.oninput=()=>{
          let v=el.value.replace(/[^0-9]/g,"");
          el.value=v?Number(v).toLocaleString():"";
        };
      });

    // ── 영손비 탭 ────────────────────────────────────────────────────
    }else if(currentMode==="loss"){
      tabLoss.style.cssText=TAB_BASE+ACT;

      if(needsResvFirst){
        info.lastTab=currentMode;
        info.fromResvId=info.fromResvId||"";
        localStorage.setItem("tada_ride_data", JSON.stringify(info));
        overlay.remove();
        blinkTitle('💾 라이드 저장됨 — 예약에서 실행 ㄱㄱ');
        return;
      }
      // 꿀통에서 넘어온 영업손실비 금액을 기본값으로 사용 (1회성, ID 매칭 가드 적용)
      const _initLossAmt=_lossAmountOnce?_lossAmountOnce.replace(/[^0-9]/g,''):'';
      _lossAmountOnce='';
      const _fmtLoss=(def)=>_initLossAmt?Number(_initLossAmt).toLocaleString():def;
      contentArea.innerHTML=`
        <div style='margin:5px 0;'>
          <label style='display:block;font-weight:bold;margin-bottom:8px;'>종류 선택:</label>
          <label style='margin-right:12px;cursor:pointer;font-weight:bold;'>
            <input type='radio' name='contamType' value='차량 내부 오염' checked> 차량 내부 오염
          </label>
          <label style='margin-right:12px;cursor:pointer;font-weight:bold;'>
            <input type='radio' name='contamType' value='카시트 오염'> 카시트 오염
          </label>
          <label style='cursor:pointer;font-weight:bold;'>
            <input type='radio' name='contamType' value='분실물'> 🎒 분실물
          </label>
        </div>
        <div id='lossDynamicArea' style='margin-top:15px;'>
          <label style='display:block;font-weight:bold;margin-bottom:5px;'>영업손실비 금액 입력:</label>
          <input id='lossPrice' value='${_fmtLoss("150,000")}'
            style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;'>
        </div>
        <div style='margin-top:10px;'>
        </div>`;

      function bindLossPrice(){
        const lp=document.getElementById("lossPrice");
        if(lp)lp.oninput=()=>{
          let v=lp.value.replace(/[^0-9]/g,"");
          lp.value=v?Number(v).toLocaleString():"";
        };
      }
      bindLossPrice();

      contentArea.querySelectorAll('input[name="contamType"]').forEach(r=>{
        r.onchange=()=>{
          const dynArea=document.getElementById("lossDynamicArea");
          if(r.value==="분실물"){
            dynArea.innerHTML=`
              <label style='display:block;font-weight:bold;margin-bottom:5px;'>습득 분실물 명칭 입력:</label>
              <input id='lossItemName' placeholder='예: 아이폰13, 검은색 우산'
                style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;margin-bottom:10px;'>
              <label style='display:block;font-weight:bold;margin-bottom:5px;'>영업손실비 금액 입력:</label>
              <input id='lossPrice' value='${_fmtLoss("30,000")}'
                style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;'>`;
          }else{
            dynArea.innerHTML=`
              <label style='display:block;font-weight:bold;margin-bottom:5px;'>영업손실비 금액 입력:</label>
              <input id='lossPrice' value='${_fmtLoss("150,000")}'
                style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;'>`;
          }
          bindLossPrice();
        };
      });
        // ── 분실물 영손비: 꿀통 연동 시 분실물 라디오 자동선택 + 명칭 입력 ──
        if(_lossSubtypeOnce==='분실물'){
          _lossSubtypeOnce='';
          const _lr=contentArea.querySelector('input[name="contamType"][value="분실물"]');
          if(_lr){
            _lr.checked=true;
            _lr.dispatchEvent(new Event('change'));
            const _ln=document.getElementById('lossItemName');
            if(_ln){
              let _li='';try{_li=(JSON.parse(localStorage.getItem('tada_msg_data')||'{}').lostItem)||'';}catch(e){}
              if(_li)_ln.value=_li;
            }
          }
        }

    // ── 수수료환불 탭 ────────────────────────────────────────────────
    }else if(currentMode==="refund"){
      tabRefund.style.cssText=TAB_BASE+ACT;
      // ── 영수증에서 취소수수료/미탑승수수료 직접 파싱 (라이드·예약 페이지 공통) ──
      // 호출예약 영수증은 "+ 20000원 (취소수수료)"처럼 숫자 뒤에 '원'이 붙어
      // realPrice/실제요금에 의존하면 못 잡던 케이스 보강. '원' 접미사 허용.
      let cancelFee="",noshowFee="";
      {
        const _rcptRow=[...document.querySelectorAll("tr")]
          .find(tr=>tr.innerText.replace(/\s+/,"  ").startsWith("영수증"));
        const _rcptTxt=_rcptRow?_rcptRow.innerText:"";
        [..._rcptTxt.matchAll(/\+\s*([\d,]+)\s*원?\s*[(（]([^)）]+)[)）]/g)].forEach(m=>{
          const lbl=m[2].replace(/\s+/g,"");
          const amt=m[1].replace(/,/g,"");
          if(/취소수수료/.test(lbl))cancelFee=amt;
          else if(/미탑승수수료/.test(lbl))noshowFee=amt;
        });
      }
      if(isReservation&&!info.isStoredRes){
        // 파생 라이드 있으면 라이드에서 재실행 안내 (버튼은 needsRideRerun이 처리)
        if(!noRide){
          contentArea.innerHTML=`
            <div style='margin:20px 0;padding:15px;background:#fff7ed;border:1px solid #fed7aa;
              border-radius:8px;color:#c2410c;font-weight:bold;text-align:center;line-height:1.8;font-size:14px;'>
              ⚠️ 수수료 환불은 라이드 페이지에서만 완성 가능합니다<br>
              아래 버튼으로 예약 정보를 저장한 뒤<br>
              해당 라이드 페이지에서 다시 실행해주세요
            </div>`;
          return;
        }
        // 파생 라이드 없으면 예약 페이지 실제요금 파싱해서 바로 작동
        const resRealFareText=getRowValue("실제요금");
        const resRealMatch=resRealFareText.replace(/,/g,"").match(/총\s*([0-9]+)\s*원/)||
                           resRealFareText.replace(/,/g,"").match(/=\s*([0-9]+)/)||
                           resRealFareText.replace(/,/g,"").match(/([0-9]+)\s*원/);
        const resRealPrice=resRealMatch?resRealMatch[1]:"";
        if(resRealPrice) realPrice=resRealPrice;
      }
      if(needsResvFirst){
        info.lastTab=currentMode;
        info.fromResvId=info.fromResvId||"";
        localStorage.setItem("tada_ride_data", JSON.stringify(info));
        overlay.remove();
        blinkTitle('💾 라이드 저장됨 — 예약에서 실행 ㄱㄱ');
        return;
      }
      // ✅ Fix: "export " 텍스트 제거
      // 기본 수수료 종류/금액: 영수증에서 잡힌 취소·미탑승 수수료 우선, 없으면 실제요금
      const _isNoshowDefault=!!noshowFee&&!cancelFee;
      const _defaultFee=cancelFee||noshowFee||realPrice||"";
      contentArea.innerHTML=`
        <div style='margin:5px 0;'>
          <label style='display:block;font-weight:bold;margin-bottom:8px;'>수수료 종류 선택:</label>
          <label style='margin-right:15px;cursor:pointer;font-weight:bold;'>
            <input type='radio' name='refundType' value='취소 수수료' ${_isNoshowDefault?"":"checked"}> 취소 수수료
          </label>
          <label style='cursor:pointer;font-weight:bold;'>
            <input type='radio' name='refundType' value='미탑승 수수료' ${_isNoshowDefault?"checked":""}> 미탑승 수수료
          </label>
        </div>
        <div style='margin-top:15px;'>
          <label style='display:block;font-weight:bold;margin-bottom:5px;'>환불 금액 입력:</label>
          <input id='refundPrice' value='${_defaultFee?Number(_defaultFee).toLocaleString():(_isNoshowDefault?"4,000":"3,000")}'
            style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;'>
        </div>`;
      const refundPriceEl=document.getElementById("refundPrice");
      refundPriceEl.oninput=()=>{
        let v=refundPriceEl.value.replace(/[^0-9]/g,"");
        refundPriceEl.value=v?Number(v).toLocaleString():"";
      };
      // 종류 전환 시: 영수증에서 잡힌 금액 우선, 없으면 종류별 기본값(취소 3,000 / 미탑승 4,000)
      contentArea.querySelectorAll('input[name="refundType"]').forEach(r=>{
        r.onchange=()=>{
          const fee=r.value==="미탑승 수수료"?(noshowFee||"4000"):(cancelFee||"3000");
          refundPriceEl.value=Number(fee).toLocaleString();
        };
      });

    // ── 수수료청구 탭 ────────────────────────────────────────────────
    }else if(currentMode==="charge"){
      tabCharge.style.cssText=TAB_BASE+ACT;

      if(isResvCharge){
        // 약관별 계산 로직
        // 예약 확정 요금: resEstPrice → DOM 예상요금 → 라이드 예상/실제요금 순으로 견고하게 확보
        let resBase=Number(info.resEstPrice)||0;
        if(!resBase){
          const _estRaw=getRowValue("예상요금");
          const _m=(_estRaw||"").replace(/,/g,"").match(/([0-9]+)\s*원/);
          if(_m) resBase=Number(_m[1]);
        }
        if(!resBase) resBase=Number(estPrice)||Number(realPrice)||0;

        // 약관 선택 → 취소 요금 자동계산
        const calcCharge=(policy,base)=>{
          if(policy==="10pct") return Math.min(Math.round(base*0.1),5000);
          if(policy==="50pct") return Math.min(Math.round(base*0.5),10000);
          if(policy==="80pct") return Math.min(Math.round(base*0.8),20000);
          if(policy==="100pct") return Math.min(base,30000);
          return 0;
        };

        const baseDisplay=resBase?Number(resBase).toLocaleString():"";
        const defaultCharge=resBase?calcCharge("80pct",resBase).toLocaleString():"";

        contentArea.innerHTML=`
          <div style='margin:5px 0;'>
            <label style='display:block;font-weight:bold;margin-bottom:8px;'>취소 시점 선택 (약관 기준):</label>
            <select id='chargePolicy' style='width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;margin-bottom:10px;'>
              <option value='none' style='color:#c2410c;font-weight:bold;'>⚠️ 드라이버 배정 10분 전 취소 — 수수료 없음</option>
              <option value='10pct'>출발 12~9시간 이내 취소 — 확정요금 10% (최대 5,000원)</option>
              <option value='50pct'>출발 9~2시간 이내 취소 — 확정요금 50% (최대 10,000원)</option>
              <option value='80pct' selected>출발 2시간 이내 취소 — 확정요금 80% (최대 20,000원)</option>
              <option value='100pct'>미탑승/10분 이후 연락두절 — 확정요금 100% (최대 30,000원)</option>
            </select>
            <div id='noFeeWarning' style='display:none;margin-bottom:10px;padding:12px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;color:#dc2626;font-weight:bold;text-align:center;font-size:13px;'>
              🛑 수수료 미발생 케이스입니다<br>수수료 청구 불가 — 탭을 다시 확인해주세요
            </div>
            <label style='display:block;font-weight:bold;margin-bottom:5px;'>예약 확정 요금:</label>
            <input id='chargeBase' value='${baseDisplay}' placeholder='예: 31,100'
              style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;margin-bottom:10px;'>
            <label style='display:block;font-weight:bold;margin-bottom:5px;'>취소 수수료 금액 <span style='font-weight:normal;color:#888;font-size:12px;'>(자동계산, 수정 가능)</span>:</label>
            <input id='chargeAmount' value='${defaultCharge}' placeholder='예: 20,000'
              style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;background:#f0f7ff;'>
          </div>`;

        const policyEl=document.getElementById("chargePolicy");
        const baseEl=document.getElementById("chargeBase");
        const amtEl=document.getElementById("chargeAmount");

        // 자동계산 함수
        const autoCalc=()=>{
          const noFeeWarn=document.getElementById("noFeeWarning");
          const baseEl2=document.getElementById("chargeBase");
          const amtEl2=document.getElementById("chargeAmount");
          if(policyEl.value==="none"){
            noFeeWarn.style.display="block";
            baseEl2.style.opacity="0.4";
            amtEl2.style.opacity="0.4";
            amtEl2.value="";
            return;
          }
          noFeeWarn.style.display="none";
          baseEl2.style.opacity="1";
          amtEl2.style.opacity="1";
          const base=Number(baseEl2.value.replace(/[^0-9]/g,""));
          if(base>0){
            amtEl2.value=calcCharge(policyEl.value,base).toLocaleString();
          }
        };

        policyEl.onchange=autoCalc;
        // none이 기본 selected가 아니므로 초기상태는 정상
        if(policyEl.value==="none") autoCalc();

        baseEl.oninput=()=>{
          if(policyEl.value==="none") return;
          let v=baseEl.value.replace(/[^0-9]/g,"");
          baseEl.value=v?Number(v).toLocaleString():"";
          autoCalc();
        };
        amtEl.oninput=()=>{
          let v=amtEl.value.replace(/[^0-9]/g,"");
          amtEl.value=v?Number(v).toLocaleString():"";
        };

      }else{
        // 라이드 페이지: 취소/미탑승 선택 + 금액 자동 입력
        contentArea.innerHTML=`
          <div style='margin:5px 0;'>
            <label style='display:block;font-weight:bold;margin-bottom:8px;'>수수료 종류 선택:</label>
            <label style='margin-right:15px;cursor:pointer;font-weight:bold;'>
              <input type='radio' name='chargeType' value='취소' checked> 취소 수수료
            </label>
            <label style='cursor:pointer;font-weight:bold;'>
              <input type='radio' name='chargeType' value='미탑승'> 미탑승 수수료
            </label>
          </div>
          <div style='margin-top:15px;'>
            <label style='display:block;font-weight:bold;margin-bottom:5px;'>청구 수수료 금액:</label>
            <input id='chargeAmount' value='3,000'
              style='width:100%;padding:8px;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;'>
          </div>`;

        const chargeAmtEl=document.getElementById("chargeAmount");
        chargeAmtEl.oninput=()=>{
          let v=chargeAmtEl.value.replace(/[^0-9]/g,"");
          chargeAmtEl.value=v?Number(v).toLocaleString():"";
        };

        // 라디오 전환 시 기본금액 자동 변경
        contentArea.querySelectorAll('input[name="chargeType"]').forEach(r=>{
          r.onchange=()=>{
            chargeAmtEl.value=r.value==="미탑승"?"4,000":"3,000";
          };
        });
      }
    }
  } // ── renderForm 끝

  // ── 탭 이벤트 ────────────────────────────────────────────────────────
  tabLost.onclick=()=>{currentMode="lost";renderForm();};
  tabToll.onclick=()=>{currentMode="toll";renderForm();};
  tabFix.onclick=()=>{currentMode="fix";renderForm();};
  tabLoss.onclick=()=>{currentMode="loss";renderForm();};
  tabRefund.onclick=()=>{currentMode="refund";renderForm();};
  tabCharge.onclick=()=>{currentMode="charge";renderForm();};
  cancelBtn.onclick=()=>{overlay.remove();};
  renderForm();

  // ── 복사 버튼 ────────────────────────────────────────────────────────
  copyBtn.onclick=async function(){

    // 예약 페이지: 정보 저장 후 라이드로 이동 안내
    // 단, isStoredRes=true (라이드→예약 순서)면 이미 라이드 데이터 있으므로 바로 복사
    if(isReservation&&!info.isStoredRes){
      info.lastTab=currentMode;
      localStorage.setItem("tada_res_data",JSON.stringify(info));
      // 수수료환불 탭이고 파생 라이드 없으면 바로 복사 진행
      const noRide=!info.rideId||info.rideId.trim()==="-"||info.rideId.trim()==="";
      const isRefundNoRide=currentMode==="refund"&&noRide;
      // 통행료(toll)도 라이드 항목 파싱 필요 → 예약 먼저 실행 시 저장 후 라이드 유도
      if((currentMode==="fix"||currentMode==="loss"||currentMode==="refund"||currentMode==="toll")&&!isRefundNoRide){
        overlay.remove();
        blinkTitle('💾 예약 정보 저장됨');
        return;
      }
    }

    // ── 분실물 ─────────────────────────────────────────────────────────
    if(currentMode==="lost"){
      const item=document.getElementById("lostItem").value.trim();
      if(!item){alert("습득한 분실물을 입력해주세요.");return;}
      const lostPayType=(document.querySelector('input[name="lostPayType"]:checked')||{}).value||'card';
      const lossPara=lostPayType==='field'
        ?`단, 직접 전달시 드라이버가 영업을 중단하고 이동하여야 하므로, 이동 시간과 거리에 따른 영업손실비 30,000~50,000원이 발생합니다.\n\n10km/1시간 이내 거리 전달인 경우 : 30,000원\n10km/1시간 이상 거리 전달인 경우 : 50,000원\n\n해당 영업손실비는 현장에서 드라이버에게 직접 결제(현금, 계좌이체, 카드 단말기 결제 중 택일)로 진행되는 점 양해 부탁드립니다.`
        :`단, 직접 전달시 드라이버가 영업을 중단하고 이동하여야 하므로, 이동 시간과 거리에 따른 영업손실비 30,000~50,000원이 등록하신 카드에서 자동 결제됩니다.\n\n10km/1시간 이내 거리 전달인 경우 : 30,000원\n10km/1시간 이상 거리 전달인 경우 : 50,000원`;
      const message=`[타다] 분실물 습득 안내\n\n안녕하세요. ${info.name}님\n\n타다를 이용해주셔서 감사합니다.\n\n${info.dateTime}에 ${info.actionWord}하신 [ ${info.departure} > ${info.destination} ] 운행 건의 드라이버 측에서 분실물 [${item}]을 습득하여 안내드립니다.\n\n하차 완료 후 3일 이내 분실물 발생 인지하신 경우, 앱 내 이용내역 > 상세 페이지 > [분실물 찾기] 기능을 통해서 드라이버와 소통하여 확인 하실 수 있습니다.\n\n해당 드라이버 퇴근 또는 운행 중일 경우 통화 연결이 되지 않을 수 있으므로 메세지 발송을 통해 분실물 습득 여부를 문의해주세요.\n\n메세지 발송 후 기다려주시면 드라이버가 기존 운행 종료한 후 통화가 가능할 때 연락을 드릴 예정입니다.\n\n해당 차량에서 분실물이 발견되었을 시, 드라이버 위치에서 가까운 경찰서 또는 차고지(운수사) 등으로의 인계 또는 드라이버가 직접 전달 등의 사항을 조율하여 분실물을 수령하실 수 있습니다.\n\n${lossPara}\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n감사합니다. 타다 팀 드림`;
      await copyRichText(message);
      overlay.remove();
      alert("분실물 안내 복사 완료");

    // ── 통행료 ─────────────────────────────────────────────────────────
    }else if(currentMode==="toll"){
      const checked=[...contentArea.querySelectorAll('input[name="tollCheck"]:checked')];
      const customEnabled=document.getElementById("customCheck").checked;
      const isRefund=document.getElementById("refundCheck").checked;
      if(!checked.length&&!customEnabled&&!isRefund){alert("통행료를 선택해주세요.");return;}

      const names=checked.map(v=>v.value);
      let total=names.reduce((sum,tName)=>sum+tollMap[tName],0);

      if(customEnabled){
        // 여러 기타 직접입력 행 처리
        const customRows=[...contentArea.querySelectorAll('#customRows > div')];
        let addedAny=false;
        for(const row of customRows){
          const cName=row.querySelector('.customName').value.trim();
          const cPrice=Number((row.querySelector('.customPrice').value||'0').replace(/[^0-9]/g,''));
          if(!cName&&!cPrice) continue; // 빈 행은 스킵
          if(!cName){alert("기타 통행료 명칭을 입력해주세요.");return;}
          if(!cPrice||cPrice<=0){alert("기타 통행료 금액을 1원 이상 입력해주세요.");return;}
          names.push(cName);
          total+=cPrice;
          addedAny=true;
        }
        if(!addedAny&&!checked.length&&!isRefund){alert("기타 통행료를 입력해주세요.");return;}
      }

      let oldPRaw=document.getElementById("tollOldPrice").value.trim();
      let newPRaw=document.getElementById("tollNewPrice").value.trim();
      const oldNum=Number(oldPRaw.replace(/[^0-9]/g,""))||0;
      const newNum=Number(newPRaw.replace(/[^0-9]/g,""))||0;
      const oldP=oldNum>0?oldNum.toLocaleString()+"원":"0원";
      const newP=newNum>0?newNum.toLocaleString()+"원":"0원";

      let message="";

      if(isRefund){
        if(!oldPRaw){alert("기존 통행료 금액을 입력해주세요.");return;}
        message=`[타다] 통행료 환불 안내\n\n안녕하세요, ${info.name}님\n타다 고객센터입니다.\n\n${info.timePhrase} [${info.departure} > ${info.destination}]까지 이동하신 탑승 내역 관련하여, 운행 과정에서 결제된 통행료가 잘못 청구된 것을 확인하여 환불 처리 예정임을 안내드립니다.\n\n- 기존 결제 통행료 : ${oldP}\n\n이에 당시 결제된 요금을 취소 후, 통행료를 제외한 요금으로 재결제 예정입니다.\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n감사합니다. 타다 팀 드림`;
        await copyRichText(message);
        overlay.remove();
        alert("통행료 환불 안내 복사 완료");

      }else if(oldNum>0&&newNum>0&&oldNum!==newNum){
        message=`[타다] 통행료 정정 안내\n\n안녕하세요, ${info.name}님\n타다 고객센터입니다.\n\n${info.timePhrase} [${info.departure} > ${info.destination}]까지 이동하신 탑승 내역 관련하여, 운행 과정에서 발생한 유료도로 통행료가 정상적으로 청구되지 않아, 정정 후 재결제 진행 예정인 점 안내드립니다.\n\n- 통행료 : ${total.toLocaleString()}원 (${names.join(", ")})\n- 기존 통행료 : ${oldP}\n- 변경 통행료 : ${newP}\n\n이에 당시 결제된 요금을 취소 후, 변경된 통행료가 포함된 요금을 재결제 예정입니다.\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n감사합니다. 타다 팀 드림`;
        await copyRichText(message);
        overlay.remove();
        alert("통행료 정정 안내 복사 완료");

      }else{
        if(!total){alert("통행료 금액을 확인해주세요.");return;}
        message=`[타다] 통행료 정정 안내\n\n안녕하세요, ${info.name}님\n타다 고객센터입니다.\n\n${info.timePhrase} [${info.departure} > ${info.destination}]까지 이동하신 탑승 내역 관련하여, 운행 과정에서 발생한 유료도로 통행료가 정상적으로 청구되지 않아, 정정 후 재결제 진행 예정인 점 안내드립니다.\n\n- 통행료 : ${total.toLocaleString()}원 (${names.join(", ")})\n\n이에 당시 결제된 요금을 취소 후, 운행료 결제 시 등록되어 있던 결제 수단으로 통행료를 포함한 요금을 재결제 예정입니다.\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n감사합니다. 타다 팀 드림`;
        await copyRichText(message);
        overlay.remove();
        alert("통행료 안내 복사 완료");
      }

    // ── 요금 정정 ───────────────────────────────────────────────────────
    }else if(currentMode==="fix"){
      const selectVal=document.getElementById("fixReason").value;
      let reason=selectVal==="custom"
        ?document.getElementById("customReason").value.trim()
        :selectVal;
      if(selectVal==="custom"&&!reason){alert("정정 사유를 직접 입력해주세요.");return;}
      // 기본(빈값)이면 reason을 공백으로 처리해서 문장이 자연스럽게 이어지게
      const reasonStr=reason?reason+' ':'';
      let oldP=document.getElementById("fixOldPrice").value.trim();
      let newP=document.getElementById("fixNewPrice").value.trim();
      if(!oldP||!newP){alert("기존 금액과 정정 금액을 확인해주세요.");return;}
      if(!oldP.includes("원"))oldP=oldP+"원";
      if(!newP.includes("원"))newP=newP+"원";
      // 항목별 정정 내역 수집
      // 라이드 ID 일치할 때만 fix_items 로드
      const _fixRid=localStorage.getItem('tada_fix_ride_id')||'';
      const _fixRsv=localStorage.getItem('tada_fix_resv_id')||'';
      const _curRid=location.pathname.match(/rides\/([A-Za-z0-9]+)/)?.[1]||'';
      const _curRsv=location.pathname.match(/rideReservations\/([A-Za-z0-9]+)/)?.[1]||'';
      const _fixMatch=(_fixRid&&_curRid&&_fixRid===_curRid)||(_fixRsv&&_curRsv&&_fixRsv===_curRsv);
      let fixItemsRaw='';
      try{fixItemsRaw=(_fixMatch?localStorage.getItem('tada_fix_items'):'')||'';}catch(e){}
      let fixItemsList=[];
      try{if(fixItemsRaw)fixItemsList=JSON.parse(fixItemsRaw);}catch(e){}
      const itemLines=fixItemsList.map((fi,i)=>{
        const fromEl=document.getElementById('fixItem_from_'+i);
        const toEl=document.getElementById('fixItem_to_'+i);
        const fromV=fromEl?fromEl.value.trim():Number(fi.from).toLocaleString();
        const toV=toEl?toEl.value.trim():Number(fi.to).toLocaleString();
        if(!fromV.includes('원')&&fromV){}
        // 항목명 가독성: '거리추가요금' → '거리추가 요금', '부가서비스요금' → '부가서비스 요금'
        const labelFmt=fi.label.replace(/(추가|서비스|수수료)(요금)/, '$1 $2')
          .replace(/톨게이트/g, '통행료');
        return `${labelFmt} : ${fromV.includes('원')?fromV:fromV+'원'} > ${toV.includes('원')?toV:toV+'원'}`;
      }).join('\n');
      const itemSection=itemLines?`\n\n${itemLines}`:'';

      const isMinFareReason=selectVal==="GPS 이상으로 인하여"||selectVal==="경로 우회로 인하여";
      // 정정 금액이 예상요금과 일치하는지 확인
      const newPNum=Number(newP.replace(/[^0-9]/g,''));
      const estPNum=Number(estPrice)||0;
      const isEstMatch=estPNum>0&&newPNum===estPNum;
      const introLine=isEstMatch
        ?`이에 드라이버 요청에 따라 호출 시 확인하시었던 ${newP}으로 결제요금 정정하여 재결제 진행하고자 합니다`
        :isMinFareReason
          ?`이에 드라이버 요청에 따라 잠시 후 최초 호출 시 안내되었던 예상 최저 요금인 ${newP}으로 이용요금 정정하여 재결제 진행하고자 합니다`
          :`이에 드라이버 요청에 따라 잠시 후 ${newP}으로 결제요금 정정하여 재결제 진행하고자 합니다`;
      // ✅ Fix: "타자가" → "타다가" 오타 수정
      const message=`[타다] 이용요금 결제정정 안내\n\n안녕하세요. ${info.name}님 \n\n${info.timePhrase} [${info.departure} > ${info.destination}] 운행 건 요금이 당시 ${reasonStr}정상적으로 청구되지 않은 것을 확인하였습니다.\n\n${introLine}\n\n기존 결제 금액 : ${oldP} \n정정 결제 금액 : ${newP}${itemSection}\n\n※ 위 금액은 할인 및 크레딧 미적용 기준으로 안내드린 금액이며, 실제 재결제 시 적용 중인 할인·크레딧이 반영되어 청구됩니다.\n\n위 결제요금은 잠시 후 운행료 결제 시 등록되어 있던 카드로 재결제 예정입니다. \n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n앞으로도 편안하고 안전한 이동을 제공하는 타다가 되도록 노력하겠습니다.\n\n감사합니다. 타다 팀 드림`;
      await copyRichText(message);
      overlay.remove();
      alert("요금 정정 안내 복사 완료");

    // ── 영손비 ─────────────────────────────────────────────────────────
    }else if(currentMode==="loss"){
      const typeRadio=document.querySelector('input[name="contamType"]:checked').value;
      let priceVal=document.getElementById("lossPrice").value.trim();
      if(!priceVal){alert("금액을 입력해주세요.");return;}
      if(!priceVal.includes("원"))priceVal=priceVal+"원";
      let message="";
      if(typeRadio==="분실물"){
        const itemName=document.getElementById("lossItemName")?.value.trim();
        if(!itemName){alert("습득 분실물 명칭을 입력해주세요.");return;}
        message=`[타다] 분실물 전달 영업손실비 발생 안내\n\n안녕하세요. ${info.name}님\n타다를 이용해주셔서 감사합니다.\n\n${info.timePhrase} 운행건 탑승 중 발생한 분실물[${itemName}]을 드라이버가 직접 전달 완료한 내용 확인되어 안내 드립니다.\n\n등록된 결제 수단으로 영업손실비 ${priceVal}이 결제될 예정이오니, 이용에 참고 부탁드립니다.\n\n타다 고객센터 서비스 주요 안내 <분실물 발생>에서 자세한 내용 확인하실 수 있습니다.\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n감사합니다. 타다 팀 드림`;
      }else{
        message=`[타다] 특수 세차비용 청구 안내\n\n안녕하세요. ${info.name}님\n타다를 이용해주셔서 감사합니다.\n\n${info.timePhrase} [${info.departure} > ${info.destination}]까지 이동 중 ${typeRadio}으로 영업손실비 ${priceVal}이 발생하였습니다.\n\n추가적으로 오염 영업 손실 비용은 실제 호출하신 계정의 등록된 결제 수단으로만 결제가 가능한 점 양해 부탁드립니다.\n\n해당 차량 이용 시 발생한 오염 관련 증빙사진이 확인되어 잠시 후, 운행료 결제 시 등록되어 있던 카드로 결제 예정입니다.\n\n보다 쾌적한 탑승 환경을 위한 차량 세차, 복구를 위한 휴업 영업손실비에 대한 청구액으로 안내 드린 내용은 타다 이용 약관에 의거하며 타다 도움말 <이동 중 문제 발생>에서 자세한 내용을 확인하실 수 있습니다.\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n감사합니다. 타다 팀 드림`;
      }
      await copyRichText(message);
      overlay.remove();
      alert("영업손실비 청구 안내 복사 완료");

    // ── 수수료 환불 ─────────────────────────────────────────────────────
    }else if(currentMode==="refund"){
      const refType=document.querySelector('input[name="refundType"]:checked').value;
      let refPrice=document.getElementById("refundPrice").value.trim();
      if(!refPrice){alert("환불 금액을 입력해주세요.");return;}
      if(!refPrice.includes("원"))refPrice=refPrice+"원";
      const message=`[타다] ${refType} 환불 정정 안내\n\n안녕하세요. ${info.name}님\n타다 고객센터입니다.\n\n${info.timePhrase} [${info.departure} > ${info.destination}] 이동 요청하신 호출 건 관련하여 안내드립니다.\n\n발생된 ${refType} [${refPrice}]이 해당 드라이버의 요청으로 결제 취소 진행되어 안내드립니다\n\n(기존 결제 취소 환불은 카드사에 따라 승인까지 최대 5일정도 소요될 수 있습니다)\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n이용에 불편을 드려 대단히 죄송합니다.\n\n앞으로도 편안하고 안전한 이동을 제공하는 타다가 되도록 노력하겠습니다.\n\n감사합니다. 타다 팀 드림`;
      await copyRichText(message);
      overlay.remove();
      alert(`${refType} 환불 정정 안내 복사 완료`);

    // ── 수수료 청구 ─────────────────────────────────────────────────────
    }else if(currentMode==="charge"){

      if(isResvCharge){
        const policyEl=document.getElementById("chargePolicy");
        const policyVal=policyEl.value;

        // 수수료 미발생 케이스 차단
        if(policyVal==="none"){
          alert("🛑 드라이버 배정 10분 전 취소는 수수료가 발생하지 않습니다.\n청구 불가 케이스입니다.");
          return;
        }
        let chargeBase=document.getElementById("chargeBase").value.trim();
        let chargeAmt=document.getElementById("chargeAmount").value.trim();

        if(!chargeBase){alert("예약 확정 요금을 입력해주세요.");return;}
        if(!chargeAmt){alert("청구 수수료 금액을 입력해주세요.");return;}
        if(!chargeBase.includes("원"))chargeBase=chargeBase+"원";
        if(!chargeAmt.includes("원"))chargeAmt=chargeAmt+"원";

        const policyMap={
          "10pct":"출발 예정 시각으로부터 12시간 ~ 9시간 이내 취소 시, 확정요금의 10%가 부과됩니다. (최대 5,000원)",
          "50pct":"출발 예정 시각으로부터 9시간 ~ 2시간 이내 취소 시, 확정요금의 50%가 부과됩니다. (최대 10,000원)",
          "80pct":"출발 예정 시각으로부터 2시간 이내 취소 시, 확정요금의 80%가 부과됩니다. (최대 20,000원)",
          "100pct":"출발 예정 시각으로부터 10분 이후 연락 두절 또는 미탑승 시, 확정요금의 100%가 부과됩니다. (최대 30,000원)"
        };

        const message=`[타다] 예약 호출 취소 수수료 결제 안내\n\n안녕하세요, ${info.name}님\n타다 고객센터입니다.\n\n${info.timePhrase} [${info.departure} > ${info.destination}] 예약 호출 건에 대하여 안내드립니다.\n\n해당 예약 건은 드라이버 배정 이후 고객님의 요청으로 취소되어, 일반 예약 약관에 따라 취소 수수료가 부과되었습니다.\n\n이에 따라 일반 예약 약관에 의거하여 아래 내역으로 취소 수수료 결제 진행 예정인 점 안내드립니다.\n\n예약 시 확정 요금 : ${chargeBase}\n취소수수료 결제 요금 : ${chargeAmt}\n\n**${policyMap[policyVal]}\n\n예약 호출 건을 수행하기 위해 운행 시간 앞/뒤로 운행을 중단하고 고객님의 예약 호출 건을 준비함에 따라 청구되는 점 양해 부탁드리며,\n드라이버 측 취소와 함께 자동 발송되는 안내문은 타다 고객님의 이용의사 철회 및 미탑승 사유이신 경우 해당되지 않는 점 참고 부탁드립니다.\n\n예약 호출 수수료 관련하여 [일반 예약] 요금&수수료 정책에서 자세한 내용 확인하실 수 있습니다.\n\n잠시 후 결제가 진행될 예정입니다.\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n앞으로도 편안하고 안전한 이동을 제공하는 타다가 되도록 노력하겠습니다.\n\n감사합니다. 타다 팀 드림`;
        await copyRichText(message);
        overlay.remove();
        alert("예약 취소 수수료 청구 안내 복사 완료");

      }else{
        // 라이드: 취소 vs 미탑승 분기
        const chargeType=document.querySelector('input[name="chargeType"]:checked').value;
        let chargeAmt=document.getElementById("chargeAmount").value.trim();
        if(!chargeAmt){alert("청구 수수료 금액을 입력해주세요.");return;}
        if(!chargeAmt.includes("원"))chargeAmt=chargeAmt+"원";

        let message="";
        if(chargeType==="취소"){
          message=`[타다] 취소 수수료 결제 안내\n\n안녕하세요. ${info.name}님\n타다 고객센터입니다.\n\n${info.timePhrase} [${info.departure} > ${info.destination}] 차량 호출 건 관련하여 안내드립니다.\n\n드라이버 배정 후 고객님의 요청으로 운행이 취소되어 취소 수수료 [${chargeAmt}]가 청구되었습니다.\n\n잠시 후 호출 건에 대한 취소 수수료 [${chargeAmt}]이 결제될 예정으로, 취소 수수료의 경우 타다에 등록된 결제 수단으로 결제될 예정인 점 안내드립니다.\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n앞으로도 편안하고 안전한 이동을 제공하는 타다가 되도록 노력하겠습니다.\n\n감사합니다. 타다 팀 드림`;
        }else{
          message=`[타다] 미탑승 수수료 결제 안내\n\n안녕하세요. ${info.name}님\n타다 고객센터입니다.\n\n${info.timePhrase} [${info.departure} > ${info.destination}] 차량 호출 건 관련하여 안내드립니다.\n\n당시 드라이버가 고객님께서 요청하신 탑승지에 도착하여 대기하였으나, 고객님의 미탑승으로 운행이 종료되어 미탑승 수수료 [${chargeAmt}] 청구되었습니다.\n\n잠시 후 호출 건에 대한 미탑승 수수료 [${chargeAmt}]이 결제될 예정으로, 미탑승 수수료의 경우 타다에 등록된 결제 수단으로 결제될 예정인 점 안내드립니다.\n\n안내드린 내용에 대해 궁금하신 사항이 있으실 경우, 타다 앱 내 고객센터 > 문의하기를 통해 남겨주시면 감사하겠습니다.\n\n앞으로도 편안하고 안전한 이동을 제공하는 타다가 되도록 노력하겠습니다.\n\n감사합니다. 타다 팀 드림`;
        }
        await copyRichText(message);
        overlay.remove();
        alert(`${chargeType} 수수료 청구 안내 복사 완료`);
      }
    }
  };
    }

  /* 리치 클립보드 (text/html + text/plain) */
  function copyRich(html, plain) {
    let ok = false;
    try {
      const fn = e => { e.clipboardData.setData('text/html', html); e.clipboardData.setData('text/plain', plain); e.preventDefault(); };
      document.addEventListener('copy', fn, { once: true });
      ok = document.execCommand('copy');
      if (!ok) document.removeEventListener('copy', fn);
    } catch (e) { ok = false; }
    if (!ok) copyText(plain);
  }
  function copyText(val) {
    const ta = el('textarea', 'position:fixed;top:-9999px;'); ta.value = val;
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * 5. 공용 토스트
   * ═══════════════════════════════════════════════════════════════════════ */
  function toast(msg) {
    onReady(() => {
      const t = el('div', 'position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:1000001;background:#0a7d72;color:#fff;padding:8px 16px;border-radius:20px;font-size:12.5px;font-weight:bold;box-shadow:0 4px 14px rgba(0,0,0,.25);font-family:-apple-system,sans-serif;', msg);
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 2200);
    });
  }

})();

/* ─────────────────────────────────────────────────────────────────────────
 * 마이그레이션 로드맵 (권장 순서)
 *
 * 0단계 — 이 파일 설치, 기존 북마클릿과 병행 사용 (충돌 없음: 키가 다름)
 * 1단계 — GM_setValue('hb_api_log', true) 켜고 라이드/예약 상세를 열어
 *          콘솔에서 실제 API 엔드포인트·JSON 구조 파악
 * 2단계 — captureFromDom의 TODO에 꿀통 파싱 이식 → 북마클릿 없이 캡처 완결
 *          (또는 API 구조가 좋으면 곧바로 captureFromApi 작성, DOM 파싱 생략)
 * 3단계 — zendesk.html의 인입 파싱·멘트 칩·슬랙 적재를 패널로 이식,
 *          MENTS 배열을 ments.json으로 추출
 * 4단계 — 꿀빠는 곰(index.html)도 GM 스토리지 읽기로 전환하면
 *          tada_last_bee_tab/fix 키 릴레이도 봉투 하나로 흡수 가능
 * 5단계 — 팀 배포: 레포 raw URL로 설치 링크 공유, @updateURL이 자동 업데이트
 *          (기존 patch_notes.html 로더의 역할을 Tampermonkey가 대신함)
 * ───────────────────────────────────────────────────────────────────────── */
