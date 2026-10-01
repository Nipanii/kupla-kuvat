// ==UserScript==
// @name         Kupla Emojihaku-korjaus
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      1.0.0
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
  new MutationObserver(ms => { for (const m of ms) {
    if (m.type === 'attributes' && m.target.classList && m.target.classList.contains('nitro-chat-emoji-selector-container')) tarkista(m.target);
    else if (m.type === 'childList') for (const n of m.addedNodes) if (n.nodeType === 1) { const p = n.matches('.nitro-chat-emoji-selector-container') ? n : n.querySelector && n.querySelector('.nitro-chat-emoji-selector-container'); if (p) tarkista(p); }
  } }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  VW.kuplaEmojihakuFix = { korjattu: () => korjattu };
})();
