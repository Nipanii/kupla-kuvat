// ==UserScript==
// @name         kupla: chat-kupla pysähtyy reunaan
// @namespace    kupla
// @version      0.1.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/chat-reuna.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/chat-reuna.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @description  Livechatin kupla pysähtyy ikkunan reunaan omassa koossaan eikä litisty (huoneen raahaus reunaan). Sama korjaus kuin PR robo/pulldown-resize. Poista kun PR on deployattu.
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// kp 7.10. 17:02 "jos huonetta draggaa niin et kuplat menee oik reunaan niin kuplat venyy korkeussuunnassa ja litistyy" ·
// "kuplan pitäs vaan pysähtyä reunaan kun se osuu sinne". Syy: .bubble-container { width: fit-content } — selain kaventaa
// kuplaa reunassa (mitattu 877 px ikkunassa 116x29 -> 46x271). Korjaus: width: max-content + kupla piirretään
// left = clamp(0, x, 100% - leveys). Sisäinen chat.left seuraa puhujaa, joten kupla palaa kun huone raahataan takaisin.
// Mitattu robon clientissä (hidas 460 px raahaus, 20 s pito, paluu): kaikki 29 px korkeina omalla leveydellä, tasan reunassa,
// 0 yli, palasivat alkupaikoilleen.
(() => {
  if (window.__kuplaChatReuna) return;
  const css = document.createElement('style');
  css.id = 'kupla-chat-reuna-css';
  css.textContent = '.nitro-chat-widget .bubble-container { width: max-content; }';
  (document.head || document.documentElement).appendChild(css);

  // ChatBubbleMessage on livekuplan props.chat (React fiber); sen prototyypin left-setteri kirjoittaa style.left:n
  const chatOf = (el) => {
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    let f = key ? el[key] : null;
    for (let i = 0; f && i < 12; i++, f = f.return) if (f.memoizedProps && f.memoizedProps.chat) return f.memoizedProps.chat;
    return null;
  };
  const liveBubbles = () => [...document.querySelectorAll('.nitro-chat-widget .bubble-container')].filter(e => !e.classList.contains('chat-pulldown-bubble'));

  let patched = null;
  const patch = () => {
    if (patched) return true;
    const el = liveBubbles()[0];
    const chat = el && chatOf(el);
    if (!chat) return false;
    const proto = Object.getPrototypeOf(chat);
    const d = Object.getOwnPropertyDescriptor(proto, 'left');
    if (!d || !d.get || !d.set) return false;
    Object.defineProperty(proto, 'left', {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set(value) {
        d.set.call(this, value);
        if (this.elementRef) this.elementRef.style.left = 'clamp(0px, ' + d.get.call(this) + 'px, calc(100% - ' + this.width + 'px))';
      }
    });
    patched = { proto, d };
    for (const e of liveBubbles()) { const c = chatOf(e); if (c) c.left = c.left; }
    return true;
  };

  // ensimmäinen livekupla kertoo luokan; siihen asti tarkkaillaan
  const mo = new MutationObserver(() => { if (patch()) mo.disconnect(); });
  if (!patch()) mo.observe(document.body, { childList: true, subtree: true });

  window.__kuplaChatReuna = {
    versio: '0.1.0',
    get paalla() { return !!patched; },
    pois() {
      mo.disconnect(); css.remove();
      if (patched) { Object.defineProperty(patched.proto, 'left', patched.d); for (const e of liveBubbles()) { const c = chatOf(e); if (c) c.left = c.left; } }
      patched = null; delete window.__kuplaChatReuna;
    }
  };
})();
