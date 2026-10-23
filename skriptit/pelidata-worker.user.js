// ==UserScript==
// @name         Kupla Pelidata Worker
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @run-at       document-start
// @grant        none
// @version      1.0.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/pelidata-worker.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/pelidata-worker.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  F5 nopeammaksi: pelidatan JSONit (FurnitureData ym.) haetaan ja luetaan workerissa, client saa valmiin vastauksen muistista. Sama korjaus kuin PR 577, ilman buildia.
// ==/UserScript==
//
// 1.0.0 (Res 2026-10-23 17:04 "onko userscriptiä"; PR https://github.com/0-es/kupla-cc/pull/577):
//   MITATTU (lab-kone i7-6700K, robon client): FurnitureData.json on purettuna 13,5 Mt ja sen rungon luku pääsäikeessä
//   (response.text() / arrayBuffer()) vie ~1,2 s, kun sama data muistissa olevasta vastauksesta (new Response(ArrayBuffer).text())
//   vie 72 ms. Tämä kääre ohjaa /nitro-assets/gamedata/*.json -haut workeriin ja antaa clientille new Response(ArrayBuffer):n,
//   joten clientin koodi (JsonParser.ts fetch -> text -> JSON.parse) ei muutu.
//   Muut pyynnöt, ja haut joissa on muita asetuksia kuin cache/credentials, menevät suoraan alkuperäiselle fetchille.
//   Jos worker kaatuu, kääre kytkeytyy pois ja kaikki menee alkuperäiselle fetchille.
// RAJA: vaatii että skripti ajetaan ennen clientin bundlea (document-start, @grant none = sivun oma konteksti).
(() => {
    'use strict';
    const alkuperainen = window.fetch.bind(window);
    const OSUMA = /\/nitro-assets\/gamedata\/[^?#]+\.json(?:[?#]|$)/i;
    const LAHDE = `onmessage = async (e) => {
        const { id, url, init } = e.data;
        try {
            const r = await fetch(url, init);
            const b = await r.arrayBuffer();
            postMessage({ id, status: r.status, statusText: r.statusText, tyyppi: r.headers.get('content-type') || '', b }, [ b ]);
        } catch (err) { postMessage({ id, virhe: (err && err.message) || String(err) }); }
    };`;
    let worker = null, rikki = false, seuraava = 1;
    const odottaa = new Map();
    const kaada = () => { rikki = true; try { worker && worker.terminate(); } catch (e) {} worker = null;
        for (const o of odottaa.values()) o.hylkaa(new Error('worker kaatui')); odottaa.clear(); };
    const anna = () => {
        if (worker || rikki) return worker;
        try {
            worker = new Worker(URL.createObjectURL(new Blob([ LAHDE ], { type: 'text/javascript' })));
            worker.onmessage = e => { const o = odottaa.get(e.data && e.data.id); if (!o) return; odottaa.delete(e.data.id); o.ratkaise(e.data); };
            worker.onerror = kaada;
        } catch (e) { rikki = true; worker = null; }
        return worker;
    };
    const sopivaInit = init => {
        if (!init) return {};
        for (const k of Object.keys(init)) if (init[k] !== undefined && k !== 'cache' && k !== 'credentials') return null;
        return { cache: init.cache, credentials: init.credentials };
    };
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : null);
        const winit = url && OSUMA.test(url) ? sopivaInit(init) : null;
        const w = winit && anna();
        if (!w) return alkuperainen(input, init);
        const id = seuraava++, abs = new URL(url, location.href).href;
        return new Promise((ratkaise, hylkaa) => { odottaa.set(id, { ratkaise, hylkaa }); w.postMessage({ id, url: abs, init: winit }); })
            .then(v => {
                if (v.virhe !== undefined) throw new TypeError(v.virhe);
                return new Response(v.b, { status: v.status, statusText: v.statusText, headers: v.tyyppi ? { 'content-type': v.tyyppi } : {} });
            }, () => alkuperainen(input, init));
    };
})();
