// ==UserScript==
// @name         🍯 허니베어 (honeybear)
// @namespace    https://github.com/zyersndogpig/honeybear
// @version      0.8.0
// @description  허니베어 로더 — 본체(honeybear.core.js)를 GitHub에서 자동으로 최신 유지. 한 번 설치하면 이후 업데이트 불필요.
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
 * 로더 구조 (patch_notes.html 런타임 로더 패턴의 유저스크립트판)
 *
 *  1) 페이지 로드 즉시: GM 스토리지에 캐시된 본체를 eval로 실행
 *     → document-start 타이밍 보존 (admin API 가로채기가 초기 호출을 놓치지 않음)
 *  2) 동시에 백그라운드: GitHub에서 최신 본체를 받아 캐시 갱신
 *     → 다음 새로고침부터 최신 코드 적용. 커밋만 하면 팀 전체 자동 배포.
 *
 *  이 로더 파일 자체는 앞으로 거의 바뀌지 않습니다. 기능 수정은 전부
 *  honeybear.core.js에서 하고 main에 커밋하세요.
 * ───────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';
  var CORE_URL = 'https://raw.githubusercontent.com/zyersndogpig/honeybear/main/honeybear.core.js';
  var KEY_CODE = 'hb_core_code', KEY_AT = 'hb_core_at';
  var ran = false;

  function runCore(code, src) {
    if (ran || !code) return;
    try { eval(code); ran = true; console.log('%c[HB loader] core 실행 (' + src + ')', 'color:#0a7d72;'); }
    catch (e) { console.warn('[HB loader] core 실행 실패(' + src + '):', e); }
  }

  // 1) 캐시본 즉시 실행 — 최초 설치 직후에만 캐시가 비어 있음
  runCore(GM_getValue(KEY_CODE, ''), '캐시 · ' + new Date(GM_getValue(KEY_AT, 0)).toLocaleString());

  // 2) 최신본 백그라운드 갱신 (?t= 캐시버스팅 — raw CDN 5분 캐시 우회)
  GM_xmlhttpRequest({
    method: 'GET', url: CORE_URL + '?t=' + Date.now(),
    onload: function (r) {
      var code = r.responseText || '';
      // 안전장치: 200 아님 / 비정상적으로 짧음 / 허니베어 코드가 아님 → 캐시 유지
      if (r.status !== 200 || code.length < 5000 || code.indexOf('허니베어') < 0) return;
      var changed = code !== GM_getValue(KEY_CODE, '');
      if (changed) { GM_setValue(KEY_CODE, code); GM_setValue(KEY_AT, Date.now()); }
      if (!ran) runCore(code, '원격 · 최초 설치');
      else if (changed) console.log('%c[HB loader] 새 core 캐시됨 — 새로고침하면 적용됩니다.', 'color:#0a7d72;font-weight:bold;');
    },
    onerror: function () { if (!ran) console.warn('[HB loader] core 로드 실패 — 네트워크/GitHub 확인 후 새로고침'); }
  });

  // 수동 강제 갱신 (Tampermonkey 메뉴): 캐시 비우고 새로고침 → 즉시 최신본
  try {
    GM_registerMenuCommand('🔄 허니베어 본체 강제 갱신', function () {
      GM_deleteValue(KEY_CODE); GM_deleteValue(KEY_AT); location.reload();
    });
  } catch (e) {}
})();
