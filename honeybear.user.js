// ==UserScript==
// @name         🍯 허니베어 (honeybear)
// @namespace    https://github.com/zyersndogpig/honeybear
// @version      0.2.0
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
  console.log('%c[HB] 허니베어 v0.2.0 로드됨 —', 'color:#0a7d72;font-weight:bold;', location.hostname);

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
    function _locName(l) { return (l && (l.name || l.address)) || ''; }
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
     * → zendesk.html 안의 MENTS 배열을 레포의 ments.json으로 옮기면
     *   멘트 수정 = json 커밋만으로 끝. (캐시 10분, 실패 시 캐시 폴백) */
    const MENTS_URL = 'https://raw.githubusercontent.com/zyersndogpig/honeybear/main/ments.json';
    function loadMents(cb) {
      const cached = GM_getValue('hb_ments_cache', null);
      const at = GM_getValue('hb_ments_at', 0);
      if (cached && Date.now() - at < 10 * 60 * 1000) { cb(JSON.parse(cached)); return; }
      GM_xmlhttpRequest({
        method: 'GET', url: MENTS_URL + '?t=' + Date.now(),
        onload: r => {
          try {
            const j = JSON.parse(r.responseText);
            GM_setValue('hb_ments_cache', r.responseText);
            GM_setValue('hb_ments_at', Date.now());
            cb(j);
          } catch (e) { cb(cached ? JSON.parse(cached) : []); }
        },
        onerror: () => cb(cached ? JSON.parse(cached) : [])
      });
    }

    /* 토큰 치환 — 봉투에서 직접. {lossAmount} {toll} 등이 공짜로 생긴다 */
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
        rideLine: (IS_RESV ? (dt + ' 탑승하시어 ') : (dt + '에 호출하시어 ')) + route
      };
    }
    function fillTokens(text, c) {
      const T = tokensOf(c);
      return (text || '').replace(/\{(\w+)\}/g, (w, k) => (T[k] != null && T[k] !== '') ? T[k] : '[ ]');
    }

    /* 라이브 케이스 카드 — 최소 구현.
     * 기존 티켓뷰의 인입 파싱·멘트 칩·슬랙 적재는 이 패널 안으로 그대로 이식하면 된다.
     * (customerMsg 파싱, scoreMent, ID 대조 로직은 zendesk.html에서 복붙 수준) */
    function fresh(ts) {
      if (!ts) return '';
      const m = Math.round((Date.now() - ts) / 60000);
      return m < 1 ? '방금' : m + '분 전';
    }
    function renderCard(box, c) {
      const has = !!(c && c.ts);
      const stale = has && (Date.now() - c.ts > 30 * 60 * 1000);
      const rows = !has ? '' : [
        ['일시', c.trip.dateTime], ['출발', c.trip.departure], ['도착', c.trip.destination],
        ['이름', c.trip.name], ['총요금', won(c.fare.total)], ['예상요금', won(c.fare.est)],
        ['탄력', c.fare.surge ? c.fare.surge + '%' : ''], ['취소료', won(c.fare.cancel)],
        ['영손비', won(c.fare.loss)],
        ['정정', c.fare.fix ? (won(c.fare.fix.old) + ' → ' + won(c.fare.fix.new)) : ''],
        ['라이드', c.ids.ride], ['예약', c.ids.resv], ['유저', c.ids.user], ['파트너', c.ids.driver]
      ].map(r => `<div style="color:#7b857f;">${r[0]}</div><div style="word-break:break-all;color:${r[1] ? '#243027' : '#c0c7c4'};">${r[1] || '—'}</div>`).join('');
      box.innerHTML =
        `<div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:bold;color:#0a5d54;">🍯 케이스
          <span style="font-size:9.5px;padding:1px 6px;border-radius:20px;color:#fff;background:${!has ? '#c3c9c6' : stale ? '#d97706' : '#0a7d72'};">
            ${!has ? '데이터 없음' : fresh(c.ts) + (stale ? ' · 오래됨' : '')}
          </span>
          <button id="hb_clear" style="margin-left:auto;border:none;background:transparent;color:#7b857f;font-size:10px;cursor:pointer;">비우기</button>
        </div>
        ${has ? `<div style="display:grid;grid-template-columns:44px 1fr;gap:1px 8px;margin-top:6px;font-size:10.5px;line-height:1.5;">${rows}</div>` : ''}`;
      const cb = $('#hb_clear', box);
      if (cb) cb.onclick = () => { HBStore.clearCase(); renderCard(box, HBStore.emptyCase()); };
    }

    onReady(() => {
      const panel = el('div',
        'position:fixed;top:16px;right:16px;width:300px;z-index:999999;background:#fff;border:1px solid #e6eae8;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);padding:12px 14px;font-family:-apple-system,sans-serif;display:none;');
      const card = el('div');
      panel.appendChild(card);
      document.body.appendChild(panel);

      const btn = el('button', 'position:fixed;right:18px;bottom:18px;z-index:999999;width:44px;height:44px;border-radius:50%;border:none;background:#0a7d72;color:#fff;font-size:19px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;', '🎫');
      btn.title = '허니베어 패널';
      btn.onclick = () => {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        renderCard(card, HBStore.loadCase());
      };
      document.body.appendChild(btn);

      // ★ 실시간 동기화: admin 탭에서 캡처하면 열려있는 패널이 즉시 갱신
      HBStore.onChange(c => {
        renderCard(card, c || HBStore.emptyCase());
        if (panel.style.display === 'none') toast('🍯 새 케이스 수신');
      });

      // 멘트 로드 확인용 (이식 시 칩 렌더링으로 교체)
      loadMents(m => console.log('[HB] ments loaded:', m.length ?? 0, '— fillTokens 예시:', fillTokens('{rideLine} / 영손비 {lossAmount}', HBStore.loadCase())));
    });
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
