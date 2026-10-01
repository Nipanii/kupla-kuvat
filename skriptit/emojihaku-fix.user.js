// ==UserScript==
// @name         Kupla Emojihaku-korjaus
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      1.0.1
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/emojihaku-fix.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/emojihaku-fix.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Väliaikainen korjaus: emojivalitsimen haku ei enää menetä fokusta kirjaimen jälkeen (kirjoitus ei hyppää chattiin). Poista kun pelin oma korjaus tulee.
// @kupla-oletus on
// @author       re-lab
// ==/UserScript==
//
// kp 2026-10-02 00:48 "emoji haku EI TYKKÄÄ manuaalisesta hausta / pomppii tonne normi kirjotusalueelle / sit se menee se koko haku
//   kii jos ei kirjota tosi hitaasti" -> 00:55 "tee mulle alkuun lisäri emoji hakuun".
// SYY (DarkUI ChatInputEmojiSelectorView.tsx): useLayoutEffect riippuu `search`ista ja kutsuu setPopoverPosition(null) ->
//   popover saa visibility:hidden + left/top 0 yhdeksi ruuduksi -> selain poistaa fokuksen piilotetusta hakukentästä ->
//   seuraava näppäin menee chat-kenttään. KORJAUS: MutationObserver (mikrotehtävä, ajetaan ENNEN piirtoa) palauttaa edellisen
//   näkyvän paikan heti kun popover piilotetaan JA sen sisällä on fokus. Seuraavassa ruudussa React asettaa oikean paikan itse.
(() => {
  'use strict';
  const VW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (VW.__kuplaEmojihakuFix) return; VW.__kuplaEmojihakuFix = true;
  const viim = new WeakMap(); let korjattu = 0;
  const tarkista = el => {
    const s = el.style;
    if (s.visibility !== 'hidden') { viim.set(el, { left: s.left, top: s.top }); return; }
    const v = viim.get(el);
    if (v && el.contains(document.activeElement) && !VW.__kuplaEmojihakuPois) { s.left = v.left; s.top = v.top; s.visibility = 'visible'; korjattu++; }
  };
  // 1.0.1 kp 00:57 "outo latenssi": ei enää koko sivun style-tarkkailua. Body-tason lapset (portaali) tarkkaillaan ilman subtreeta,
  // ja vain löytyneen popoverin oma style-attribuutti.
  const seuratut = new WeakSet(), tyylit = new MutationObserver(ms => { for (const m of ms) tarkista(m.target); });
  const liita = p => { if (!p || seuratut.has(p)) return; seuratut.add(p); tarkista(p); tyylit.observe(p, { attributes: true, attributeFilter: ['style'] }); };
  const etsi = n => n && n.nodeType === 1 && (n.matches('.nitro-chat-emoji-selector-container') ? n : n.querySelector('.nitro-chat-emoji-selector-container'));
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) liita(etsi(n)); }).observe(document.body, { childList: true });
  liita(document.querySelector('.nitro-chat-emoji-selector-container'));
  VW.kuplaEmojihakuFix = { korjattu: () => korjattu };
})();
