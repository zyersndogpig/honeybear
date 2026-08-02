// ==UserScript==
// @name         🍯 허니베어 (honeybear)
// @namespace    https://github.com/zyersndogpig/honeybear
// @version      0.3.1
// @description  꿀통·티켓뷰 통합 유저스크립트 — 클립보드 브릿지 없이 admin↔Zendesk 케이스 실시간 공유
// @match        https://admin.tadatada.in/*
// @match        https://admin.tadatada.com/*
// @match        https://tadatadahelp.zendesk.com/agent/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/zyersndogpig/honeybear/main/honeybear.user.js
// @downloadURL  https://raw.githubusercontent.com/zyersndogpig/honeybear/main/honeybear.user.js
// ==/UserScript==

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
  console.log('%c[HB] 허니베어 v0.3.1 로드됨 —', 'color:#0a7d72;font-weight:bold;', location.hostname);

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
    Object.assign(out.flags, cur.flags);
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
    function _thirdTag(u) {
      const s = u && u.thirdPartyUser ? JSON.stringify(u.thirdPartyUser) : '';
      if (/TOSS/i.test(s)) return '토스 택시타기';
      if (/TMONEY/i.test(s)) return '티머니 고';
      return '';
    }
    /* 주소 단순화: "서울 서초구 잠원동 50" → "서울 서초구 잠원동"
     * (끝의 번지·숫자 토큰 제거. 동/읍/면/가 까지만 남김) */
    function simplifyAddr(addr) {
      if (!addr) return '';
      let s = addr.split('（').join('(').split('）').join(')').trim();
      // 동/읍/면/가/로/길 이 나오면 그 지점까지만 (뒤 번지 컷)
      const m = s.match(/^(.*?[가-힣]+(?:동|읍|면|가))(?:\s|$)/);
      if (m) return m[1].trim();
      // 폴백: 끝에서 숫자·하이픈 토큰 제거
      let parts = s.split(/\s+/);
      while (parts.length && /^[0-9-]+$/.test(parts[parts.length - 1])) parts.pop();
      return parts.join(' ');
    }
    /* 장소 표기: address(행정동)에서 단순화한 게 있으면 우선, 없으면 name */
    function _locName(l) {
      if (!l) return '';
      const byAddr = simplifyAddr(l.address || '');
      return byAddr || l.name || l.address || '';
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
        c.flags.thirdParty = _thirdTag(j.user);
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
        c.flags.thirdParty = _thirdTag(j.rider);
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

    function captureFromDom() {
      const c = HBStore.emptyCase();
      const url = location.href;
      const ride = url.match(/\/rides\/([A-Za-z0-9]+)/);
      const resv = url.match(/\/rideReservations\/([A-Za-z0-9]+)/);
      const user = url.match(/\/users\/([A-Za-z0-9]+)/);
      const drv  = url.match(/\/drivers?\/([A-Za-z0-9]+)/);

      if (user) { c.ids.user = user[1]; c.ids.type = 'user'; }
      else if (drv) { c.ids.driver = drv[1]; c.ids.type = 'driver'; }
      else if (ride) {
        c.ids.type = 'ride'; c.ids.ride = ride[1];
        c.flags.isCash = getRowValue('탑승자').includes('현장결제');
        // TODO: 꿀통 index의 라인업/플러스 감지, 실제요금·영수증 합산,
        //       예상요금, fare items, 예약 파생 감지, saveMsgData('ride') 파싱 이식
      }
      else if (resv) {
        c.ids.type = 'resv'; c.ids.resv = resv[1];
        // TODO: 꿀통의 resv 파싱(취소수수료, 운행정보 행, saveMsgData('resv')) 이식
      }
      else { toast('🍯 라이드/예약/유저/파트너 페이지가 아니에요'); return null; }

      // 써드파티 태그 (유저 페이지)
      if (user) {
        const tp = getRowValue('써드파티 정보');
        if (/TOSS/i.test(tp)) c.flags.thirdParty = '토스 택시타기';
        else if (/TMONEY/i.test(tp)) c.flags.thirdParty = '티머니 고';
      }
      return c;
    }

    function capture() {
      let cur = null;
      try { cur = captureFromApi(); } catch (e) { console.warn('[HB] API 캡처 오류:', e.message); }
      const src = cur ? 'API' : 'DOM';
      if (!cur) cur = captureFromDom();
      if (!cur) return;
      const merged = mergeCase(HBStore.loadCase(), cur);
      HBStore.saveCase(merged);
      toast('🍯 캡처 완료 (' + src + ') → 젠데스크 패널 실시간 갱신');
    }

    /* 플로팅 버튼 — 북마클릿 클릭을 대체 (Alt+H 단축키도 동일) */
    onReady(() => {
      const b = el('button', 'position:fixed;right:18px;bottom:18px;z-index:999999;width:44px;height:44px;border-radius:50%;border:none;background:#0a7d72;color:#fff;font-size:20px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;', '🍯');
      b.title = '허니베어 캡처 (Alt+H)';
      b.onclick = capture;
      document.body.appendChild(b);
      document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyH') capture(); });
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
        rideId: c.ids.ride, resvId: c.ids.resv,
        totalFare: won(c.fare.total), estFare: won(c.fare.est), cancelFee: won(c.fare.cancel),
        surge: c.fare.surge ? (c.fare.surge + '%') : '',
        toll: toll ? won(toll.amt) : '', lossAmount: won(c.fare.loss),
        fareFix: c.fare.fix ? (won(c.fare.fix.old) + ' > ' + won(c.fare.fix.new)) : '',
        fixLines: c.fare.fix ? (c.fare.fix.items || []).map(i => i.label + ' : ' + won(i.from) + ' > ' + won(i.to)).join('\n') : '',
        rideLine: (IS_RESV ? (dt + ' 탑승하시어') : (dt + '에 호출하시어')) + ' ' + route
      };
    }
    function fillTokens(text, c) {
      const T = tokensOf(c);
      return (text || '').replace(/\{(\w+)\}/g, (w, k) => (T[k] != null && T[k] !== '') ? T[k] : '[ ]');
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
    function parseInbound() {
      const msgs = [];
      try {
        const conv = document.querySelector('[data-test-id="ticket-main-conversation"]') ||
          document.querySelector('[class*="conversation"]') || document.querySelector('main') || document.body;
        const raw = (conv.innerText || '');
        const isMessaging = /Web User [a-f0-9]+/.test(raw);
        if (isMessaging) {
          const all = raw.split('\n');
          const cut = all.findIndex(l => l.trim() === '메시지 작성기');
          const lines = cut >= 0 ? all.slice(0, cut) : all;
          let i = 0;
          while (i < lines.length) {
            if (/^Web User [a-f0-9]/.test(lines[i].trim())) {
              let j = i + 1; const buf = []; let skipName = false;
              while (j < lines.length) {
                const ml = lines[j].trim();
                if (ml === '드라이버 상담사' || /^TADA /.test(ml) || /^Web User [a-f0-9]/.test(ml) || ml === '메시지 작성기') break;
                if (/^존함을 말씀/.test(ml)) { skipName = true; j++; continue; }
                if (skipName && ml && !isNoiseLine(ml)) { if (/^[가-힣]{2,5}$/.test(ml)) { skipName = false; j++; continue; } skipName = false; }
                if (!isNoiseLine(ml)) buf.push(ml);
                j++;
              }
              if (buf.length) msgs.push(buf.join('\n').trim());
              i = j;
            } else i++;
          }
        } else {
          // 이메일/일반 티켓: 코멘트 단위로 순회하며 TADA 아웃바운드(상담사 답변) 제외
          const comments = document.querySelectorAll('.zd-comment');
          if (comments.length) {
            comments.forEach(cm => {
              const box = cm.closest('article, li, [data-comment-id], [class*="event"]') || cm.parentElement;
              const boxTxt = box ? box.innerText : '';
              const author = (boxTxt.split('\n').map(x => x.trim()).filter(Boolean)[0]) || '';
              // TADA 발신 or 내부 노트 제외
              if (/^TADA\b/.test(author) || /(^|\n)\s*내부\s*(\n|$)/.test(boxTxt)) return;
              const tmp = document.createElement('div'); tmp.innerHTML = cm.innerHTML;
              let raw = tmp.innerText || tmp.textContent || '';
              // 전화 상담 코멘트 제외
              if (/전화구분\s*[:：]|통화시간\s*[:：]|발신내선\s*[:：]/.test(raw)) return;
              // 원본 메일 인용부 컷
              const oi = raw.search(/-{2,}\s*원본 메일|원본 메일\s*-{2,}|-{3,}\s*Original/);
              if (oi >= 0) raw = raw.slice(0, oi);
              // TADA 아웃바운드 시그니처가 있으면(상담사 답변) 제외
              if (/타다 팀 드림|타다를 이용해 주셔서|안녕하세요\.\s*[가-힣]+\s*파트너님|드라이버 센터입니다|안심 운행 도우미/.test(raw)) return;
              const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !isNoiseLine(l) &&
                !/^https?:\/\//.test(l) && !/\.(png|jpg|jpeg|gif|pdf)$/i.test(l) &&
                !/^수신자:$|^자세히 보기$|^원본 메일|^-{3,}/.test(l));
              const msg = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
              if (msg) msgs.push(msg);
            });
          }
          // 코멘트를 못 찾았으면 제목을 인입 후보로 (웹 양식 티켓 대비)
          if (!msgs.length) {
            const subj = (document.querySelector('[data-test-id="ticketHeader-subject"]') || {}).innerText ||
              (document.querySelector('input[name="subject"]') || {}).value || '';
            const s = (subj || '').replace(/^\s*\(\d+\)\s*/, '').replace(/\s*[–—\-|·]\s*(VCNC|TADA|타다|Zendesk).*$/i, '').trim();
            if (s.length > 1) msgs.push(s);
          }
        }
      } catch (e) {}
      // 중복 제거
      const nk = s => (s || '').replace(/[^0-9a-z가-힣]/gi, '').toLowerCase();
      const out = [];
      for (const b of msgs) { const bk = nk(b); if (!bk) continue;
        const di = out.findIndex(o => { const ok = nk(o); return ok === bk || (ok.length >= 6 && bk.length >= 6 && (ok.includes(bk) || bk.includes(ok))); });
        if (di >= 0) { if (b.length > out[di].length) out[di] = b; } else out.push(b);
      }
      return out;
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
      const reE = /외부\s*ID[\s:：]*([A-Za-z0-9_-]{5,40})/g;
      while ((m = reE.exec(t))) { const id = m[1]; if (/^U[A-Za-z0-9]{8,}$/.test(id)) u.push(id); else if (/^[A-Za-z]{2,4}[0-9]{4,}$/.test(id)) d.push(id); }
      const uniq = a => a.filter((v, i) => v && a.indexOf(v) === i);
      return { user: uniq(u), driver: uniq(d) };
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
        'position:fixed;top:16px;right:16px;width:360px;max-height:92vh;overflow-y:auto;z-index:999999;background:#fff;border:1px solid #e6eae8;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);font-family:-apple-system,sans-serif;color:#243027;display:none;');
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
          #hb_zd_panel textarea,#hb_zd_panel input.s{width:100%;border:1px solid #e6eae8;border-radius:8px;font-family:inherit;color:#243027;padding:8px;font-size:12.5px;line-height:1.6;}
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
          #hb_zd_panel .sel{flex:1;padding:5px 8px;border:1px solid #bfe6de;border-radius:6px;font-size:11.5px;background:#fff;cursor:pointer;}
          #hb_zd_panel .opt{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#0a5d54;cursor:pointer;margin:6px 0;}
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
      btn.title = '허니베어 패널 (Alt+H)';
      document.body.appendChild(btn);

      const g = id => panel.querySelector('#' + id);
      const ZDIDS = collectZdIds(pageSnap);

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
      let blocks = parseInbound();
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
      bu.onclick = () => { party = '이용자'; bu.classList.add('on'); bp.classList.remove('on'); };
      bp.onclick = () => { party = '파트너'; bp.classList.add('on'); bu.classList.remove('on'); };
      // 파트너 자동판별: 젠데스크에 드라이버 링크가 있거나 봉투 파트너ID만 있으면
      if (ZDIDS.driver.length && !ZDIDS.user.length) { party = '파트너'; bp.classList.add('on'); bu.classList.remove('on'); }
      g('hb_slack').onclick = function () {
        const content = contentBox.value.trim();
        const esc = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const html = `<a href="${ticketUrl}">#${TN}</a> ${party} 인입<br><pre style="background:#f3f4f6;padding:8px;border-radius:4px;font-size:12px;white-space:pre-wrap;">${esc}</pre>`;
        const plain = `<${ticketUrl}|#${TN}> ${party} 인입\n\`\`\`\n${content}\n\`\`\``;
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
      g('hb_refresh').onclick = () => { draftText = getDraftText(); blocks = parseInbound(); renderMents(); };
      optBox.onchange = () => {
        if (lastMent && hasOptionalBracket(lastMent.text) && previewEl.value.endsWith(lastSeg)) {
          const seg2 = fillTokens(processBrackets(lastMent.text, optBox.checked), HBStore.loadCase());
          previewEl.value = previewEl.value.slice(0, previewEl.value.length - lastSeg.length) + seg2; lastSeg = seg2;
        }
      };
      g('hb_copy').onclick = function () { copyText(previewEl.value); toast('📋 복사 완료'); const t = this.textContent; this.textContent = '✅ 복사됨'; setTimeout(() => this.textContent = t, 1200); };
      g('hb_clear2').onclick = () => { previewEl.value = ''; lastMent = null; lastSeg = ''; optwrap.style.display = 'none'; optBox.checked = false; addonBox.style.display = 'none'; };

      loadMents(arr => { MENTS = arr; g('hb_mc').textContent = arr.length; renderMents(); });

      /* 열고 닫기 + 실시간 동기화 */
      function toggle() { const open = panel.style.display === 'none'; panel.style.display = open ? 'block' : 'none'; if (open) { renderCard(); draftText = getDraftText(); renderMents(); } }
      btn.onclick = toggle;
      g('hb_x').onclick = () => panel.style.display = 'none';
      document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyH') toggle(); if (e.key === 'Escape' && panel.style.display !== 'none') panel.style.display = 'none'; });
      HBStore.onChange(c => { renderCard(); renderMents(); if (panel.style.display === 'none') toast('🍯 새 케이스 수신'); });
      renderCard();
    });
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
