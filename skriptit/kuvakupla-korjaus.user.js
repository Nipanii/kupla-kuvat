// ==UserScript==
// @name         Kupla Kuvakupla-korjaus
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-idle
// @grant        none
// @version      0.1.0
// @description  Gif/kuvakuplat eivät enää jää päällekkäin eivätkä tekstikuplien alle: kun kupla kasvaa kuvan latauduttua, se ja vanhemmat kuplat siirtyvät ylös kasvun verran.
// @kupla-oletus on
// @author       re-lab
// ==/UserScript==
//
// kp 2026-10-04 16:20 (Datajako, kuvat): "aika pahasti menee giffit ja puhekuplat" · 16:31 "no tee lisäosa alkuun".
// SYY (kupla-cc DarkUI, luettu 2026-10-04, commit 5139802a): ChatWidgetMessageView.tsx:69 mittaa kuplan korkeuden KERRAN
//   mountissa; KuplaFixChatImagePreview <img loading="lazy"> ei varaa korkeutta -> chat.height jää tekstikuplan korkuiseksi,
//   kupla kasvaa alaspäin uusien kuplien päälle ja pinoutuminen laskee vanhalla korkeudella.
// KORJAUS: ResizeObserver jokaiseen huonechatin .bubble-containeriin. Kasvu delta -> chat.height päivitetään ja tämä kupla +
//   kaikki vanhemmat (pienempi chat.id) siirretään ylös deltan verran. chat.top-setteri kirjoittaa style.topin itse.
//   chat-olio haetaan React-fiberistä (memoizedProps.chat) — mitattu 16:3x kp:n clientissä: id/top/height/elementRef löytyvät.
// RAJA: vain kasvu korjataan (kutistuminen jättää välin, ei päällekkäisyyttä). PR Resille vasta kun Res on kokeillut tätä.
(() => {
  'use strict';
  const VW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (VW.__kuplaKuvakupla) return; VW.__kuplaKuvakupla = true;
  const seurattu = new WeakSet();
  const chatOf = el => {
    const k = Object.keys(el).find(x => x.startsWith('__reactFiber$')); let f = k && el[k];
    for (let i = 0; i < 8 && f; i++) { const c = f.memoizedProps && f.memoizedProps.chat; if (c && typeof c.id === 'number') return c; f = f.return; }
    return null;
  };
  const kuplat = () => [...document.querySelectorAll('.bubble-container')].filter(e => !e.closest('.chat-history-list'));
  const tila = VW.__kuvakuplaTila = { korjauksia: 0, viimeisin: null };
  const ro = new ResizeObserver(entries => {
    for (const en of entries) {
      const el = en.target; if (!el.isConnected) continue;
      const c = chatOf(el); if (!c || c.elementRef !== el) continue;
      const uusi = el.offsetHeight, delta = uusi - c.height;
      if (!(delta > 0) || !c.height) { if (!c.height) c.height = uusi; continue; }
      c.height = uusi;
      for (const e2 of kuplat()) { const c2 = chatOf(e2); if (c2 && c2.id <= c.id) c2.top = c2.top - delta; }
      tila.korjauksia++; tila.viimeisin = { id: c.id, delta, t: Date.now() };
    }
  });
  const liita = () => { for (const e of kuplat()) if (!seurattu.has(e)) { seurattu.add(e); ro.observe(e); } };
  const mo = new MutationObserver(liita); mo.observe(document.body, { childList: true, subtree: true });
  liita();
  // pois ilman sivun päivitystä (Datajako-kortin ⏹ Kumoa ja lisäosan poisto kutsuvat tätä)
  VW.__kuvakuplaPois = () => { ro.disconnect(); mo.disconnect(); VW.__kuplaKuvakupla = false; return 'kuvakupla-korjaus pois'; };
})();
