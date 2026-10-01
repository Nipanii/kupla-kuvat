// ==UserScript==
// @name         Kupla Pitkä viesti
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      1.1.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/pitka-viesti.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/pitka-viesti.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Poistaa chatin 100 merkin rajan: pidempi viesti pilkotaan sanojen välistä enintään 100 merkin osiin, jotka lähtevät heti peräkkäin. Komennot (:) ja kuiskaukset menevät kuten ennen.
// @kupla-oletus on
// @author       re-lab
// ==/UserScript==
//
// kp 2026-10-02 00:34: "tee script et poistaa ton 100 merkin rajan ja yli menevä osa splittaantuu nätisti ite ja menee jonoo
//   ja lähtee heti perää loput osat". Palvelin ja client katkaisevat 100:ssa (DarkUI chat.input.maxlength = 100), joten raja
//   poistetaan VAIN kirjoituskentästä ja lähetys tehdään pelin omalla Enter-polulla osa kerrallaan (ei omia paketteja).
(() => {
  'use strict';
  const VW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (VW.__kuplaPitkaViesti) return; VW.__kuplaPitkaViesti = true;
  const MAX = 100, VALI = 700;   // ms osien välillä: kuplan floodiesto (mitattu 2.10.: ks. testi)
  const SEL = 'input.nitro-chat-input-control';
  const asetaArvo = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  // SAMA kuin nitro/pilko-viesti.js (kp 2.10. 00:45): lauseen loppu > pilkku > välilyönti, tasakokoiset osat. Muuta molempia.
  function pilko(t, max = MAX) {
    let s = String(t).trim().replace(/\s+/g, ' '); if (s.length <= max) return [s];
    const osat = [];
    while (s.length > max) {
      const n = Math.ceil(s.length / max), tavoite = Math.ceil(s.length / n);
      let paras = -1, pist = -Infinity;
      for (let i = Math.floor(max * .35); i <= max && i < s.length; i++) {
        if (s[i] !== ' ') continue;
        const ed = s[i - 1], laatu = /[.!?…]/.test(ed) ? 3 : /[,;:)]/.test(ed) ? 2 : /[-]/.test(s[i + 1] || '') ? 1.5 : 1;
        const p = laatu * 40 - Math.abs(i - tavoite) * .6;   // lauseen loppu voittaa ~65 merkin tasapainoeron, pilkku ~33
        if (p > pist) { pist = p; paras = i; }
      }
      if (paras < 0) paras = max;   // ei välilyöntiä (pitkä linkki tms.): kova katkaisu
      osat.push(s.slice(0, paras).trim()); s = s.slice(paras).trim();
    }
    if (s) osat.push(s);
    return osat;
  }
  const vapauta = () => { if (VW.__kuplaPitkaPois) return; const el = document.querySelector(SEL); if (el && el.maxLength !== -1 && el.maxLength < 2000) el.maxLength = 2000; };
  new MutationObserver(vapauta).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['maxlength'] }); vapauta();
  let jono = [], kaynnissa = false;
  const laheta = () => { const el = document.querySelector(SEL); const seur = jono.shift(); if (!el || seur == null) { kaynnissa = false; return; }
    el.focus(); asetaArvo(el, seur); VW.__kuplaPitkaOhita = true;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); VW.__kuplaPitkaOhita = false;
    if (jono.length) setTimeout(laheta, VALI); else kaynnissa = false; };
  addEventListener('keydown', e => {
    if (VW.__kuplaPitkaOhita || VW.__kuplaPitkaPois || (e.key !== 'Enter' && e.key !== 'NumpadEnter') || e.shiftKey) return;
    const el = e.target; if (!(el instanceof HTMLInputElement) || !el.matches(SEL)) return;
    const v = el.value; if (v.length <= MAX || v.startsWith(':')) return;
    const osat = pilko(v); asetaArvo(el, osat.shift());   // ensimmäinen osa lähtee tällä samalla Enterillä pelin omasta käsittelijästä
    jono.push(...osat); if (!kaynnissa) { kaynnissa = true; setTimeout(laheta, VALI); }
  }, true);
  VW.kuplaPitkaViesti = { pilko, jono: () => jono.slice() };
})();
