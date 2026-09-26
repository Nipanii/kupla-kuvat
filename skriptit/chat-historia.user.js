// ==UserScript==
// @name         Kupla chat-historia (vedä kuplista alas)
// @namespace    kupla-relab
// @updateURL    https://nipanii.github.io/kupla-kuvat/skriptit/chat-historia.user.js
// @downloadURL  https://nipanii.github.io/kupla-kuvat/skriptit/chat-historia.user.js
// @version      0.2.5
// @description  Vanhan Habbo-clientin (roomchat) chat-historia: tartu huoneen chat-kuplaan ja vedä alas, niin aiemmat kuplat tulevat näkyviin puhujiensa kohdalle. Vedä takaisin ylös tai paina X / Esc, niin live-chat palaa.
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
// MALLI 1:1 — Habbo-Sky @ wired2-ngh, VANHA roomchat-widget (src/com/sulake/habbo/ui/widget/roomchat/):
//   RoomChatItem.as            mouse DOWN kuplassa aloittaa vedon
//   RoomChatHistoryViewer.as   3 px hystereesi (_Str_14515), sitten chat-alue kasvaa vedon verran
//   RoomChatHistoryPulldown.as 39 px tartuntapalkki: tausta, kahva 98x21 keskellä, ritilät, X 13x13
//                              (oikealla 3 px); SWF:n fade 250/150 ms JÄTETTY POIS Resin pyynnöstä (v0.2.2); historian tausta chat_history_bg
//   RoomChatWidget.as          kuplan x = puhujan x, keskitetty ja rajattu, osoitin puhujaan (_Str_14645);
//                              y alhaalta ylös: uusin top = H−19−23, vanhempi = seuraava − 19 jos
//                              vaakasuunnassa päällekkäin, muuten − 10 (_Str_19662, _Str_9323);
//                              historia on huonekohtainen, max 150 (chat.history.item.max.count);
//                              vapautus perusrajan yläpuolella → sulkeutuu (_Str_20437)
//   Grafiikat: src/images/HabboRoomUICom_chat_grapbar_*.png + chat_history_bg.png, upotettu alle
//   data-URIna sellaisenaan (ei approksimaatiota).
//
// MITEN:
//   • pointerdown VAIN `.nitro-chat-widget .bubble-container`-elementissä (chat-kerros on muuten
//     pointer-events:none, joten tyhjä alue ja huone eivät koskaan käynnistä vetoa).
//   • ≤3 px liike = tavallinen klikkaus: mitään ei tapahdu, kupla valitsee puhujan kuten ennenkin.
//   • >3 px ALAS = historia avautuu ja sen alareuna seuraa osoitinta. Vedon aikana hiiren liike ja
//     vapautus pysäytetään window-capture-vaiheessa, joten huone ei saa niitä.
//   • Auki: live-kuplakerros piilotetaan (SWF:ssä chat-alue ITSE muuttuu historiaksi), historia
//     näytetään sen paikalla. Vedä listaa tai rullaa; vedä alapalkkia; X tai Esc sulkee.
//
// HISTORIAN LÄHDE: clientin oma välimuisti localStorage `kuplafix.chatHistoryCache.<oma userId>`
//   (DarkUI src/api/chat-history/ChatHistoryCache.ts). Välimuistissa EI ole kuplan x-sijaintia, joten
//   x tulee järjestyksessä: (1) kuplan mitattu paikka kun skripti näki sen livenä, (2) puhujan
//   NYKYINEN avatar-sijainti jos hän on yhä huoneessa (roomEngine.getRoomObjectScreenLocation),
//   (3) keskelle ilman osoitinta. Jos välimuisti on pois päältä, käytetään skriptin omaa puskuria.
//   HUOM: viestien HTML renderöidään innerHTML:llä täsmälleen kuten client itse tekee samalle datalle.
//
// KONSOLI: window.__kuplaChatHistoria.open() · .close() · .state() · .destroy()
(function () {
  'use strict';

  const NS = '__kuplaChatHistoria';
  const VERSION = '0.2.5';
  if (window[NS] && typeof window[NS].destroy === 'function') {
    try { window[NS].destroy(); } catch (e) { /* vanha versio voi olla rikki */ }
  }

  const CFG = {
    HYSTERESIS: 3,          // SWF RoomChatHistoryViewer._Str_14515
    ABORT_DX: 12,           // sivuttaisliike ennen avautumista = ei vetoa (oma lisäys)
    GRAB_H: 39,             // SWF PULLDOWN_WINDOW_HEIGHT
    MIN_H: 60,
    BOTTOM_RESERVE: 110,    // SWF: työpöytä − 39 − 40; DarkUI:n alapalkki ~55 px
    // v0.2.2: EI fadeja (Res: "jämpti ei animaatiota kummassakaan parempi"). SWF:ssä oli 250/150 ms
    // (RoomChatHistoryPulldown FADE_IN_MS/FADE_OUT_MS) vain taustalle ja palkille.
    PITCH_ROW: 19,          // SWF _Str_3729
    PITCH_FREE: 10,         // SWF _Str_18120
    BOTTOM_TOP_OFFSET: 42,  // SWF: uusin y = H − 19 − 23
    CLOSE_PULL: 10,
    BOTTOM_MIN_GAP: 13,     // SWF: osoittimen kärki 13 px palkin yläpuolella         // oma: näin paljon alle alkukohdan pitää vetää, muuten vapautus sulkee
    SIDE_MARGIN: 20,        // SWF _Str_12991
    SCROLLBAR_W: 20,        // SWF RoomChatHistoryViewer _Str_4906
    MAX_ITEMS: 150,         // SWF chat.history.item.max.count oletus
    ROOM_ONLY: true,        // SWF: historia on huonekohtainen
    GUARD_DEPTH: 6,
    HEAD_MIN_PX: 40,        // alle tämän näkyvää pikseliä = tyhjä pää (oikeat päät mitattu 832–1590)         // oma lisäys: ei piiloteta tekstiä kauempana olevan kuplan alle
    RELOAD_DEBOUNCE: 1300,  // client tallentaa välimuistin 1000 ms viiveellä
    POLL_MS: 3000,
    DOM_BUFFER: 1000,
  };

  // SWF-bitmapit (Habbo-Sky src/images/HabboRoomUICom_*.png), tavu tavulta
  const IMG = {
    bg: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAnCAYAAAA2ANlVAAAAU0lEQVR42mNgYGA4QiQmXuF/orCKisoWYjDIxLNEYhQrYIKYYtbW1tdhGCaITYwkq0cVjiocVUiCQuQchw8Tr3DixInPicFkFyn4MIMvkXj4KAQASodG/D731+cAAAAASUVORK5CYII=',
    grip: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAPCAYAAADd/14OAAAAG0lEQVR42mP4//+/MQMQEKJJA9Q1ddSNQ92NAGFuf4FUp40iAAAAAElFTkSuQmCC',
    handle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGIAAAAVCAYAAAC9gjt3AAAAqUlEQVR42u3ZwQ2AIAxA0e7ETuzETuyk0ZMxUCi26uGT/COXvoQoiOhrI9fM69xYSiHHrCBbrfXcmHMmx24gYwSGFg+iYTQRONd9msVoHkUM8H0MED7CuEKA8BOMIURKiR7kAsEg/THMEAwwBgMIIGgZgsHFYZg/YRncuwii/fUxQD8E5fZCpjDoeco9Xvvir3d1S2sdAFaELgb5ZnocAiQMYP3JlOLfrHcu25xz3NF3lAAAAABJRU5ErkJggg==',
    x: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA0AAAANCAYAAABy6+R8AAAAO0lEQVR42mNgQAL///83ZsACcInDJdAV4BInWiGcT6qTCGokaBAhjQQDg2INZDuNdqFHMJ7IThGkhh4Aoh9ywe7N77UAAAAASUVORK5CYII=',
    xHi: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA0AAAANCAYAAABy6+R8AAAASklEQVR42pWSUQoAMAhCu1P3P5uDjYEDVyb480IQKYIEIEPox/cBR+nw53BdcXkgS85By6qiH3CC7XqTarArTgLtehWXIzh8/HsL+t9irMg4e4YAAAAASUVORK5CYII=',
    xPr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA0AAAANCAYAAABy6+R8AAAATElEQVR42mNgQAL///83ZsACcInDJdAV4BInWiGcT6qTgOJr8bsZlwaCnsWlgWgnER2suORJ8JMxWU7CGXowCVzi2CJ0LTHixDsJCgAdBnh5j6Z77gAAAABJRU5ErkJggg==',
    hist: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAE0lEQVR42mNgYGBYTSQeVUhPhQAd30LNyw3eFQAAAABJRU5ErkJggg==',
  };

  const ac = new AbortController();
  const on = (el, type, fn, capture) => el.addEventListener(type, fn, { capture: !!capture, passive: false, signal: ac.signal });
  const intervals = [];
  const timeouts = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timeouts.delete(t); fn(); }, ms); timeouts.add(t); return t; };

  // ---------------------------------------------------------------- tyylit
  const STYLE_ID = 'kch-style';
  const css = `
.kch-panel{position:absolute;left:0;top:0;width:100%;height:0;z-index:21;display:none;pointer-events:auto}
.kch-panel.kch-open{display:block}
.kch-bg{position:absolute;left:0;top:0;right:0;bottom:${CFG.GRAB_H}px;background:url(${IMG.hist}) repeat;pointer-events:none}
.kch-list{position:absolute;left:0;top:0;right:0;bottom:${CFG.GRAB_H}px;overflow-y:auto;overflow-x:hidden;cursor:default;
  user-select:none;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.35) transparent}
/* v0.2.2: auki = näkyy heti, kiinni = display:none heti; ei opacity-tiloja eikä transitioita */
.kch-canvas{position:relative;width:100%;min-height:100%}
.kch-panel .bubble-container.kch-bubble{position:absolute!important;top:auto;transition:none!important;pointer-events:auto;width:fit-content}
.kch-panel .kch-bubble.kch-measure{visibility:hidden}
.kch-panel .kch-bubble .pointer.kch-ptr{left:var(--kch-ptr-x)!important;transform:none!important}
.kch-panel .kch-bubble.kch-noptr .pointer{display:none}
.kch-panel .kch-bubble .user-image.kch-imager{background-size:contain!important;background-position:center top!important}
.kch-empty{position:absolute;left:0;right:0;bottom:16px;color:#fff;opacity:.7;font-size:12px;text-align:center}
.kch-grab{position:absolute;left:0;right:0;bottom:0;height:${CFG.GRAB_H}px;background:url(${IMG.bg}) repeat-x;cursor:ns-resize;--kch-x-inset:3px}
.kch-stripe{position:absolute;left:0;right:0;top:7px;height:21px;pointer-events:none}
.kch-gripL,.kch-gripR{position:absolute;top:3px;height:15px;background:url(${IMG.grip}) repeat-x}
.kch-gripL{left:0;width:calc(50% - 54px)}
.kch-gripR{left:calc(50% + 54px);right:calc(var(--kch-x-inset) + 18px)}
.kch-handle{position:absolute;top:0;left:calc(50% - 49px);width:98px;height:21px;background:url(${IMG.handle}) no-repeat}
.kch-close{position:absolute;top:11px;right:var(--kch-x-inset);width:13px;height:13px;padding:0;border:0;margin:0;
  background:url(${IMG.x}) no-repeat;cursor:pointer;pointer-events:auto}
.kch-close:hover{background-image:url(${IMG.xHi})}
.kch-close:active{background-image:url(${IMG.xPr})}
/* v0.2.3: live-kerros pois näkyvistä KOKONAAN. visibility:hidden ei riittänyt, koska DarkUI:n
   .bubble-container.visible asettaa lapsilleen visibility:visible (mitattu: 12/12 live-kuplaa näkyi
   historian 67 % taustan läpi = Resin "blendaa"). opacity periytyy koko alipuuhun eikä lapsi voi kumota sitä;
   display:nonea ei käytetä, koska DarkUI mittaa kuplien offsetHeightia uusia viestejä asetellessaan. */
body.kch-active .nitro-chat-widget{opacity:0!important;pointer-events:none!important}
.nitro-chat-widget .bubble-container{touch-action:none}
`;
  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  };
  ensureStyle();

  // ---------------------------------------------------------------- huone ja puhujat
  const RE = () => (window.NitroDevTools && window.NitroDevTools.roomEngine) || null;
  const own = (o, k) => { try { const d = o && Object.getOwnPropertyDescriptor(o, k); return d && !d.get ? d.value : (o ? o[k] : undefined); } catch (e) { return undefined; } };
  const activeRoomId = () => { try { const r = RE(); const id = r && r.activeRoomId; return Number.isInteger(id) && id > 0 ? id : null; } catch (e) { return null; } };
  const ownUserId = () => { try { const id = own(own(RE(), '_sessionDataManager'), 'userId'); return Number.isInteger(id) && id > 0 ? id : null; } catch (e) { return null; } };
  // puhujan nykyinen x (host-koordinaateissa), vain jos sama henkilö on yhä samassa huonessa
  const speakerX = (e, hostLeft) => {
    try {
      const r = RE(); const room = activeRoomId();
      if (!r || !room || e.roomId !== room || !(e.entityId >= 0)) return null;
      const sess = own(r, '_roomSessionManager').getSession(room);
      const ud = sess && sess.userDataManager && sess.userDataManager.getUserDataByIndex(e.entityId);
      if (!ud || ud.name !== e.name) return null;
      const p = r.getRoomObjectScreenLocation(room, e.entityId, 100, 1);
      if (!p || !Number.isFinite(p.x)) return null;
      const c = document.querySelector('.nitro-chat-widget');
      const cl = c ? c.getBoundingClientRect().left : 0;  // DarkUI: bubble left = location.x − w/2 widgetin sisällä
      return p.x + cl - hostLeft;
    } catch (err) { return null; }
  };

  // ---------------------------------------------------------------- lähde
  const KEY_RE = /^kuplafix\.chatHistoryCache\.(\d+|anonymous)$/;
  const pickKey = () => {
    let keys = [];
    try { keys = Object.keys(localStorage).filter(k => KEY_RE.test(k)); } catch (e) { return null; }
    if (!keys.length) return null;
    const uid = ownUserId();
    if (uid && keys.includes('kuplafix.chatHistoryCache.' + uid)) return 'kuplafix.chatHistoryCache.' + uid;
    let best = null, bestAt = -1;
    for (const k of keys) {
      let at = 0;
      try { const m = /"savedAt":(\d+)/.exec((localStorage.getItem(k) || '').slice(0, 80)); at = m ? +m[1] : 0; } catch (e) {}
      if (at > bestAt) { bestAt = at; best = k; }
    }
    return best;
  };
  const plain = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();

  const loadCache = () => {
    const key = pickKey();
    if (!key) return null;
    let o;
    try { o = JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    const avatars = (o && Array.isArray(o.avatars)) ? o.avatars : [];
    const msgs = Array.isArray(o) ? o : ((o && o.messages) || []);
    const all = msgs.filter(m => m && typeof m === 'object').map(m => {
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
        roomId: Number.isFinite(+m.roomId) ? +m.roomId : -1,
        entityId: Number.isFinite(+m.entityId) ? +m.entityId : -1,
      };
    });
    return { key, entries: all };
  };

  // SWF-historia on huonekohtainen: vain nykyisen huoneen viimeisimmän sisääntulon jälkeiset rivit
  // v0.2.4 (Res 08:01 "näyttää vaan että ei historiaa tässä huoneessa"): v0.2.1–0.2.3 otti vain rivit
  // VIIMEISEN huoneentulo-rivin (type 2) jälkeen. DarkUI kirjoittaa type-2-rivin joka kerta kun huoneeseen
  // tullaan uudelleen (reload / ulos-sisään, useChatHistory.ts:259-266), joten heti paluun jälkeen jakso oli
  // tyhjä. Nyt: kaikki tämän huoneen (roomId) rivit koko välimuistista; jos huonetta ei tiedetä tai yksikään
  // rivi ei osu, näytetään viimeisimmät rivit huoneesta riippumatta — ei koskaan tyhjää kun historiaa on.
  const roomSegment = all => {
    const chat = all.filter(e => e.type === 1);
    const room = activeRoomId();
    S.roomMatch = { room, how: 'all-recent', matched: 0 };
    if (CFG.ROOM_ONLY && room != null) {
      const mine = chat.filter(e => e.roomId === room);
      S.roomMatch.matched = mine.length;
      if (mine.length) { S.roomMatch.how = 'room-id'; return mine.slice(-CFG.MAX_ITEMS); }
    }
    return chat.slice(-CFG.MAX_ITEMS);
  };

  // live-kuplien mitattu paikka + oma puskuri
  const seen = [];       // {name, text, cx, t}
  const domBuffer = [];
  const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const readBubble = el => {
    const bubble = el.querySelector('.chat-bubble');
    if (!bubble) return null;
    const nameEl = el.querySelector('.username');
    const msgEl = el.querySelector('.message');
    return {
      name: nameEl ? nameEl.textContent.replace(/:\s*$/, '').trim() : '',
      html: msgEl ? msgEl.innerHTML : '',
      cls: [...bubble.classList].filter(c => /^(bubble|type)-/.test(c)).join(' '),
      color: el.querySelector('.user-container-bg') ? el.querySelector('.user-container-bg').style.backgroundColor : '',
      image: el.querySelector('.user-image') ? el.querySelector('.user-image').style.backgroundImage : '',
    };
  };
  // v0.2.5 (Res: kameraa siirtäessä historian kuplat eivät seuraa kuten live): DarkUI siirtää live-kuplia
  // vaakasuunnassa huoneen vedon verran (useChatWidget.ts:361-370, ROOM_DRAG → chat.left += offsetX; y ei muutu).
  // SWF teki saman (RoomChatWidget.onRoomViewUpdate :301-331, _Str_7165). Siksi jokainen mitattu x tallennetaan
  // yhdessä sen hetken huoneen näyttöoffsetin kanssa ja korjataan nykyiseen offsettiin.
  const panX = () => { try { const r = RE(), room = activeRoomId(); const p = r && room && r.getRoomInstanceRenderingCanvasOffset(room); return p && Number.isFinite(p.x) ? p.x : 0; } catch (e) { return 0; } };
  const measureBubble = (el, isNew) => {
    try {
      if (!el.isConnected) return;
      const b = readBubble(el);
      if (!b) return;
      const r = el.getBoundingClientRect();
      const host = hostEl().getBoundingClientRect();
      const text = plain(b.html);
      const ox = panX(), cxNow = r.left + r.width / 2 - host.left;
      if (!seen.some(s => s.name === b.name && s.text === text && Math.abs(s.cx + (ox - s.ox) - cxNow) < 2)) {
        seen.push({ name: b.name, text, cx: cxNow, ox, t: Date.now() });
        if (seen.length > CFG.DOM_BUFFER) seen.splice(0, seen.length - CFG.DOM_BUFFER);
      }
      if (isNew) {
        domBuffer.push({ type: 1, name: b.name, message: b.html, time: hhmm(), style: 0, chatType: 0, bubbleClass: b.cls || 'bubble-0 type-0',
          color: b.color, image: b.image, at: Date.now(), roomId: activeRoomId() ?? -1, entityId: -1, dom: true });
        if (domBuffer.length > CFG.DOM_BUFFER) domBuffer.splice(0, domBuffer.length - CFG.DOM_BUFFER);
      }
    } catch (e) { /* kupla voi kadota kesken */ }
  };
  const sweepLive = () => { document.querySelectorAll('.nitro-chat-widget .bubble-container').forEach(el => measureBubble(el, false)); };
  const measuredX = e => {
    const text = plain(e.message);
    let best = null, bestDt = Infinity;
    for (let i = seen.length - 1; i >= 0; i--) {
      const s = seen[i];
      if (s.name !== e.name || s.text !== text) continue;
      // s.t = milloin skripti näki kuplan ensimmäisen kerran (≥ viestin hetki); toistuva sama teksti → lähin aika
      const dt = e.at ? s.t - e.at : 0;
      if (e.at && dt < -5000) continue;
      if (dt < bestDt) { bestDt = dt; best = s; }
    }
    return best ? best.cx + (panX() - (best.ox || 0)) : null;
  };

  // Avatarin pää: rivin oma kuva, jos se kelpaa; muuten saman nimen tuorein toimiva kuva (live-kupla ensin,
  // sitten välimuistin uusin). Res 2026-09-26: "mun oma user-image bubbleissa ei lataa" — syy ei toistunut
  // robotilla (kaikki 5 välimuistikuvaa dekoodautuvat), joten korjaus on puolustava + diag().
  const imgOk = u => typeof u === 'string' && /^(url\(|data:image\/|https?:)/i.test(u.trim()) && u.length > 30;
  const bad = new Set();   // URLit jotka eivät dekoodautuneet
  const nameImages = all => {
    const m = new Map();
    for (let i = all.length - 1; i >= 0; i--) { const e = all[i]; if (e.type === 1 && e.name && !m.has(e.name) && imgOk(e.image) && !bad.has(e.image)) m.set(e.name, e.image); }
    document.querySelectorAll('.nitro-chat-widget .bubble-container').forEach(el => {
      const b = readBubble(el); if (b && b.name && imgOk(b.image) && !bad.has(b.image)) m.set(b.name, b.image); // live = nykyinen, voittaa
    });
    return m;
  };
  const resolveImages = (entries, all) => {
    const m = nameImages(all); const stats = { own: 0, sameName: 0, none: 0 };
    for (const e of entries) {
      if (imgOk(e.image) && !bad.has(e.image)) { e.img = e.image; stats.own++; }
      else if (m.has(e.name)) { e.img = m.get(e.name); stats.sameName++; }
      else { e.img = ''; stats.none++; }
    }
    return stats;
  };
  const getSource = () => {
    const c = loadCache();
    if (c && c.entries.length) {
      // client tallentaa välimuistin 1 s viiveellä: juuri tulleet live-kuplat puuttuvat siitä vielä.
      // Lisätään skriptin itse näkemät kuplat, joita ei löydy välimuistin viimeisimmistä riveistä.
      const lastAt = c.entries.reduce((m, e) => Math.max(m, e.at || 0), 0);
      const recent = c.entries.slice(-40).map(e => e.name + '|' + plain(e.message));
      const extra = domBuffer.filter(d => d.at > lastAt - 3000 && !recent.includes(d.name + '|' + plain(d.message)));
      if (extra.length) c.entries = c.entries.concat(extra);
      const entries = roomSegment(c.entries); const img = resolveImages(entries, c.entries); return { kind: 'cache', key: c.key, entries, img, all: c.entries }; }
    const entries = domBuffer.slice(-CFG.MAX_ITEMS);
    return { kind: 'dom', key: null, entries, img: resolveImages(entries, domBuffer), all: domBuffer };
  };
  const urlOf = u => String(u || '').trim().replace(/^url\(\s*["']?/, '').replace(/["']?\s*\)$/, '');
  const decodeOk = u => new Promise(res => { try { const im = new Image(); im.onload = () => res(im.naturalWidth > 1 && im.naturalHeight > 1); im.onerror = () => res(false); im.src = urlOf(u); } catch (e) { res(false); } });
  // renderöinnin jälkeen: jokainen käytetty URL dekoodataan; rikki → saman nimen toinen kuva, muuten pää pois
  // v0.2.5 (Res 08:08, uudelleentulon jälkeen: "nyt on taas oma kuva rikki"): kuva voi latautua mutta olla
  // tyhjä/läpinäkyvä (esim. avatar piirretty ennen kuin vaatteet ladattiin). Nyt "kelpaa" = dekoodautuu JA
  // siinä on ≥ HEAD_MIN_PX näkyvää pikseliä. Varat järjestyksessä: saman puhujan muut kuvat (live ensin,
  // sitten välimuistin uusimmasta vanhimpaan), viimeisenä hotellin oma avatar-kuvapalvelu puhujan NYKYISESTÄ
  // figuurista (sama /avatarimage jota client itse käyttää; headonly=1&size=l → 58x92).
  const quality = new Map(); // url -> Promise<'ok'|'blank'|'fail'>
  const headQuality = u => {
    if (quality.has(u)) return quality.get(u);
    const pr = new Promise(res => {
      try {
        const im = new Image(); const src = urlOf(u);
        if (!/^data:/i.test(src)) im.crossOrigin = 'anonymous';
        im.onload = () => {
          if (!(im.naturalWidth > 1 && im.naturalHeight > 1)) return res('fail');
          try { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const x = c.getContext('2d'); x.drawImage(im, 0, 0);
            const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 16) n++;
            res(n >= CFG.HEAD_MIN_PX ? 'ok' : 'blank'); } catch (e) { res('ok'); } // ristiinalkuperä: ei voi mitata → hyväksytään
        };
        im.onerror = () => res('fail'); im.src = src;
      } catch (e) { res('fail'); }
    });
    quality.set(u, pr); return pr;
  };
  const nameImageList = (all, name) => {
    const out = [];
    document.querySelectorAll('.nitro-chat-widget .bubble-container').forEach(el => { const b = readBubble(el); if (b && b.name === name && imgOk(b.image) && !out.includes(b.image)) out.push(b.image); });
    for (let i = all.length - 1; i >= 0; i--) { const e = all[i]; if (e.type === 1 && e.name === name && imgOk(e.image) && !out.includes(e.image)) out.push(e.image); }
    return out;
  };
  const figureOf = name => {
    try {
      const r = RE(); const sdm = own(r, '_sessionDataManager');
      if (sdm && own(sdm, '_name') === name && own(sdm, '_figure')) return own(sdm, '_figure');
      const sess = own(r, '_roomSessionManager').getSession(activeRoomId());
      const udm = sess && sess.userDataManager;
      const ud = udm && (typeof udm.getUserDataByName === 'function' ? udm.getUserDataByName(name) : null);
      return ud && ud.figure ? ud.figure : null;
    } catch (e) { return null; }
  };
  const imagerUrl = fig => `${location.origin}/avatarimage?figure=${encodeURIComponent(fig)}&headonly=1&size=l`;
  const verifyImages = async () => {
    if (!canvas || !S.src) return;
    const els = [...canvas.querySelectorAll('.kch-bubble .user-image')];
    const urls = [...new Set(els.map(x => x.dataset.src))];
    let fixed = 0, removed = 0, imager = 0; const why = {};
    for (const u of urls) {
      const q = await headQuality(u);
      if (q === 'ok') continue;
      why[q] = (why[q] || 0) + 1; bad.add(u);
      for (const x of els.filter(y => y.dataset.src === u)) {
        const nm = x.closest('.kch-bubble').dataset.name; let done = false;
        for (const alt of nameImageList(S.src.all || [], nm)) { if (alt !== u && !bad.has(alt) && await headQuality(alt) === 'ok') { x.style.backgroundImage = cssUrl(alt); x.dataset.src = alt; fixed++; done = true; break; } }
        if (!done) { const fig = figureOf(nm); if (fig) { const iu = imagerUrl(fig); if (await headQuality(iu) === 'ok') { x.style.backgroundImage = cssUrl(iu); x.dataset.src = iu; x.classList.add('kch-imager'); imager++; done = true; } } }
        if (!done) { x.remove(); removed++; }
      }
    }
    S.imgVerify = { urls: urls.length, bad: bad.size, why, fixed, imager, removed };
  };

  const fp = e => e ? `${e.at}|${e.name}|${e.message}` : '';

  // ---------------------------------------------------------------- paneeli
  const S = {
    open: false, mode: 'idle', startX: 0, startY: 0, startH: 0, startScroll: 0,
    closeLine: CFG.MIN_H, pinned: true, swallowTail: false,
    src: null, lastFp: '', xSources: null, imgVerify: null, roomMatch: null, layoutPanX: 0,
    opens: 0, closes: 0, lastCloseReason: '',
  };
  let panel = null, list = null, canvas = null;

  const widgetEl = () => document.querySelector('.nitro-chat-widget');
  const hostEl = () => { const w = widgetEl(); return (w && w.parentElement) || document.body; };
  const hostHeight = () => { const h = hostEl(); return (h && h.clientHeight) || window.innerHeight; };

  const ensurePanel = () => {
    ensureStyle();
    const host = hostEl();
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'kch-panel';
      panel.id = 'kch-panel';
      panel.innerHTML = '<div class="kch-bg"></div><div class="kch-list"><div class="kch-canvas"></div></div>' +
        '<div class="kch-grab"><div class="kch-stripe"><div class="kch-gripL"></div><div class="kch-handle"></div><div class="kch-gripR"></div></div>' +
        '<button type="button" class="kch-close" aria-label="Sulje"></button></div>';
      list = panel.querySelector('.kch-list');
      canvas = panel.querySelector('.kch-canvas');
      panel.querySelector('.kch-close').addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); close('x'); }, { signal: ac.signal });
      panel.addEventListener('wheel', ev => { ev.stopPropagation(); }, { signal: ac.signal, passive: true });
      list.addEventListener('scroll', () => { S.pinned = (list.scrollHeight - list.scrollTop - list.clientHeight) < 4; }, { signal: ac.signal, passive: true });
    }
    panel.style.position = host === document.body ? 'fixed' : '';
    if (panel.parentElement !== host) host.appendChild(panel);
    return panel;
  };

  // X oikeaan reunaan kuten SWF, mutta DarkUI:n HUD voi peittää reunan: siirretään vasemmalle
  // kunnes X on oikeasti päällimmäisenä (oma lisäys; SWF:ssä ei ollut päällä olevaa HUDia).
  const placeClose = () => {
    const g = panel.querySelector('.kch-grab'); const x = panel.querySelector('.kch-close');
    for (let inset = 3; inset < 900; inset += 24) {
      g.style.setProperty('--kch-x-inset', inset + 'px');
      const r = x.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && hit.closest && hit.closest('.kch-close')) return inset;
    }
    g.style.setProperty('--kch-x-inset', '3px');
    return -1;
  };

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cssUrl = u => { if (!u) return ''; return /^url\(/.test(u) ? u : `url("${String(u).replace(/"/g, '%22')}")`; };

  // v0.2.4 (Res: "alasvedon viestit on kapeampia kun nykyset"): DarkUI antaa live-kuplalle inline
  // max-widthin huoneen chat-asetuksesta (ChatWidgetMessageView.tsx getBubbleWidth: THIN 240 / NORMAL 350 /
  // WIDE 2000). v0.2.0–0.2.3 kovakoodasi 350 px, joten kapea/leveä-asetuksella historia erosi livestä.
  // Luetaan se live-kuplasta; ilman live-kuplaa käytetään viimeksi nähtyä.
  let lastMaxW = '350px';
  const liveMaxWidth = () => {
    const b = document.querySelector('.nitro-chat-widget .chat-bubble');
    const v = b && b.style && b.style.maxWidth;
    if (v && /^\d+(\.\d+)?px$/.test(v)) lastMaxW = v;
    return lastMaxW;
  };
  const bubbleEl = e => {
    const el = document.createElement('div');
    el.className = 'bubble-container visible kch-bubble kch-measure';
    const bg = (e.style === 0 && e.color) ? `<div class="user-container-bg" style="background-color:${esc(e.color)}"></div>` : '';
    const src = e.img !== undefined ? e.img : e.image;
    const img = src ? `<div class="user-image" data-src="${esc(src)}" style="background-image:${esc(cssUrl(src))}"></div>` : '';
    el.dataset.name = e.name;
    // name ja message ovat clientin omaa HTML:ää (sama kuin dangerouslySetInnerHTML clientissa)
    el.innerHTML = `${bg}<div class="chat-bubble ${esc(e.bubbleClass)}" style="max-width:${liveMaxWidth()}"><div class="user-container">${img}</div>` +
      `<div class="chat-content"><b class="username mr-1">${e.name}: </b><span class="message">${e.message}</span></div><div class="pointer"></div></div>`;
    if (e.time) el.title = e.time.replace('.', ':');
    return el;
  };

  // SWF-asettelu: x puhujan kohdalle, y alhaalta ylös 19/10 px välein
  const layout = () => {
    if (!S.open || !canvas || !S.src) return;
    const E = S.src.entries;
    const els = [...canvas.querySelectorAll('.kch-bubble')];
    if (!els.length) return;
    const W = list.offsetWidth || hostEl().clientWidth; // offsetWidth: ei muutu kun pystyvierityspalkki ilmestyy
    const hostLeft = hostEl().getBoundingClientRect().left;
    const lo = CFG.SIDE_MARGIN, hi = W - CFG.SCROLLBAR_W - CFG.SIDE_MARGIN;
    const box = els.map((el, i) => {
      const w = el.offsetWidth, h = el.offsetHeight;
      const r0 = el.getBoundingClientRect(), cc = el.querySelector('.chat-content');
      // tekstin OMA alareuna (glyfirivit, ei .chat-contentin paddingia)
      let textBottom = h - 10;
      if (cc) { try { const rg = document.createRange(); rg.selectNodeContents(cc); const rs = [...rg.getClientRects()].filter(q => q.height > 0);
        if (rs.length) textBottom = Math.ceil(Math.max(...rs.map(q => q.bottom)) - r0.top); } catch (err) {} }
      let sx = measuredX(E[i]); let how = 'measured';
      if (sx == null) { sx = speakerX(E[i], hostLeft); how = 'speaker-now'; }
      if (sx == null) { sx = W / 2 + panX(); how = 'centre'; } // kamerasta riippuva kuten muutkin
      let left = Math.round(sx - w / 2);
      left = Math.max(lo, Math.min(hi - w, left));
      return { el, w, h, left, sx, how, textBottom };
    });
    // y: uusin top = 0, vanhemmat ylöspäin
    const n = box.length;
    box[n - 1].top = 0;
    const hOverlap = (a, b) => a.left < b.left + b.w && b.left < a.left + a.w;
    // SWF: 19 px riittää, koska SWF-kuplan teksti päättyy y=15 (tausta 24). DarkUI:n teksti on alempana ja
    // voi olla monirivinen, joten uudempi kupla ei saa peittää vanhemman tekstiä: väli = max(19, tekstin alareuna + 1).
    const pitchRow = b => Math.max(CFG.PITCH_ROW, b.textBottom + 1);
    for (let i = n - 2; i >= 0; i--) {
      const a = box[i], b = box[i + 1];
      let top = b.top - (hOverlap(a, b) ? pitchRow(a) : CFG.PITCH_FREE);
      for (let j = i + 2; j < Math.min(n, i + 2 + CFG.GUARD_DEPTH); j++) {
        if (hOverlap(a, box[j])) top = Math.min(top, box[j].top - pitchRow(a));
      }
      a.top = top;
    }
    const minTop = box[0].top < 0 ? Math.min(...box.map(b => b.top)) : 0;
    const last = box[n - 1];
    // SWF: uusimman yläreuna 42 px sisällön alareunasta; monirivinen DarkUI-kupla ei saa mennä palkin alle,
    // joten väli alareunaan on vähintään 13 px (SWF:n osoittimen kärjen etäisyys palkista).
    const bottomPad = Math.max(CFG.BOTTOM_MIN_GAP, CFG.BOTTOM_TOP_OFFSET - last.h);
    const contentH = (last.top - minTop) + last.h + bottomPad + 8;
    canvas.style.height = contentH + 'px';
    const counts = { measured: 0, 'speaker-now': 0, centre: 0 };
    for (const b of box) {
      b.el.style.left = b.left + 'px';
      b.el.style.bottom = (bottomPad + (last.top + last.h) - (b.top + b.h)) + 'px';
      const ptr = b.el.querySelector('.pointer');
      const inRange = b.how !== 'centre' && b.sx >= lo && b.sx <= hi;
      b.el.classList.toggle('kch-noptr', !inRange);
      if (ptr && inRange) {
        const px = Math.max(6, Math.min(b.w - 15, Math.round(b.sx - b.left - 4.5)));
        ptr.classList.add('kch-ptr'); b.el.style.setProperty('--kch-ptr-x', px + 'px');
      }
      b.el.classList.remove('kch-measure');
      b.el.dataset.how = b.how;
      counts[b.how]++;
    }
    S.xSources = counts;
    S.layoutPanX = panX();
  };

  const renderAll = () => {
    const keepFromBottom = list ? (list.scrollHeight - list.scrollTop) : 0;
    const wasPinned = S.pinned;
    S.src = getSource();
    const E = S.src.entries;
    canvas.textContent = '';
    canvas.style.height = '';
    S.lastFp = fp(E[E.length - 1]);
    if (!E.length) { canvas.innerHTML = '<div class="kch-empty">Ei vielä historiaa tässä huoneessa.</div>'; return; }
    sweepLive();
    const frag = document.createDocumentFragment();
    for (const e of E) frag.appendChild(bubbleEl(e));
    canvas.appendChild(frag);
    layout();
    if (wasPinned) pinBottom(); else list.scrollTop = list.scrollHeight - keepFromBottom;
    verifyImages();
  };

  const refresh = () => {
    if (!S.open || !list) return;
    const next = getSource();
    if (S.src && next.kind === S.src.kind && next.key === S.src.key && fp(next.entries[next.entries.length - 1]) === S.lastFp) return;
    renderAll();
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
    const wasOpen = S.open;
    S.open = true;
    S.closeLine = Math.max(CFG.MIN_H, closeLine == null ? CFG.MIN_H : closeLine);
    panel.classList.add('kch-open');
    setHeight(height == null ? Math.round(hostHeight() * 0.5) : height);
    if (!wasOpen) { S.pinned = true; sweepLive(); document.body.classList.add('kch-active'); renderAll(); S.opens++; placeClose(); }
    pinBottom();
  };

  const close = reason => {
    if (!S.open || !panel) return;
    S.open = false; S.mode = 'idle'; S.closes++; S.lastCloseReason = reason || '';
    panel.classList.remove('kch-open');       // piiloon heti
    document.body.classList.remove('kch-active'); // live-chat heti takaisin
    panel.style.height = '0px';
    if (canvas) canvas.textContent = '';
    S.src = null;
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
        // SWF RoomChatWidget._Str_23995 (:977-1026): vedon alussa alue kutistuu juuri alimman live-kuplan
        // alle ja kuplia siirretään niin, etteivät ne hyppää; sen jälkeen alue kasvaa vedon verran
        // (_Str_23426 :904-908) ja kuplat (alhaalle ankkuroituina, _Str_19662) kulkevat vedon mukana.
        // Tässä: sisällön korkeus H0 valitaan niin, että historian uusin kupla (top = H0 − 42) osuu
        // täsmälleen alimman live-kuplan kohdalle, ja alue kasvaa siitä osoittimen mukana.
        const hostTop = hostEl().getBoundingClientRect().top;
        let liveTop = null, liveH = 0;
        document.querySelectorAll('.nitro-chat-widget .bubble-container').forEach(b => {
          const q = b.getBoundingClientRect(); const t = q.top - hostTop; if (liveTop === null || t > liveTop) { liveTop = t; liveH = q.height; } });
        // sama sääntö kuin layout(): uusimman yläreuna = H − max(42, h + 13)
        const H0 = liveTop !== null ? liveTop + Math.max(CFG.BOTTOM_TOP_OFFSET, liveH + CFG.BOTTOM_MIN_GAP) : (S.startY - hostTop) + CFG.GRAB_H / 2;
        S.mode = 'resize';
        S.startH = H0 + CFG.GRAB_H;   // paneelin korkeus = H0 + palkki; tästä eteenpäin + (osoitin − aktivointikohta)
        S.startY = e.clientY;
        open(S.startH, H0 + CFG.CLOSE_PULL);
        swallow(e);
      } else if (dy < -CFG.HYSTERESIS || Math.abs(dx) > CFG.ABORT_DX) {
        S.mode = 'idle';
      }
      return;
    }
    if (S.mode === 'resize') { if (panel) setHeight(S.startH + dy); swallow(e); return; }
    if (S.mode === 'scrollpend') {
      if (Math.abs(dy) > CFG.HYSTERESIS) S.mode = 'scroll';
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
    if (mode === 'resize' && panel) {
      const hostTop = hostEl().getBoundingClientRect().top;
      // SWF _Str_20437 (:1028-1049): vapautus niin, ettei alue kasvanut perusrajan yli → sulkeutuu
      const barTop = panelBottom() - hostTop - CFG.GRAB_H;
      if (barTop < S.closeLine) close('drag-up');
    }
    swallow(e);
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
  on(window, 'blur', () => { if (S.mode !== 'idle') S.mode = 'idle'; }, false);
  on(window, 'resize', () => { if (S.open) layout(); }, false);

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
        if (n instanceof Element && n.classList.contains('bubble-container')) {
          // paikka asetetaan mountin jälkeen: mitataan hetken päästä
          later(() => measureBubble(n, true), 120);
          added = true;
        }
      }
      if (added) scheduleRefresh();
    });
    mo.observe(w, { childList: true });
  };
  attachObserver();
  sweepLive();
  intervals.push(setInterval(attachObserver, 2000));
  intervals.push(setInterval(() => { if (S.open) refresh(); }, CFG.POLL_MS));
  // kamera liikkuu historian ollessa auki → kuplien x uudelleen (y ei muutu, kuten livessä)
  intervals.push(setInterval(() => { if (S.open && S.mode === 'idle' && panX() !== S.layoutPanX) layout(); }, 100));

  // ---------------------------------------------------------------- API
  const destroy = () => {
    ac.abort();
    intervals.forEach(clearInterval); intervals.length = 0;
    timeouts.forEach(clearTimeout); timeouts.clear();
    if (mo) mo.disconnect(); mo = null; observed = null;
    if (panel) panel.remove(); panel = null; list = null; canvas = null;
    const st = document.getElementById(STYLE_ID); if (st) st.remove();
    document.body.classList.remove('kch-active');
    S.open = false; S.mode = 'idle';
    if (window[NS] && window[NS]._S === S) delete window[NS];
  };

  window[NS] = {
    version: VERSION,
    _S: S,
    _t: { resolveImages: (entries, all) => resolveImages(entries, all || (S.src && S.src.all) || []), verifyImages, headQuality, figureOf, imagerUrl, roomSegment: all => roomSegment(all).length, roomMatch: () => S.roomMatch, cfg: CFG },
    open: h => open(h, CFG.MIN_H),
    close: () => close('api'),
    destroy,
    // Resille: liitä konsoliin __kuplaChatHistoria.diag() ja lähetä tulos (ei viestien tekstiä)
    diag: async () => {
      const c = loadCache(); if (!c) return { cache: null };
      const by = {};
      for (const e of c.entries) { if (e.type !== 1) continue; const k = e.name; const b = by[k] = by[k] || { n: 0, noImg: 0, kinds: {}, urls: new Set() };
        b.n++; if (!imgOk(e.image)) b.noImg++; const kd = !e.image ? 'none' : urlOf(e.image).slice(0, 5); b.kinds[kd] = (b.kinds[kd] || 0) + 1; if (e.image) b.urls.add(e.image); }
      const me = own(own(RE(), '_sessionDataManager'), '_name') || null;
      const rooms = {}; let lastEnter = null;
      c.entries.forEach((e, i) => { const k = String(e.roomId); rooms[k] = rooms[k] || { chat: 0, enters: 0 }; if (e.type === 1) rooms[k].chat++; if (e.type === 2) { rooms[k].enters++; lastEnter = { index: i, roomId: e.roomId, rowsAfter: c.entries.length - 1 - i }; } });
      const seg = roomSegment(c.entries);
      const fm = sel => { const x = document.querySelector(sel); if (!x) return null; const c2 = getComputedStyle(x); return c2.fontSize + ' ' + c2.fontFamily.split(',')[0] + ' ' + c2.fontWeight; };
      const bubbleMetrics = { liveMaxWidth: liveMaxWidth(), liveBubbleInlineMaxW: (document.querySelector('.nitro-chat-widget .chat-bubble') || { style: {} }).style.maxWidth || null,
        liveFont: fm('.nitro-chat-widget .message'), historyFont: fm('#kch-panel .message'), zoom: window.devicePixelRatio, viewport: innerWidth + 'x' + innerHeight };
      const out = { key: c.key, me, version: VERSION, bubbleMetrics, activeRoomId: activeRoomId(), roomsInCache: rooms, lastRoomEnter: lastEnter, shown: seg.length, roomMatch: S.roomMatch, speakers: {} };
      for (const k in by) { const b = by[k]; const dec = []; for (const u of [...b.urls].slice(-3)) dec.push({ len: u.length, head: urlOf(u).slice(0, 22), decodes: await decodeOk(u) });
        out.speakers[k === me ? k + ' (OMA)' : k] = { n: b.n, noImg: b.noImg, kinds: b.kinds, distinctImgs: b.urls.size, lastImgs: dec }; }
      return out;
    },
    state: () => ({
      version: VERSION, open: S.open, mode: S.mode, opens: S.opens, closes: S.closes,
      lastCloseReason: S.lastCloseReason, source: S.src ? S.src.kind : null, key: S.src ? S.src.key : null,
      total: S.src ? S.src.entries.length : null, roomMatch: S.roomMatch, rendered: canvas ? canvas.querySelectorAll('.kch-bubble').length : 0,
      height: panel ? Math.round(panel.getBoundingClientRect().height) : 0, pinned: S.pinned,
      closeLine: S.closeLine, xSources: S.xSources, img: S.src ? S.src.img : null, imgVerify: S.imgVerify, seen: seen.length, domBuffer: domBuffer.length,
      panelInDom: !!(panel && panel.isConnected), liveHidden: document.body.classList.contains('kch-active'),
    }),
  };
})();
