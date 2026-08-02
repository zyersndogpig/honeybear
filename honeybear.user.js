// ==UserScript==
// @name         🍯 허니베어 (honeybear)
// @namespace    https://github.com/zyersndogpig/honeybear
// @version      0.5.0
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
  console.log('%c[HB] 허니베어 v0.5.0 로드됨 —', 'color:#0a7d72;font-weight:bold;', location.hostname);

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
    /* 고객 인입 파싱 — 원본 zendesk.html 로직 그대로 (검증된 코드, 축약 없음) */
    /* 고객 인입 파싱 — 실제 DOM 구조(.zd-comment) 검증 기반.
     * B 진단으로 확인: .zd-comment 각각의 작성자에 'TADA'가 있으면 상담사 답변, 없으면 고객 인입.
     * 메시징 티켓은 'Web User' 블록 분리, 그 외(이메일/웹양식)는 코멘트 순회. */
    function parseInboundOriginal() {
      const msgs = [];
      const isNoise = ml => (!ml || ml === '•' || ml === 'A form was sent:' || ml === '내부' ||
        ml === '드라이버 상담사' || /^TADA /.test(ml) || /^Web User [a-f0-9]/.test(ml) ||
        ml === '대화' || /님과의 대화$/.test(ml) ||
        /^메시징을 통해$|^웹 양식을 통해$|^이메일을 통해$|^전화를 통해$|^티켓 요약 보기$|^대화 로그$/.test(ml) ||
        /^(오늘|어제|그제|월요일|화요일|수요일|목요일|금요일|토요일|일요일)\s*\d{1,2}:\d{2}$/.test(ml) ||
        /^\d{1,2}:\d{2}$/.test(ml) || /^메시지 작성기$|^메시징$|^보내기$/.test(ml) ||
        /^존함을 말씀|^필요시 추가확인|^사진 또는 자료/.test(ml) ||
        /^상담 중인 날짜|^감사합니다|^오늘도 안전/.test(ml) ||
        /^\d{4}[-.]\d{2}[-.]\d{2}/.test(ml) || /^\d{2}-\d{2}$/.test(ml) ||
        /^\d+분 전$|^\d+시간 전$/.test(ml) ||
        /^오류 제보|^유선 상담 중 자료|^계약 및 해지|^기타$/.test(ml) ||
        /^\d{10,11}$/.test(ml) || /^\d{3,4}-\d{3,4}-\d{4}$/.test(ml));

      try {
        const conv = document.querySelector('[data-test-id="ticket-main-conversation"]') ||
          document.querySelector('[class*="conversation"]') || document.querySelector('main') || document.body;
        const isMessaging = /Web User [a-f0-9]+/.test((conv.innerText || ''));

        if (isMessaging) {
          const all = (conv.innerText || '').split('\n');
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
                if (skipName && ml && !isNoise(ml)) { if (/^[가-힣]{2,5}$/.test(ml)) { skipName = false; j++; continue; } skipName = false; }
                if (!isNoise(ml)) buf.push(ml);
                j++;
              }
              if (buf.length) msgs.push(buf.join('\n').trim());
              i = j;
            } else i++;
          }
        } else {
          // 이메일/웹양식: .zd-comment 순회 — 작성자에 TADA 있으면 상담사 답변이므로 제외
          const comments = document.querySelectorAll('.zd-comment');
          comments.forEach(cm => {
            const box = cm.closest('article, li, [data-comment-id], [class*="event"]') || cm.parentElement;
            const boxTxt = box ? (box.innerText || '') : '';
            const author = (boxTxt.split('\n').map(x => x.trim()).filter(Boolean)[0]) || '';
            // 작성자가 TADA(상담사) 또는 내부 노트면 제외
            if (/TADA|타다 (팀|CS)/i.test(author) || /(^|\n)\s*내부\s*(\n|$)/.test(boxTxt)) return;
            const tmp = document.createElement('div'); tmp.innerHTML = cm.innerHTML;
            let raw = (tmp.innerText || tmp.textContent || '');
            // 전화 상담 코멘트 제외
            if (/전화구분\s*[:：]|통화시간\s*[:：]|발신내선\s*[:：]/.test(raw)) return;
            // 원본 메일 인용부 컷
            const oi = raw.search(/-{2,}\s*원본 메일|원본 메일\s*-{2,}|-{3,}\s*Original/);
            if (oi >= 0) raw = raw.slice(0, oi);
            // 본문에 TADA 아웃바운드 시그니처가 있으면(작성자 판별 실패 대비 이중 안전망) 제외
            if (/타다 팀 드림|타다를 이용해 주셔서|드라이버 센터입니다|안심 운행 도우미/.test(raw)) return;
            const lines = raw.split('\n').map(l => l.trim()).filter(l => l && !isNoise(l) &&
              !/^https?:\/\//.test(l) && !/\.(png|jpe?g|gif|pdf|heic|webp)$/i.test(l) &&
              !/^수신자:$|^자세히 보기$|^원본 메일|^-{3,}/.test(l));
            const msg = lines.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
            if (msg) msgs.push(msg);
          });

          // 코멘트를 하나도 못 잡았으면 제목을 인입 후보로 (웹 양식 대비)
          if (!msgs.length) {
            const sels = ['[data-test-id="ticketHeader-subject"]', 'input[data-test-id="ticket-subject-field"]', 'input[name="subject"]'];
            let subj = '';
            for (const s of sels) { const el = document.querySelector(s); if (el) { subj = (el.value || el.innerText || '').trim(); if (subj) break; } }
            subj = subj.replace(/^\s*\(\d+\)\s*/, '').replace(/\s*[–—\-|·]\s*(VCNC|TADA|타다|Zendesk|젠데스크).*$/i, '').replace(/\s*[.…]{1,3}\s*$/, '').trim();
            if (subj.length > 1) msgs.push(subj);
          }
        }
      } catch (e) { console.warn('[HB] 인입 파싱 오류:', e.message); }

      // 중복 제거 (한쪽이 다른 쪽을 포함하면 긴 쪽 유지)
      const nk = s => (s || '').replace(/[^0-9a-z가-힣]/gi, '').toLowerCase();
      const out = [];
      for (const b of msgs) {
        const bk = nk(b); if (!bk) continue;
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
          <div id="hb_out" class="card" style="display:none;padding:9px 11px;">
            <div class="chead" style="margin-bottom:6px;">🍯 원본 도구 <span id="hb_out_hint" style="font-weight:normal;color:#7b857f;font-size:10px;"></span></div>
            <div class="row" style="gap:6px;">
              <button id="hb_honey" class="ghost" style="flex:1;">🍯 꿀통양식</button>
              <button id="hb_bee" class="ghost" style="flex:1;">🐻 꿀빠는 문자</button>
            </div>
          </div>
          <div class="div" id="hb_out_div" style="display:none;"></div>
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

      /* ── 원본 도구 버튼 (꿀통양식 / 꿀빠는 문자) — ride·resv에서만 활성 ── */
      const outBox = g('hb_out'), outDiv = g('hb_out_div'), outHint = g('hb_out_hint');
      function renderOutput() {
        const c = HBStore.loadCase();
        const isRideResv = c.ids.type === 'ride' || c.ids.type === 'resv';
        outBox.style.display = 'block'; outDiv.style.display = 'block';
        if (!c.ts || !isRideResv) {
          outBox.style.opacity = '0.5';
          g('hb_honey').disabled = true; g('hb_bee').disabled = true;
          outHint.textContent = c.ts ? '(라이드/예약에서 캡처해야 사용 가능)' : '(캡처된 케이스 없음)';
        } else {
          outBox.style.opacity = '1';
          g('hb_honey').disabled = false; g('hb_bee').disabled = false;
          outHint.textContent = '';
        }
      }
      g('hb_honey').onclick = () => { try { hbRunHoneyForm(); } catch (e) { console.warn('[HB] 꿀통 실행 오류:', e.message); toast('🍯 꿀통 실행 오류'); } };
      g('hb_bee').onclick = () => { try { hbRunBeeForm(); } catch (e) { console.warn('[HB] 꿀빠는곰 실행 오류:', e.message); toast('🐻 꿀빠는곰 오류'); } };
      renderOutput();

      /* 열고 닫기 + 실시간 동기화 */
      function toggle() { const open = panel.style.display === 'none'; panel.style.display = open ? 'block' : 'none'; if (open) { renderCard(); draftText = getDraftText(); renderMents(); if (typeof renderOutput==='function') renderOutput(); } }
      btn.onclick = toggle;
      g('hb_x').onclick = () => panel.style.display = 'none';
      document.addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyH') toggle(); if (e.key === 'Escape' && panel.style.display !== 'none') panel.style.display = 'none'; });
      HBStore.onChange(c => { renderCard(); renderMents(); if (typeof renderOutput==='function') renderOutput(); if (panel.style.display === 'none') toast('🍯 새 케이스 수신'); });
      renderCard();
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
  if(false && isFromResv&&!resvId){ // 봉투 환경: 예약 파생이면 resvId가 이미 채워짐
    blinkTitle('⚠️ 예약 페이지에서 실행 필요!');
    alert('⚠️ 예약 파생 라이드예요!\n호출 예약 ID 클릭해서 예약 페이지에서도 한번 더 실행해주세요!');
    return;
  }
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

    // ── 티켓뷰 연동: CTX 스냅샷을 복사물 html에 마커로 심기(오리진 우회) ──
    try{
      const _ck=['tada_msg_data','tada_is_from_resv','tada_is_cash','tada_is_plus','tada_third_party_tag','tada_cancel_fee','tada_total_fare','tada_est_fare','tada_last_user_id','tada_last_driver_id'];
      const _snap={}; _ck.forEach(k=>{const v=localStorage.getItem(k); if(v!=null&&v!=='')_snap[k]=v;});
      const _b64=btoa(unescape(encodeURIComponent(JSON.stringify(_snap))));
      html+='<!--TADACTX:'+_b64+'-->';   // text/html에만, slack용 plain은 그대로
    }catch(e){}

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

    async function hbRunBeeForm() {
      const c = HBStore.loadCase();
      if (!(c && c.ts && (c.ids.type === 'ride' || c.ids.type === 'resv'))) { toast('🐻 라이드/예약 캡처 후 사용하세요'); return; }
      hbSpreadCaseToTada(c);
      toast('🐻 꿀빠는 문자는 다음 단계에서 이식 예정');
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
