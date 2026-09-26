// ==UserScript==
// @name         Kupla chat-historia (vedä kuplista alas)
// @namespace    kupla-relab
// @version      0.1.0
// @description  Vanhan Habbo-clientin chat-historia: tartu huoneen chat-kuplaan ja vedä alas, niin aiemmat kuplat tulevat näkyviin. Vedä takaisin ylös tai paina X / Esc, niin live-chat palaa.
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==
//
// PROTOTYYPPI Resille (PR tulee myöhemmin). Toimii myös konsoliin liitettynä: kopioi koko tiedosto
// kupla.cc-välilehden konsoliin (F12 → Console) ja Enter. Uudelleen liittäminen poistaa edellisen
// version kuuntelijat ja DOMin ensin (idempotentti).
//
// MALLI (Habbo-Sky @ wired2-ngh):
//   Vetäminen alas on VANHAN roomchat-widgetin mekanismi, ei freeflowchatin:
//     src/com/sulake/habbo/ui/widget/roomchat/RoomChatItem.as        — mouse DOWN kuplassa aloittaa
//     src/com/sulake/habbo/ui/widget/roomchat/RoomChatHistoryViewer.as — 3 px hystereesi (_Str_14515=3),
//                                                                       sen jälkeen chat-alue kasvaa vedon verran
//     src/com/sulake/habbo/ui/widget/roomchat/RoomChatHistoryPulldown.as — 39 px tartuntapalkki + X, fade 250/150 ms
//     src/com/sulake/habbo/ui/widget/roomchat/RoomChatWidget.as       — mouse UP: jos alareuna jäi perus-
//                                                                       korkeuden yläpuolelle → sulkeutuu, live palaa
//   freeflowchat/history/visualization/ChatHistoryTray.as on sivulaatikko, joka avataan toggle-kutsulla;
//   sen ChatHistoryScrollView.as antaa vetovierityksen (topY = alku − dy) ja 40 px/rulla-askel.
//   Tämä skripti: avaus = vanha pulldown, vieritys avoimessa paneelissa = freeflowin vetovieritys.
//
// MITEN:
//   • pointerdown VAIN `.nitro-chat-widget .bubble-container`-elementissä (chat-kerros on muuten
//     pointer-events:none, joten tyhjä alue ja huone eivät koskaan käynnistä vetoa).
//   • Alle 3 px liike = tavallinen klikkaus: mitään ei tapahdu, kupla valitsee puhujan kuten ennenkin.
//   • Yli 3 px ALAS = paneeli avautuu ja sen alareuna seuraa osoitinta. Vedon aikana hiiren liike ja
//     vapautus pysäytetään window-capture-vaiheessa, joten huone ei saa niitä (ei kävelyä, ei valintaa).
//   • Vapautus alkuperäisen kuplan korkeuden yläpuolella → sulkeutuu (kuten SWF). Muuten jää auki.
//   • Auki: vedä listaa ylös/alas tai rullaa; vedä alapalkkia muuttaaksesi kokoa; X tai Esc sulkee.
//
// HISTORIAN LÄHDE: clientin oma välimuisti localStorage `kuplafix.chatHistoryCache.<oma userId>`
//   (DarkUI src/api/chat-history/ChatHistoryCache.ts; tallennetaan 1 s jokaisen viestin jälkeen,
//   src/hooks/chat-history/useChatHistory.ts). Jos välimuisti on pois päältä, käytetään skriptin
//   omaa puskuria kuplista, jotka se on nähnyt latautumisensa jälkeen.
//   HUOM: viestien HTML renderöidään innerHTML:llä täsmälleen kuten client itse tekee samalle datalle
//   (dangerouslySetInnerHTML ChatWidgetMessageView.tsx / ChatHistoryView.tsx) — sama luottamustaso.
//
// KONSOLI: window.__kuplaChatHistoria.open() · .close() · .state() · .destroy()
(function () {
  'use strict';

  const NS = '__kuplaChatHistoria';
  const VERSION = '0.1.0';
  if (window[NS] && typeof window[NS].destroy === 'function') {
    try { window[NS].destroy(); } catch (e) { /* vanha versio voi olla rikki */ }
  }

  const CFG = {
    HYSTERESIS: 3,        // SWF RoomChatHistoryViewer._Str_14515
    ABORT_DX: 12,         // sivuttaisliike ennen avautumista = ei vetoa
    GRAB_H: 22,           // tartuntapalkki (SWF 39 px, tässä matalampi)
    MIN_H: 60,
    BOTTOM_RESERVE: 110,  // SWF: työpöytä − 39 − 40; DarkUI:n alapalkki ~55 px
    FADE_IN: 250,         // SWF RoomChatHistoryPulldown FADE_IN_MS
    FADE_OUT: 150,        // SWF FADE_OUT_MS
    CHUNK: 150,           // kerralla renderöitävät rivit
    RELOAD_DEBOUNCE: 1300,// client tallentaa välimuistin 1000 ms viiveellä
    POLL_MS: 3000,
    DOM_BUFFER: 1000,
  };

  const ac = new AbortController();
  const on = (el, type, fn, capture) => el.addEventListener(type, fn, { capture: !!capture, passive: false, signal: ac.signal });
  const intervals = [];
  const timeouts = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timeouts.delete(t); fn(); }, ms); timeouts.add(t); return t; };

  // ---------------------------------------------------------------- tyylit
  const STYLE_ID = 'kch-style';
  const css = `
.kch-panel{position:absolute;left:0;top:0;width:100%;height:0;z-index:21;display:none;flex-direction:column;
  background:rgba(16,20,27,.84);opacity:0;transition:opacity ${CFG.FADE_IN}ms ease;pointer-events:auto;
  box-shadow:0 3px 10px rgba(0,0,0,.55);font-family:inherit}
.kch-panel.kch-open{display:flex}
.kch-panel.kch-visible{opacity:1}
.kch-panel.kch-closing{transition:opacity ${CFG.FADE_OUT}ms ease;opacity:0}
.kch-list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:6px 0 4px;cursor:grab;
  user-select:none;scrollbar-width:thin;scrollbar-color:#6b7482 transparent}
.kch-list.kch-dragging{cursor:grabbing}
.kch-row{display:flex;align-items:flex-start;gap:6px;max-width:660px;margin:0 auto 3px;padding:0 10px}
.kch-time{flex:0 0 auto;min-width:36px;text-align:right;color:#aeb6c2;font-size:11px;line-height:26px}
.kch-panel .bubble-container.kch-bubble{position:relative!important;left:auto!important;top:auto!important;
  transition:none!important;pointer-events:auto;width:fit-content;max-width:600px}
.kch-panel .kch-bubble .chat-bubble{max-width:600px}
.kch-sep{max-width:660px;margin:6px auto;padding:0 10px;color:#c9d1dc;font-size:11px;text-align:center;opacity:.8}
.kch-sep span{background:rgba(255,255,255,.08);border-radius:8px;padding:1px 10px}
.kch-more{color:#8f98a6;font-size:11px;text-align:center;padding:2px 0 6px}
.kch-empty{color:#c9d1dc;font-size:12px;text-align:center;padding:16px}
.kch-grab{flex:0 0 ${CFG.GRAB_H}px;height:${CFG.GRAB_H}px;position:relative;cursor:ns-resize;display:flex;
  align-items:center;justify-content:center;background:linear-gradient(#3b4351,#262c36);border-top:1px solid #5b6472}
.kch-grab-in{position:relative;width:100%;max-width:660px;height:100%;display:flex;align-items:center;justify-content:center}
.kch-grip{width:64px;height:4px;border-top:2px solid #8e97a6;border-bottom:2px solid #8e97a6;pointer-events:none}
.kch-info{position:absolute;left:10px;top:0;line-height:${CFG.GRAB_H}px;color:#aab3c0;font-size:11px;pointer-events:none}
.kch-close{position:absolute;right:6px;top:2px;width:18px;height:18px;padding:0;border:0;border-radius:3px;
  background:#b23a3a;color:#fff;font:bold 13px/18px sans-serif;cursor:pointer}
.kch-close:hover{background:#d04848}
.nitro-chat-widget .bubble-container{touch-action:none}
`;

  // ---------------------------------------------------------------- lähde
  const KEY_RE = /^kuplafix\.chatHistoryCache\.(\d+|anonymous)$/;
  const ownUserId = () => {
    try {
      const re = window.NitroDevTools && window.NitroDevTools.roomEngine;
      const sdm = re && re._sessionDataManager;
      const id = sdm && (sdm.userId || (sdm._userId));
      return Number.isInteger(id) && id > 0 ? id : null;
    } catch (e) { return null; }
  };
  const pickKey = () => {
    let keys = [];
    try { keys = Object.keys(localStorage).filter(k => KEY_RE.test(k)); } catch (e) { return null; }
    if (!keys.length) return null;
    const uid = ownUserId();
    if (uid && keys.includes('kuplafix.chatHistoryCache.' + uid)) return 'kuplafix.chatHistoryCache.' + uid;
    // muuten: tuorein savedAt (nykyinen käyttäjä tallentaa jatkuvasti)
    let best = null, bestAt = -1;
    for (const k of keys) {
      let at = 0;
      try { const m = /"savedAt":(\d+)/.exec((localStorage.getItem(k) || '').slice(0, 80)); at = m ? +m[1] : 0; } catch (e) {}
      if (at > bestAt) { bestAt = at; best = k; }
    }
    return best;
  };

  const loadCache = () => {
    const key = pickKey();
    if (!key) return null;
    let o;
    try { o = JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    const avatars = (o && Array.isArray(o.avatars)) ? o.avatars : [];
    const msgs = Array.isArray(o) ? o : ((o && o.messages) || []);
    const entries = msgs.filter(m => m && typeof m === 'object').map(m => {
      const style = Number.isFinite(+(m.style ?? m.styleId)) ? +(m.style ?? m.styleId) : 0;
      const chatType = Number.isFinite(+m.chatType) ? +m.chatType : 0;
      return {
        type: +m.type === 2 ? 2 : (+m.type === 3 ? 3 : 1),
        name: String(m.name ?? m.username ?? ''),
        message: m.message == null ? '' : String(m.message),
        time: String(m.timestamp || ''),
        style, chatType,
        bubbleClass: m.bubbleClass || `bubble-${style} type-${chatType}`,
        color: m.color || '',
        image: m.imageUrl || m.avatarUrl || (Number.isInteger(m.avatarRef) ? avatars[m.avatarRef] : '') || '',
        at: Number.isFinite(+m.cachedAt) ? +m.cachedAt : 0,
        session: m.sessionId || '',
      };
    });
    return { key, savedAt: o && o.savedAt, entries };
  };

  // oma puskuri: kuplat, jotka skripti on nähnyt (vain jos välimuisti puuttuu)
  const domBuffer = [];
  const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const recordBubble = el => {
    try {
      const bubble = el.querySelector('.chat-bubble');
      if (!bubble) return;
      const nameEl = el.querySelector('.username');
      const msgEl = el.querySelector('.message');
      const bg = el.querySelector('.user-container-bg');
      const img = el.querySelector('.user-image');
      const cls = [...bubble.classList].filter(c => /^(bubble|type)-/.test(c)).join(' ');
      domBuffer.push({
        type: 1,
        name: nameEl ? nameEl.textContent.replace(/:\s*$/, '') : '',
        message: msgEl ? msgEl.innerHTML : '',
        time: hhmm(), style: 0, chatType: 0, bubbleClass: cls || 'bubble-0 type-0',
        color: bg ? bg.style.backgroundColor : '',
        image: img ? (img.style.backgroundImage || '') : '',
        at: Date.now(), session: '', dom: true,
      });
      if (domBuffer.length > CFG.DOM_BUFFER) domBuffer.splice(0, domBuffer.length - CFG.DOM_BUFFER);
    } catch (e) { /* kupla voi kadota kesken */ }
  };

  const getSource = () => {
    const c = loadCache();
    if (c && c.entries.length) return { kind: 'cache', key: c.key, entries: c.entries };
    return { kind: 'dom', key: null, entries: domBuffer.slice() };
  };
  const fp = e => e ? `${e.at}|${e.name}|${e.message}` : '';

  // ---------------------------------------------------------------- paneeli
  const S = {
    open: false, mode: 'idle', startX: 0, startY: 0, startH: 0, startScroll: 0,
    closeLine: CFG.MIN_H, pinned: true, swallowTail: false,
    src: null, from: 0, lastFp: '', lastSession: null,
    opens: 0, closes: 0, lastCloseReason: '',
  };
  let panel = null, list = null, info = null;

  const widgetEl = () => document.querySelector('.nitro-chat-widget');
  const hostEl = () => { const w = widgetEl(); return (w && w.parentElement) || document.body; };
  const hostHeight = () => { const h = hostEl(); return (h && h.clientHeight) || window.innerHeight; };

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  };
  ensureStyle(); // heti: touch-action kupliin ennen ensimmäistä vetoa

  const ensurePanel = () => {
    ensureStyle();
    const host = hostEl();
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'kch-panel';
      panel.id = 'kch-panel';
      panel.innerHTML = '<div class="kch-list"></div><div class="kch-grab" title="Vedä: muuta kokoa · vedä ylös: sulje"><div class="kch-grab-in"><span class="kch-info"></span><div class="kch-grip"></div><button type="button" class="kch-close" title="Sulje (Esc)">×</button></div></div>';
      list = panel.querySelector('.kch-list');
      info = panel.querySelector('.kch-info');
      panel.querySelector('.kch-close').addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); close('x'); }, { signal: ac.signal });
      // rulla vierittää listaa; ei päästetä huoneelle (zoom tms.)
      panel.addEventListener('wheel', ev => { ev.stopPropagation(); }, { signal: ac.signal, passive: true });
      list.addEventListener('scroll', () => {
        S.pinned = (list.scrollHeight - list.scrollTop - list.clientHeight) < 4;
        if (list.scrollTop < 40) renderMore();
      }, { signal: ac.signal, passive: true });
    }
    if (host === document.body) panel.style.position = 'fixed'; else panel.style.position = '';
    if (panel.parentElement !== host) host.appendChild(panel);
    return panel;
  };

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cssUrl = u => { if (!u) return ''; return /^url\(/.test(u) ? u : `url("${String(u).replace(/"/g, '%22')}")`; };

  const rowFor = (e, prev) => {
    const frag = document.createDocumentFragment();
    if (prev && e.session && prev.session && e.session !== prev.session) {
      const d = document.createElement('div'); d.className = 'kch-sep kch-session';
      d.innerHTML = '<span>uusi sessio</span>'; frag.appendChild(d);
    }
    if (e.type === 2) {
      const d = document.createElement('div'); d.className = 'kch-sep kch-room';
      d.innerHTML = `<span>${esc(e.time)} · huone: ${esc(e.name)}</span>`; frag.appendChild(d);
      return frag;
    }
    if (e.type === 3) return frag; // pikaviestit eivät kuulu huonechattiin
    const r = document.createElement('div'); r.className = 'kch-row';
    const bg = (e.style === 0 && e.color) ? `<div class="user-container-bg" style="background-color:${esc(e.color)}"></div>` : '';
    const img = e.image ? `<div class="user-image" style="background-image:${esc(cssUrl(e.image))}"></div>` : '';
    // name ja message ovat clientin omaa HTML:ää (sama kuin dangerouslySetInnerHTML clientissa)
    r.innerHTML = `<span class="kch-time">${esc((e.time || '').replace('.', ':'))}</span>` +
      `<div class="bubble-container kch-bubble">${bg}<div class="chat-bubble ${esc(e.bubbleClass)}">` +
      `<div class="user-container">${img}</div><div class="chat-content"><b class="username mr-1">${e.name}: </b>` +
      `<span class="message">${e.message}</span></div></div></div>`;
    frag.appendChild(r);
    return frag;
  };

  const updateInfo = () => {
    if (!info || !S.src) return;
    const n = S.src.entries.length;
    info.textContent = `${n - S.from}/${n} viestiä` + (S.src.kind === 'dom' ? ' (vain tämän latauksen jälkeen nähdyt)' : '');
  };

  const setMore = () => {
    let m = list.querySelector('.kch-more');
    if (S.from > 0) {
      if (!m) { m = document.createElement('div'); m.className = 'kch-more'; list.insertBefore(m, list.firstChild); }
      m.textContent = `▲ vieritä ylös: vanhempia (${S.from})`;
    } else if (m) m.remove();
  };

  const renderAll = () => {
    S.src = getSource();
    const E = S.src.entries;
    list.textContent = '';
    S.from = Math.max(0, E.length - CFG.CHUNK);
    if (!E.length) { list.innerHTML = '<div class="kch-empty">Ei vielä historiaa.</div>'; S.lastFp = ''; updateInfo(); return; }
    const frag = document.createDocumentFragment();
    for (let i = S.from; i < E.length; i++) frag.appendChild(rowFor(E[i], E[i - 1]));
    list.appendChild(frag);
    S.lastFp = fp(E[E.length - 1]);
    setMore(); updateInfo();
  };

  const renderMore = () => {
    if (!S.open || !S.src || S.from <= 0) return;
    const E = S.src.entries;
    const to = S.from, from = Math.max(0, to - CFG.CHUNK);
    const before = list.scrollHeight;
    const frag = document.createDocumentFragment();
    for (let i = from; i < to; i++) frag.appendChild(rowFor(E[i], E[i - 1]));
    const anchor = list.querySelector('.kch-more');
    list.insertBefore(frag, anchor ? anchor.nextSibling : list.firstChild);
    S.from = from;
    setMore();
    list.scrollTop += list.scrollHeight - before;
    updateInfo();
  };

  const refresh = () => {
    if (!S.open || !list) return;
    const next = getSource();
    const E = next.entries;
    if (!S.src || next.kind !== S.src.kind || next.key !== S.src.key) { renderAll(); if (S.pinned) pinBottom(); return; }
    let k = -1;
    for (let i = E.length - 1; i >= 0; i--) { if (fp(E[i]) === S.lastFp) { k = i; break; } }
    if (k < 0) { const keep = S.pinned; renderAll(); if (keep) pinBottom(); return; }
    if (k === E.length - 1) { S.src = next; return; }
    const shown = S.src.entries.length - S.from;
    const empty = list.querySelector('.kch-empty'); if (empty) empty.remove();
    const frag = document.createDocumentFragment();
    for (let i = k + 1; i < E.length; i++) frag.appendChild(rowFor(E[i], E[i - 1]));
    list.appendChild(frag);
    S.src = next;
    S.from = Math.max(0, k + 1 - shown);
    S.lastFp = fp(E[E.length - 1]);
    setMore(); updateInfo();
    if (S.pinned) pinBottom();
  };
  let refreshTimer = null;
  const scheduleRefresh = () => {
    if (!S.open) return;
    if (refreshTimer) { clearTimeout(refreshTimer); timeouts.delete(refreshTimer); }
    refreshTimer = later(() => { refreshTimer = null; refresh(); }, CFG.RELOAD_DEBOUNCE);
  };

  const pinBottom = () => { if (list) list.scrollTop = list.scrollHeight; };
  const clampH = h => Math.max(CFG.MIN_H, Math.min(hostHeight() - CFG.BOTTOM_RESERVE, Math.round(h)));
  const setHeight = h => { panel.style.height = clampH(h) + 'px'; if (S.pinned) pinBottom(); };
  const panelBottom = () => panel ? panel.getBoundingClientRect().bottom : 0;

  const open = (height, closeLine) => {
    ensurePanel();
    if (S.closingTimer) { clearTimeout(S.closingTimer); timeouts.delete(S.closingTimer); S.closingTimer = null; }
    const wasOpen = S.open;
    S.open = true;
    S.closeLine = Math.max(CFG.MIN_H, closeLine == null ? CFG.MIN_H : closeLine);
    panel.classList.remove('kch-closing');
    panel.classList.add('kch-open');
    if (!wasOpen) { renderAll(); S.pinned = true; S.opens++; }
    setHeight(height == null ? Math.round(hostHeight() * 0.5) : height);
    pinBottom();
    requestAnimationFrame(() => panel && panel.classList.add('kch-visible'));
  };

  const close = reason => {
    if (!S.open || !panel) return;
    S.open = false; S.mode = 'idle'; S.closes++; S.lastCloseReason = reason || '';
    panel.classList.remove('kch-visible');
    panel.classList.add('kch-closing');
    S.closingTimer = later(() => {
      S.closingTimer = null;
      if (S.open || !panel) return;
      panel.classList.remove('kch-open', 'kch-closing');
      panel.style.height = '0px';
      if (list) list.textContent = '';
      S.src = null;
    }, CFG.FADE_OUT + 20);
  };

  // ---------------------------------------------------------------- syöte
  const NO_DRAG = 'a,button,input,textarea,select,audio,video,[role="button"],.chat-reply-button';
  const swallow = e => { if (e.cancelable) e.preventDefault(); e.stopPropagation(); };

  const onDown = e => {
    if (e.button !== 0 || S.mode !== 'idle') return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (panel && S.open && panel.contains(t)) {
      if (t.closest('.kch-close')) return;
      if (t.closest('.kch-grab')) {
        S.mode = 'resize'; S.startY = e.clientY; S.startH = panel.getBoundingClientRect().height;
        swallow(e); return;
      }
      if (t.closest(NO_DRAG)) return;
      S.mode = 'scrollpend'; S.startY = e.clientY; S.startScroll = list.scrollTop;
      return;
    }
    const bubble = t.closest('.nitro-chat-widget .bubble-container');
    if (!bubble || t.closest(NO_DRAG)) return;
    S.mode = 'pending'; S.startX = e.clientX; S.startY = e.clientY;
  };

  const onMove = e => {
    if (S.mode === 'idle') return;
    const dy = e.clientY - S.startY, dx = e.clientX - S.startX;
    if (S.mode === 'pending') {
      if (dy > CFG.HYSTERESIS) {
        const hostTop = hostEl().getBoundingClientRect().top;
        S.mode = 'resize';
        S.startH = (S.startY - hostTop) + CFG.GRAB_H / 2;
        open(S.startH + dy, S.startY - hostTop);
        swallow(e);
      } else if (dy < -CFG.HYSTERESIS || Math.abs(dx) > CFG.ABORT_DX) {
        S.mode = 'idle'; // tavallinen klikkaus/liike, ei historiaa
      }
      return;
    }
    if (S.mode === 'resize') { if (panel) setHeight(S.startH + dy); swallow(e); return; }
    if (S.mode === 'scrollpend') {
      if (Math.abs(dy) > CFG.HYSTERESIS) { S.mode = 'scroll'; list.classList.add('kch-dragging'); }
      else return;
    }
    if (S.mode === 'scroll') { list.scrollTop = S.startScroll - dy; swallow(e); }
  };

  const onUp = e => {
    if (S.swallowTail) { swallow(e); return; }
    const mode = S.mode;
    if (mode === 'idle') return;
    S.mode = 'idle';
    if (mode === 'pending' || mode === 'scrollpend') return; // klikkaus kulkee normaalisti
    if (list) list.classList.remove('kch-dragging');
    if (mode === 'resize' && panel) {
      const hostTop = hostEl().getBoundingClientRect().top;
      const barMid = panelBottom() - hostTop - CFG.GRAB_H / 2;
      if (barMid < S.closeLine) close('drag-up');
    }
    swallow(e);
    // sama fyysinen vapautus tuottaa vielä mouseup + click: niellään ne, jotta kupla/huone ei reagoi
    S.swallowTail = true;
    later(() => { S.swallowTail = false; }, 0);
  };

  const onClickCapture = e => { if (S.swallowTail) swallow(e); };
  const onKey = e => { if (e.key === 'Escape' && S.open) close('esc'); };

  on(window, 'pointerdown', onDown, true);
  on(window, 'pointermove', onMove, true);
  on(window, 'mousemove', e => { if (S.mode === 'resize' || S.mode === 'scroll') swallow(e); }, true);
  on(window, 'pointerup', onUp, true);
  on(window, 'pointercancel', onUp, true);
  on(window, 'mouseup', e => { if (S.swallowTail || S.mode === 'resize' || S.mode === 'scroll') { if (S.mode !== 'idle') onUp(e); else swallow(e); } }, true);
  on(window, 'click', onClickCapture, true);
  on(window, 'keydown', onKey, false);
  on(window, 'blur', () => { if (S.mode !== 'idle') { S.mode = 'idle'; if (list) list.classList.remove('kch-dragging'); } }, false);

  // ---------------------------------------------------------------- kuplien seuranta
  let observed = null, mo = null;
  const attachObserver = () => {
    const w = widgetEl();
    if (w === observed) return;
    if (mo) mo.disconnect();
    observed = w; mo = null;
    if (!w) return;
    mo = new MutationObserver(recs => {
      let added = false;
      for (const r of recs) for (const n of r.addedNodes) {
        if (n instanceof Element && n.classList.contains('bubble-container')) { recordBubble(n); added = true; }
      }
      if (added) scheduleRefresh();
    });
    mo.observe(w, { childList: true });
  };
  attachObserver();
  intervals.push(setInterval(attachObserver, 2000));
  intervals.push(setInterval(() => { if (S.open) refresh(); }, CFG.POLL_MS));

  // ---------------------------------------------------------------- API
  const destroy = () => {
    ac.abort();
    intervals.forEach(clearInterval); intervals.length = 0;
    timeouts.forEach(clearTimeout); timeouts.clear();
    if (mo) mo.disconnect(); mo = null; observed = null;
    if (panel) panel.remove(); panel = null; list = null; info = null;
    const st = document.getElementById(STYLE_ID); if (st) st.remove();
    S.open = false; S.mode = 'idle';
    if (window[NS] && window[NS].version === VERSION && window[NS]._S === S) delete window[NS];
  };

  window[NS] = {
    version: VERSION,
    _S: S,
    open: h => open(h, CFG.MIN_H),
    close: () => close('api'),
    destroy,
    state: () => ({
      version: VERSION, open: S.open, mode: S.mode, opens: S.opens, closes: S.closes,
      lastCloseReason: S.lastCloseReason, source: S.src ? S.src.kind : null, key: S.src ? S.src.key : null,
      total: S.src ? S.src.entries.length : null, rendered: list ? list.querySelectorAll('.kch-row').length : 0,
      height: panel ? Math.round(panel.getBoundingClientRect().height) : 0, pinned: S.pinned,
      closeLine: S.closeLine, domBuffer: domBuffer.length, panelInDom: !!(panel && panel.isConnected),
    }),
  };
})();
