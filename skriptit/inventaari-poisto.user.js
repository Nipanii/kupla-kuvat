// ==UserScript==
// @name         Varaston poisto-nappi (vain UI-prototyyppi)
// @namespace    https://re-lab.local/kupla
// @match        https://kupla.cc/*
// @grant        none
// @run-at       document-idle
// @version      0.1.0
// @updateURL    https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/inventaari-poisto.user.js
// @downloadURL  https://raw.githubusercontent.com/Nipanii/kupla-kuvat/main/skriptit/inventaari-poisto.user.js
// @homepageURL  https://github.com/Nipanii/kupla-kuvat
// @kupla-oletus off
// @description  Lisää varaston huonekalunäkymään "Poista"-napin, joka avaa määrädialogin ja vahvistusvaiheen. EI lähetä mitään palvelimelle: vahvistus vain kirjoittaa konsoliin.
// @author       re-lab
// ==/UserScript==
//
// Lähde: Res 24.11. 12:15-12:19 ("robo onko itemi poisto ui testi skriptiä" / "joo pelkkä ui simppeli ei mitää ekstraa" / "tee pelkkä ui").
// Ulkoasu ja tekstit kopioitu PR 937:stä (haara origin/robo/delete-item-plugin, kupla-cc), tiedostot:
//   client/DarkUI/src/components/inventory/views/furniture/InventoryFurnitureDeleteView.tsx  (dialogi: rivit 108-169, tekstit rivit 86-92 ja 110, 124, 155, 163)
//   client/DarkUI/src/components/inventory/views/furniture/InventoryFurnitureView.tsx        (nappi: diffissä rivit 158-172, variant="danger", fullWidth, teksti 'Poista')
//   client/DarkUI/src/components/inventory/InventoryView.scss                                (.nitro-inventory-delete { width: 340px; max-width: calc(100vw - 16px); height: auto; } rivit 123-128)
// MITÄ KOPIOITIIN: dialogin rakenne (kortti theme-primary-slim, otsikko "Poista esine", vasemmalla esineen kuva, oikealla nimi,
//   "Saatavilla: N", vähennä / syöttökenttä / lisää / "Max" -rivi, koko leveyden "Poista"-nappi), vahvistusteksti
//   "Haluatko varmasti poistaa %amount% kpl esinettä %furniname%? Poisto on pysyvä." ja syötteen rajaus 1..ryhmän määrä (clampAmount, rivit 53-79).
// EI KOPIOITU: DeleteItemMessageComposer / SendMessageComposer (rivi 98 PR:ssä) eli paketin lähetys. Tässä ei ole yhtään lähetystä, ei
//   pelin kutsua eikä verkkoyhteyttä. Vahvistus kirjoittaa vain konsoliin ja näyttää tekstin dialogissa.
// POIKKEAMAT PR:STÄ (kaikki ilmoitettu raportissa):
//   - PR:n MAX_DELETE_PER_REQUEST = 500 jätetty pois (Resin speksissä rajaus on 1..ryhmän määrä; 500 on PR:n oma luku, ei tämän tehtävän).
//   - PR avaa vahvistuksen pelin showConfirm-ikkunana; tässä vahvistus on saman dialogin sisällä (ei ole sendiä jota sen takana pitäisi suojata).
//   - Vahvistuksen napit: "Poista" (PR rivi 163) ja "Peruuta" (PR käyttää LocalizeText('generic.cancel'), arvoa ei löytynyt lähteistä: teksti on oma).
//   - Tulosteksti jää näkyviin kunnes käyttäjä sulkee dialogin (PR:ssä ei ole ajastinta vastaavassa kohdassa).
//
// VALITSIMET, johdettu liven clientistä D:/kupla-lahde/main-live/client/DarkUI/src/ (commit caace756):
//   .nitro-inventory                      components/inventory/InventoryView.tsx:148 (className="nitro-inventory")
//   .nitro-card-tabs .nav-item(.active)   common/card/tabs/NitroCardTabsView.tsx:10 ('nitro-card-tabs'), NitroCardTabsItemView.tsx:17,19 ('nav-item', 'active');
//                                         ensimmäinen välilehti = huonekalut: InventoryView.tsx:12,16 (TABS[0] = TAB_FURNITURE)
//   .room-preview-container               common/layout/LayoutRoomPreviewerView.tsx:266 (huonekalunäkymän esikatselu, ankkuri oikean sarakkeen löytämiseen);
//                                         oikea sarake = Column size=5, InventoryFurnitureView.tsx:124-125, valinnan sarake :133, nappisarake :135
//   .layout-grid-item.active              common/layout/LayoutGridItem.tsx:28,30 (valittu solu)
//   .unique-item                          LayoutGridItem.tsx:32 (uniikki esine: PR piilottaa napin, !stuffData.isUnique, InventoryFurnitureView.tsx diff rivi 161)
//   .nitro-item-count                     common/layout/LayoutItemCountView.tsx:15 (määrälaatta; näkyy vain kun määrä > 1, LayoutGridItem.tsx:23 itemCountMinimum = 1)
//   .text-truncate (nimirivi)             InventoryFurnitureView.tsx:134 (<Text variant='white' small truncate>), Text.tsx:31,45,51
//   #draggable-windows-container          common/draggable-window/DraggableWindow.tsx:332 (mihin pelin ikkunat portaloidaan), common/index.scss:312,327-331
//   dialogin luokat (nitro-card ym.)      NitroCardView.tsx:18,20 · NitroCardHeaderView.tsx:20,39,45 · NitroCardContentView.tsx:10 · Button.tsx:37,66,68 · Text.tsx · Grid.tsx:26-29 · Column.tsx:26,28
// RAJAT (ei todennettu elävällä DOMilla):
//   - Oikean sarakkeen lapsirakenne (previewer-sarake, valinnan sarake, nappisarake viimeisenä) on johdettu JSX:stä, ei nähty selaimessa.
//   - Valitun esineen määrä luetaan .nitro-item-count -laatasta (puuttuu = 1). Lukittuja esineitä (PR:n unlockedItems) skripti ei erota: laatta näyttää getUnlockedCount()-arvon
//     (InventoryFurnitureView.tsx:121), mutta kun kaikki ryhmän esineet ovat lukittuja, määrä 0 ei näy laatasta, joten nappi voi näkyä silloinkin.
//   - Esineen kuva otetaan valitun solun taustakuvasta (computed style); jos solun kuva piirtyy muuten, kuva-alue jää tyhjäksi.
//   - Dialogi sijoitetaan keskelle omalla tyylillä, ei pelin DraggableWindow-logiikalla (ei raahausta).
//   Poisto: ota ruksi pois loaderista.
(function () {
  'use strict';
  if (window.__kuplaInventaariPoisto) return; window.__kuplaInventaariPoisto = true;

  const LOG = '[inventaari-poisto]';
  const MARK = 'data-inventaari-poisto';
  const $ = (s, r) => (r || document).querySelector(s);

  // PR 937: InventoryView.scss rivit 123-128
  const st = document.createElement('style');
  st.textContent = '.nitro-inventory-delete { width: 340px; max-width: calc(100vw - 16px); height: auto; }';
  document.head.appendChild(st);

  // Luo elementin luokilla, tekstillä ja lapsilla.
  const el = (tag, cls, text, kids) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    (kids || []).forEach((k) => e.appendChild(k));
    return e;
  };
  // PR 937 InventoryFurnitureDeleteView.tsx:128-133 -> Button (Button.tsx:37,66,68)
  const btn = (variant, text, full, onClick) => {
    const b = el('button', 'btn d-flex' + (full ? ' w-100' : '') + ' align-items-center justify-content-center btn-' + variant + ' btn-sm', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  // Valittu esine varastosta: { name, max, iconBg } tai null.
  const luePoimittu = (inv) => {
    const tabs = inv.querySelectorAll('.nitro-card-tabs .nav-item');
    if (!tabs.length || !tabs[0].classList.contains('active')) return null;
    const cell = $('.layout-grid-item.active', inv);
    if (!cell || cell.classList.contains('unique-item')) return null;
    const prev = $('.room-preview-container', inv);
    const right = prev && prev.parentElement && prev.parentElement.parentElement;
    if (!right) return null;
    const sel = right.children[1];                      // InventoryFurnitureView.tsx:133, olemassa vain kun esine on valittu
    if (!sel) return null;
    const buttons = sel.lastElementChild;                // :135
    const nameEl = $('.text-truncate', sel);             // :134
    if (!buttons || !nameEl) return null;
    const cnt = $('.nitro-item-count', cell);
    const n = cnt ? parseInt(cnt.textContent, 10) : 1;
    return { buttons, name: nameEl.textContent, max: Math.max(1, isNaN(n) ? 1 : n), iconBg: getComputedStyle(cell).backgroundImage };
  };

  let dlg = null;
  const suljeDialogi = () => { if (dlg) { dlg.remove(); dlg = null; } };

  const avaaDialogi = (it) => {
    suljeDialogi();
    const max = it.max;
    let amountInput = '1';
    const clamp = (v) => Math.max(1, Math.min(v, max));                 // PR rivi 53
    const parsed = () => parseInt(amountInput, 10);
    const valid = () => { const p = parsed(); return !isNaN(p) && p >= 1 && p <= max; };   // PR rivi 52

    const card = el('div', 'nitro-card rounded animate__animated animate__fadeIn theme-primary-slim nitro-inventory-delete d-flex flex-column overflow-hidden position-relative');
    const wrap = el('div', 'draggable-window position-absolute', null, [card]);
    wrap.style.cssText = 'visibility:visible;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999;';

    // otsikko, PR rivi 110; sulku NitroCardHeaderView.tsx:45
    const head = el('div', 'drag-handler container-fluid nitro-card-header d-flex flex-column align-items-center justify-content-center position-relative');
    const headRow = el('div', 'd-flex w-100', null, [el('span', 'nitro-card-header-text', 'Poista esine')]);
    const close = el('button', 'd-flex align-items-center justify-content-center position-absolute end-2 nitro-card-header-close', '\u00D7');
    close.type = 'button'; close.setAttribute('aria-label', 'Sulje ikkuna');
    close.addEventListener('click', suljeDialogi);
    headRow.appendChild(close); head.appendChild(headRow);

    const body = el('div', 'container-fluid content-area d-flex flex-column overflow-hidden');
    card.appendChild(head); card.appendChild(body);

    const naytaVaihe1 = () => {
      body.textContent = '';
      // PR rivit 112-166: Grid > Column(4) kuva + Column(8)
      const grid = el('div', 'grid gap-2 h-100');
      const img = el('div', 'furni-image');
      img.style.cssText = 'width:100%;height:60px;background:' + it.iconBg + ' center / contain no-repeat;';
      const left = el('div', 'd-flex flex-column align-items-center justify-content-center g-col-4 bg-muted rounded p-2 overflow-hidden', null, [img]);
      const name = el('div', 'text-white fw-bold text-truncate nitro-default-size-text', it.name);               // PR rivi 122
      const avail = el('div', 'text-white nitro-small-size-text', 'Saatavilla: ' + max);                       // PR rivi 123-125
      const info = el('div', 'd-flex flex-column gap-1', null, [name, avail]);

      const input = el('input', 'form-control form-control-sm text-center');                                    // PR rivit 135-143
      input.type = 'number'; input.min = '1'; input.max = String(max); input.value = amountInput;
      const dec = btn('secondary', '\u25C0', false, () => set(clamp((isNaN(parsed()) ? 1 : parsed()) - 1)));    // PR rivit 128-134
      const inc = btn('secondary', '\u25B6', false, () => set(clamp((isNaN(parsed()) ? 0 : parsed()) + 1)));    // PR rivit 144-150
      const mx = btn('secondary', 'Max', false, () => set(max));                                                 // PR rivit 151-156
      const ok = btn('danger', 'Poista', true, () => { if (valid()) naytaVahvistus(clamp(parsed())); });         // PR rivit 158-164
      const paivita = () => {
        const p = parsed();
        dec.disabled = isNaN(p) || p <= 1; dec.classList.toggle('disabled', dec.disabled);                      // PR rivi 131
        inc.disabled = !isNaN(p) && p >= max; inc.classList.toggle('disabled', inc.disabled);                   // PR rivi 147
        ok.disabled = !valid(); ok.classList.toggle('disabled', ok.disabled);                                    // PR rivi 161
      };
      const set = (v) => { amountInput = String(v); input.value = amountInput; paivita(); };
      input.addEventListener('input', () => {                                                                    // PR rivit 60-73
        if (input.value === '') { amountInput = ''; paivita(); return; }
        const v = parseInt(input.value, 10);
        if (isNaN(v)) return;
        amountInput = String(Math.min(v, max)); input.value = amountInput; paivita();
      });
      input.addEventListener('blur', () => set(isNaN(parsed()) ? 1 : clamp(parsed())));                          // PR rivit 75-79
      const row = el('div', 'd-flex align-items-center gap-1', null, [dec, input, inc, mx]);
      const right = el('div', 'd-flex flex-column justify-content-between gap-2 overflow-hidden g-col-8', null, [info, row, ok]);
      grid.appendChild(left); grid.appendChild(right); body.appendChild(grid);
      paivita();
    };

    const naytaVahvistus = (n) => {
      body.textContent = '';
      // PR rivit 87-92: vahvistusteksti
      const teksti = 'Haluatko varmasti poistaa ' + n + ' kpl esinettä ' + it.name + '? Poisto on pysyvä.';
      const msg = el('div', 'text-white nitro-default-size-text', teksti);
      const cancel = btn('danger', 'Peruuta', true, naytaVaihe1);
      const confirm = btn('primary', 'Poista', true, () => {
        // EI LÄHETYSTÄ: vain konsoli ja teksti dialogissa.
        const tulos = 'UI-testi: poistettaisiin ' + n + ' kpl ' + it.name + ' (ei lähetetty)';
        console.log(LOG + ' ' + tulos);
        body.textContent = '';
        body.appendChild(el('div', 'text-white nitro-default-size-text', tulos));
      });
      body.appendChild(el('div', 'd-flex flex-column gap-2', null, [msg, el('div', 'd-flex gap-1', null, [cancel, confirm])]));
    };

    naytaVaihe1();
    dlg = wrap;
    (document.getElementById('draggable-windows-container') || document.body).appendChild(wrap);
  };

  // Lisää nappi valitun esineen nappisarakkeeseen; ei tuplaa; poistuu kun valintaa ei ole.
  const synkkaa = () => {
    const inv = $('.nitro-inventory');
    const vanha = inv && inv.querySelector('[' + MARK + ']');
    if (!inv) { suljeDialogi(); return; }
    const it = luePoimittu(inv);
    if (!it) { if (vanha) vanha.remove(); return; }
    if (vanha && vanha.parentElement === it.buttons && it.buttons.lastElementChild === vanha) return;
    if (vanha) vanha.remove();
    // PR InventoryFurnitureView.tsx diff rivit 161-171: <Button fullWidth variant="danger">Poista</Button>
    const b = btn('danger', 'Poista', true, () => {
      const nyt = luePoimittu($('.nitro-inventory') || document.body);
      if (nyt) avaaDialogi(nyt);
    });
    b.setAttribute(MARK, '1');
    it.buttons.appendChild(b);
  };

  const mo = new MutationObserver(() => { mo.disconnect(); try { synkkaa(); } finally { mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); } });
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  synkkaa();
  window.__kuplaInventaariPoisto = { pois: () => { mo.disconnect(); suljeDialogi(); document.querySelectorAll('[' + MARK + ']').forEach((e) => e.remove()); } };
})();
