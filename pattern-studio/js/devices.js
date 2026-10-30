/*
 * Geräte: RP2040-Zero-Empfänger erkennen, Firmware aufspielen, Adresse / Name / Panels einstellen,
 * Testbilder und Live-Vorschau über USB. Die USB-Seite übernimmt die Mac-App (DeviceManager.swift).
 */
(function () {
  'use strict';

  const A = window.LEDApp;
  const P = window.LEDProtocol;
  const S = window.LEDSetup;
  const R = window.LEDRenderer;
  const el = A.el;
  const $ = (id) => document.getElementById(id);

  const st = {
    devices: [],          // vom DeviceManager
    firmware: { receiver: { version: '', available: false }, sender: { version: '', available: false } },
    patterns: {},         // Sender-Port -> Patternliste
    upload: {},           // Sender-Port -> { sent, total, state, error }
    info: {},             // port -> INFO-Objekt der Firmware
    edit: {},             // port -> bearbeitete Einstellungen (noch nicht übertragen)
    dirty: {},            // port -> true, wenn edit vom Gerät abweicht
    waiting: {},          // port -> Warteschlange für OK/ERR
    sel: null,            // ausgewähltes Gerät (id)
    preview: new Set(),   // Ports mit Live-Vorschau
    pendingFlash: 0,      // bis wann ein neues BOOTSEL-Laufwerk automatisch beschrieben wird
    flashing: new Set(),
  };

  const PRESETS = [
    { name: '3 × 64×16 übereinander', pw: 64, ph: 16, panels: [[0, 0, 0], [0, 16, 0], [0, 32, 0]] },
    { name: '3 × 64×16, Schlange (Mitte gedreht)', pw: 64, ph: 16, panels: [[0, 0, 0], [0, 16, 3], [0, 32, 0]] },
    { name: '6 × 32×16 (2 × 3), Zeilen gleich', pw: 32, ph: 16, panels: [[0, 0, 0], [32, 0, 0], [0, 16, 0], [32, 16, 0], [0, 32, 0], [32, 32, 0]] },
    { name: '6 × 32×16 (2 × 3), Schlange', pw: 32, ph: 16, panels: [[0, 0, 0], [32, 0, 0], [32, 16, 3], [0, 16, 3], [0, 32, 0], [32, 32, 0]] },
    { name: '1 × 64×32 + Rest frei', pw: 64, ph: 32, panels: [[0, 0, 0]] },
  ];
  const ORDERS = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'];
  const TESTS = [[1, 'Farben'], [2, 'Verlauf'], [3, 'Panels'], [4, 'Raster'], [5, 'Weiß'], [0, 'Aus']];
  const BAUDS = [1000000, 2000000, 3000000, 4000000];
  const CLOCKS = [[2, 'schnell'], [3, 'normal'], [5, 'langsam'], [8, 'sehr langsam']];

  // ---------------------------------------------------------------- Hilfen

  function verCmp(a, b) {
    const pa = String(a || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  }

  function send(port, text) {
    A.nativePost('device', { action: 'send', port, text });
  }

  // Befehl senden und auf OK / ERR warten
  function command(port, text) {
    return new Promise((resolve) => {
      (st.waiting[port] = st.waiting[port] || []).push(resolve);
      send(port, text);
      setTimeout(() => {
        const q = st.waiting[port];
        const i = q ? q.indexOf(resolve) : -1;
        if (i >= 0) { q.splice(i, 1); resolve({ ok: false, error: 'keine Antwort' }); }
      }, 4000);
    });
  }

  const receivers = () => st.devices.filter((d) => d.kind === 'receiver');
  const fwR = () => st.firmware.receiver || {};
  const fwS = () => st.firmware.sender || {};
  const selected = () => st.devices.find((d) => d.id === st.sel) || null;

  function wallFor(info) {
    const setup = A.project().setup;
    if (!info) return null;
    return setup.walls.find((w) => w.uid && w.uid === info.uid) || null;
  }

  function editFromInfo(info) {
    return {
      addr: info.addr, name: info.name, w: info.w, h: info.h, pw: info.pw, ph: info.ph,
      panels: info.panels.map((p) => p.slice()), order: info.order, bright: info.bright,
      gamma: info.gamma, div: info.div, baud: info.baud,
    };
  }

  function setArgs(e) {
    return 'SET addr=' + e.addr + ' name=' + encodeURIComponent(e.name || 'Wand') +
      ' w=' + e.w + ' h=' + e.h + ' pw=' + e.pw + ' ph=' + e.ph +
      ' panels=' + e.panels.map((p) => p.join(',')).join(';') +
      ' order=' + e.order + ' bright=' + e.bright + ' gamma=' + e.gamma + ' div=' + e.div + ' baud=' + e.baud;
  }

  // ---------------------------------------------------------------- Ereignisse von der App

  function onDevices(list, fw) {
    const before = new Set(st.devices.map((d) => d.id));
    st.devices = list || [];
    st.firmware = fw || st.firmware;
    for (const port of Object.keys(st.info)) {
      if (!st.devices.some((d) => d.port === port)) { delete st.info[port]; st.preview.delete(port); }
    }
    // neues BOOTSEL-Laufwerk, nachdem wir ein Update angestoßen haben -> sofort beschreiben
    for (const d of st.devices) {
      if (d.kind === 'bootsel' && !before.has(d.id) && Date.now() < st.pendingFlash) {
        st.pendingFlash = 0;
        flash(d.volume);
      }
    }
    if (!st.sel || !st.devices.some((d) => d.id === st.sel)) {
      const r = receivers()[0] || st.devices[0];
      st.sel = r ? r.id : null;
    }
    const badge = $('deviceBadge');
    const n = st.devices.filter((d) => d.kind !== 'rp2040').length;
    badge.hidden = !n;
    badge.textContent = n;
    renderList();
    renderDetail();
  }

  function onLine(port, line) {
    if (line.startsWith('STATE ')) { // Sender: Zustand mit Patternliste
      try {
        const s2 = JSON.parse(line.slice(6));
        st.patterns[port] = s2.patterns || [];
        line = 'INFO ' + JSON.stringify(s2);
      } catch (e) { return; }
    }
    if (line.startsWith('INFO ') && line.includes('"ledwall-tx"')) {
      try {
        const info = JSON.parse(line.slice(5));
        const first = !st.info[port];
        st.info[port] = info;
        if (first) send(port, 'PATTERNS');
        renderList();
        if (selected() && selected().port === port) { if (first) renderDetail(); else updateSender(port); }
      } catch (e) { /* unvollständig */ }
      return;
    }
    if (line.startsWith('INFO ')) {
      try {
        const info = JSON.parse(line.slice(5));
        const first = !st.info[port];
        st.info[port] = info;
        if (first || !st.dirty[port]) { st.edit[port] = editFromInfo(info); st.dirty[port] = false; }
        renderList();
        if (selected() && selected().port === port && (first || !st.dirty[port])) renderDetail();
        else updateStatusLine();
      } catch (e) { /* unvollständige Zeile */ }
      return;
    }
    if (line === 'OK' || line.startsWith('ERR')) {
      const q = st.waiting[port];
      const resolve = q && q.shift();
      if (resolve) resolve(line === 'OK' ? { ok: true } : { ok: false, error: line.slice(4) });
    }
  }

  function onFlash(r) {
    st.flashing.delete(r.volume);
    if (r.ok) A.toast('Firmware aufgespielt – der Empfänger startet neu …', 3500);
    else A.toast('Aufspielen fehlgeschlagen: ' + (r.error || 'unbekannter Fehler'), 6000);
    renderList();
  }

  function onUpload(port, sent, total, state, error) {
    st.upload[port] = { sent, total, state, error };
    if (state === 'done') { A.toast('Bank auf den Sender geladen'); send(port, 'PATTERNS'); }
    if (state === 'error') A.toast('Upload fehlgeschlagen: ' + error, 6000);
    updateSender(port);
  }

  function flash(volume) {
    const d = st.devices.find((x) => x.volume === volume);
    const fw = d && d.board === 'RP2350' ? fwS() : fwR();
    if (!fw.available) { A.toast('In dieser App-Version ist diese Firmware nicht enthalten', 5000); return; }
    st.flashing.add(volume);
    A.nativePost('device', { action: 'flash', volume });
    renderList();
  }

  // ---------------------------------------------------------------- Liste

  function renderList() {
    const ul = $('deviceList');
    if (!ul) return;
    ul.innerHTML = '';
    $('fwInfo').textContent = A.NATIVE
      ? 'Mitgelieferte Firmware: Empfänger ' + (fwR().version || '–') + ' · Sender ' + (fwS().version || '–') : '';
    if (!A.NATIVE) {
      ul.append(el('li', { class: 'empty' }, 'Geräte lassen sich nur in der Mac-App erkennen und einrichten.'));
      return;
    }
    if (!st.devices.length) {
      ul.append(el('li', { class: 'empty' },
        el('div', { class: 'dname' }, 'Kein Gerät gefunden'),
        el('div', { class: 'dsub' }, 'RP2040 Zero per USB anschließen. Neuer Zero: BOOT-Taste gedrückt halten und einstecken.')));
      return;
    }
    for (const d of st.devices) {
      const li = el('li', { class: d.id === st.sel ? 'sel' : '', onclick: () => { st.sel = d.id; renderList(); renderDetail(); } });
      if (d.kind === 'receiver') {
        const info = st.info[d.port];
        const wall = wallFor(info);
        const pills = [];
        if (info && fwR().available && verCmp(fwR().version, info.ver) > 0) pills.push(el('span', { class: 'pill warn' }, 'Update'));
        if (info && !info.saved) pills.push(el('span', { class: 'pill warn' }, 'ungespeichert'));
        if (st.preview.has(d.port)) pills.push(el('span', { class: 'pill info' }, 'live'));
        li.append(
          el('div', { class: 'dname' }, info ? info.name + ' · Adresse ' + info.addr : 'Empfänger', ...pills),
          el('div', { class: 'dsub' }, info ? 'Firmware ' + info.ver + ' · ' + info.w + '×' + info.h + (wall ? ' · im Raum: ' + wall.name : '') : 'verbinde …'));
      } else if (d.kind === 'sender') {
        const info = st.info[d.port];
        const pills = [];
        if (info && fwS().available && verCmp(fwS().version, info.ver) > 0) pills.push(el('span', { class: 'pill warn' }, 'Update'));
        if (info && !info.bank.ok) pills.push(el('span', { class: 'pill warn' }, 'keine Bank'));
        li.append(
          el('div', { class: 'dname' }, 'Sender (Pico 2W)', ...pills),
          el('div', { class: 'dsub' }, info ? info.bpm.toFixed(1) + ' BPM · ' + (info.bank.ok ? info.patternName : 'keine Bank') + ' · WLAN ' + (info.wifi.ip || info.wifi.state) : 'verbinde …'));
      } else if (d.kind === 'bootsel') {
        const busy = st.flashing.has(d.volume);
        const sender = d.board === 'RP2350';
        const fw = sender ? fwS() : fwR();
        li.append(
          el('div', { class: 'dname' }, (sender ? 'Pico 2W' : 'RP2040 Zero') + ' im BOOTSEL-Modus'),
          el('div', { class: 'dsub' }, sender ? 'Bereit für die Sender-Firmware' : 'Bereit für die Empfänger-Firmware'),
          el('div', { class: 'dact' },
            el('button', { class: 'accent', disabled: busy || !fw.available, onclick: (e) => { e.stopPropagation(); flash(d.volume); } },
              busy ? 'Spiele auf …' : (sender ? 'Sender-Firmware installieren' : 'Empfänger-Firmware installieren'))));
      } else {
        li.append(
          el('div', { class: 'dname' }, d.product || 'RP2040-Board'),
          el('div', { class: 'dsub' }, 'Läuft mit anderer Software (' + d.port.replace('/dev/', '') + ')'),
          el('div', { class: 'dact' }, el('button', { onclick: (e) => {
            e.stopPropagation();
            if (!confirm('Auf „' + (d.product || 'dieses Board') + '“ die LEDWall-Firmware aufspielen (RP2040 → Empfänger, Pico 2W → Sender)? Die bisherige Software wird ersetzt.')) return;
            st.pendingFlash = Date.now() + 20000;
            A.nativePost('device', { action: 'touch1200', port: d.port });
            A.toast('Starte das Board im BOOTSEL-Modus …');
          } }, 'LEDWall-Firmware aufspielen')));
      }
      ul.append(li);
    }
  }

  // ---------------------------------------------------------------- Details

  function row(label, control, extra) {
    return el('div', { class: 'row' }, el('span', { class: 'lbl' }, label), control, extra || el('span'));
  }

  function numInput(obj, key, min, max, onChange) {
    const i = el('input', { type: 'number', min, max, step: 1 });
    i.value = obj[key];
    i.addEventListener('input', () => { obj[key] = Math.round(+i.value); onChange(); });
    return i;
  }

  function selectInput(obj, key, options, onChange) {
    const s = el('select', null, options.map(([v, label]) => el('option', { value: v }, label)));
    s.value = String(obj[key]);
    s.addEventListener('change', () => { obj[key] = +s.value; onChange(); });
    return s;
  }

  function drawDiagram(cv, e) {
    const sc = Math.max(2, Math.floor(Math.min(420 / e.w, 300 / e.h)));
    cv.width = e.w * sc; cv.height = e.h * sc;
    const c = cv.getContext('2d');
    c.fillStyle = '#111'; c.fillRect(0, 0, cv.width, cv.height);
    const colors = ['#ff3d3d', '#3ddc84', '#3d8bff', '#ffd000', '#ff3dff', '#36d1ff', '#ff8a00', '#a0ffa0'];
    e.panels.forEach((p, i) => {
      const [x, y, f] = p;
      c.fillStyle = colors[i % 8] + '33';
      c.strokeStyle = colors[i % 8];
      c.lineWidth = 2;
      c.fillRect(x * sc, y * sc, e.pw * sc, e.ph * sc);
      c.strokeRect(x * sc + 1, y * sc + 1, e.pw * sc - 2, e.ph * sc - 2);
      // Pfeil: Richtung, in der die Daten durchs Panel laufen (lokales x)
      const mx = f & 1, my = f & 2;
      const cy = (y + (my ? e.ph * 0.7 : e.ph * 0.3)) * sc;
      const x0 = (x + e.pw * 0.25) * sc, x1 = (x + e.pw * 0.75) * sc;
      const [from, to] = mx ? [x1, x0] : [x0, x1];
      c.strokeStyle = '#fff';
      c.beginPath(); c.moveTo(from, cy); c.lineTo(to, cy);
      const d = mx ? 1 : -1;
      c.moveTo(to, cy); c.lineTo(to + d * 8, cy - 6); c.moveTo(to, cy); c.lineTo(to + d * 8, cy + 6);
      c.stroke();
      c.fillStyle = '#fff';
      c.font = 'bold ' + Math.min(22, e.ph * sc * 0.4) + 'px -apple-system, sans-serif';
      c.fillText(String(i + 1), x * sc + 6, (y + (my ? e.ph * 0.35 : e.ph * 0.85)) * sc);
    });
  }

  let statusEl = null;
  function updateStatusLine() {
    const d = selected();
    if (!statusEl || !d || d.kind !== 'receiver') return;
    const info = st.info[d.port];
    if (!info) return;
    statusEl.textContent = st.dirty[d.port] ? 'Geändert – noch nicht übertragen'
      : info.saved ? 'Auf dem Gerät gespeichert' : 'Übertragen, aber noch nicht dauerhaft gespeichert';
  }

  function renderDetail() {
    const box = $('deviceDetail');
    if (!box) return;
    box.innerHTML = '';
    statusEl = null;
    const d = selected();
    if (!A.NATIVE) {
      box.append(el('div', { class: 'card' }, el('h3', null, 'Mac-App benötigt'),
        el('p', null, 'Zum Erkennen, Einrichten und Aufspielen der Empfänger bitte die Mac-App „LED Pattern Studio“ verwenden. Die Verkabelung siehst du unten.')),
        ...wiringCard(true));
      return;
    }
    if (!d) { box.append(...wiringCard(true)); return; }
    if (d.kind === 'sender') { renderSender(box, d); return; }
    if (d.kind !== 'receiver') {
      box.append(el('div', { class: 'card' },
        el('h3', null, d.kind === 'bootsel' ? 'Firmware installieren' : 'Anderes Board'),
        el('p', null, d.kind === 'bootsel'
          ? 'Klicke links auf „… Firmware installieren“. Das Board startet danach neu und erscheint als Empfänger (RP2040 Zero) bzw. als Sender (Pico 2W).'
          : 'Dieses Board läuft mit anderer Software. „Zum Empfänger machen“ spielt die LEDWall-Firmware auf.')),
        ...wiringCard(true));
      return;
    }
    const port = d.port;
    const info = st.info[port];
    if (!info) { box.append(el('div', { class: 'card' }, 'Verbinde mit dem Empfänger …')); return; }
    const e = st.edit[port];
    const markDirty = () => { st.dirty[port] = true; updateStatusLine(); diagram && drawDiagram(diagram, e); };
    let diagram = null;

    const outdated = fwR().available && verCmp(fwR().version, info.ver) > 0;
    statusEl = el('span', { class: 'muted' });

    const apply = async (save) => {
      let r = await command(port, setArgs(e));
      if (!r.ok) { A.toast('Fehler: ' + r.error, 5000); return; }
      if (save) {
        r = await command(port, 'SAVE');
        if (!r.ok) { A.toast('Speichern fehlgeschlagen: ' + r.error, 5000); return; }
      }
      st.dirty[port] = false;
      send(port, 'INFO');
      // Adresse/Name in die verknüpfte Wand im Raum übernehmen
      const wall = wallFor(info);
      if (wall) { wall.address = e.addr; wall.width = e.w; wall.height = e.h; A.changed(); }
      A.toast(save ? 'Auf dem Empfänger gespeichert' : 'Übertragen (noch nicht gespeichert)');
    };

    // Kopf
    const cardHead = (el('div', { class: 'card' },
      el('h1', null, info.name, el('span', { class: 'pill info' }, 'Adresse ' + info.addr)),
      el('div', { class: 'muted' }, 'RP2040 Zero · Seriennummer ' + info.uid + ' · Firmware ' + info.ver),
      el('div', { class: 'actions' },
        el('button', { onclick: () => command(port, 'IDENT 5') }, 'Identifizieren'),
        el('button', { onclick: () => { send(port, 'REBOOT'); } }, 'Neu starten'),
        outdated ? el('button', { class: 'accent', onclick: () => {
          st.pendingFlash = Date.now() + 20000;
          send(port, 'BOOTSEL');
          A.toast('Update auf Firmware ' + fwR().version + ' …');
        } }, 'Firmware auf ' + fwR().version + ' aktualisieren') : null)));

    // Adresse
    const cardAddr = el('div', { class: 'card' }, el('h3', null, 'Adresse & Name'),
      row('Adresse (1–254)', numInput(e, 'addr', 1, 254, markDirty), el('span', { class: 'muted' }, 'Darauf hört der Empfänger am Sender-Kabel')),
      row('Name', (() => { const i = el('input', { type: 'text', maxlength: 23 }); i.value = e.name; i.addEventListener('input', () => { e.name = i.value; markDirty(); }); return i; })()));

    // Panels
    const presetSel = el('select', null, el('option', { value: '' }, 'Vorlage wählen …'), PRESETS.map((p, i) => el('option', { value: i }, p.name)));
    presetSel.addEventListener('change', () => {
      const p = PRESETS[+presetSel.value];
      if (!p) return;
      e.pw = p.pw; e.ph = p.ph; e.panels = p.panels.map((x) => x.slice());
      st.dirty[port] = true;
      renderDetail();
    });
    const table = el('table', { class: 'panel-table' }, el('tr', null, ['#', 'X', 'Y', '↔ gespiegelt', '↕ gespiegelt', ''].map((h) => el('th', null, h))));
    e.panels.forEach((p, i) => {
      const cell = (k) => { const inp = el('input', { type: 'number', min: 0, max: 1024, step: 1 }); inp.value = p[k]; inp.addEventListener('input', () => { p[k] = Math.max(0, Math.round(+inp.value)); markDirty(); }); return inp; };
      const flag = (bit) => { const c = el('input', { type: 'checkbox' }); c.checked = !!(p[2] & bit); c.addEventListener('change', () => { p[2] = c.checked ? p[2] | bit : p[2] & ~bit; markDirty(); }); return c; };
      table.append(el('tr', null, el('td', null, String(i + 1)), el('td', null, cell(0)), el('td', null, cell(1)),
        el('td', null, flag(1)), el('td', null, flag(2)),
        el('td', null,
          el('button', { title: 'Früher in der Kette', disabled: i === 0, onclick: () => { [e.panels[i - 1], e.panels[i]] = [e.panels[i], e.panels[i - 1]]; st.dirty[port] = true; renderDetail(); } }, '↑'),
          el('button', { title: 'Entfernen', disabled: e.panels.length <= 1, onclick: () => { e.panels.splice(i, 1); st.dirty[port] = true; renderDetail(); } }, '×'))));
    });
    diagram = el('canvas', { class: 'panel-diagram' });
    drawDiagram(diagram, e);
    const cardPanels = el('div', { class: 'card' }, el('h3', null, 'Panels (HUB75)'),
      row('Vorlage', presetSel),
      row('Wandgröße', el('span', null, numInput(e, 'w', 8, 128, markDirty), ' × ', numInput(e, 'h', 8, 64, markDirty), ' Pixel')),
      row('Panelgröße', el('span', null, numInput(e, 'pw', 8, 128, markDirty), ' × ', numInput(e, 'ph', 8, 64, markDirty), ' Pixel')),
      el('div', { class: 'muted', style: 'font-size:12px;margin:6px 0' }, 'Reihenfolge = Kette: Panel 1 hängt direkt am Zero, Panel 2 an dessen Ausgang usw. Position in Pixeln, oben links ist 0,0. Prüfen mit dem Testbild „Panels“: Zahl und Pfeil müssen lesbar nach rechts zeigen.'),
      table,
      el('button', { onclick: () => { const last = e.panels[e.panels.length - 1] || [0, 0, 0]; e.panels.push([last[0], last[1] + e.ph, 0]); st.dirty[port] = true; renderDetail(); } }, '+ Panel'),
      el('div', null, diagram));

    // Darstellung
    const bright = el('input', { type: 'range', min: 0, max: 255, step: 1 });
    bright.value = e.bright;
    const brightVal = el('span', { class: 'val' }, Math.round(e.bright / 2.55) + ' %');
    bright.addEventListener('input', () => { e.bright = +bright.value; brightVal.textContent = Math.round(e.bright / 2.55) + ' %'; markDirty(); });
    const cardLook = el('div', { class: 'card' }, el('h3', null, 'Darstellung & Anschluss'),
      row('Helligkeit', bright, brightVal),
      row('Gamma', selectInput(e, 'gamma', [[18, '1,8'], [20, '2,0'], [22, '2,2 (Standard)'], [25, '2,5'], [28, '2,8']], markDirty)),
      row('Farbreihenfolge', selectInput(e, 'order', ORDERS.map((o, i) => [i, o]), markDirty), el('span', { class: 'muted' }, 'falls Rot und Blau vertauscht sind')),
      row('Panel-Takt', selectInput(e, 'div', CLOCKS, markDirty), el('span', { class: 'muted' }, 'langsamer bei Flackern / langen Kabeln')),
      row('UART-Baudrate', selectInput(e, 'baud', BAUDS.map((b) => [b, (b / 1e6) + ' MBaud']), markDirty), el('span', { class: 'muted' }, 'muss zum Sender passen')));

    const cardSave = el('div', { class: 'card' },
      el('div', { class: 'actions', style: 'margin-top:0;align-items:center' },
        el('button', { onclick: () => apply(false) }, 'Ausprobieren'),
        el('button', { class: 'accent', onclick: () => apply(true) }, 'Auf Gerät speichern'),
        el('button', { onclick: () => { st.edit[port] = editFromInfo(info); st.dirty[port] = false; renderDetail(); } }, 'Verwerfen'),
        statusEl));

    // Test & Vorschau
    const live = el('input', { type: 'checkbox' });
    live.checked = st.preview.has(port);
    live.addEventListener('change', () => {
      if (live.checked) { st.preview.add(port); command(port, 'TEST 0'); }
      else st.preview.delete(port);
      renderList();
    });
    const cardTest = el('div', { class: 'card' }, el('h3', null, 'Testen'),
      el('div', { class: 'actions', style: 'margin-top:0' }, TESTS.map(([m, label]) => el('button', { onclick: () => command(port, 'TEST ' + m) }, label))),
      el('label', { class: 'inline', style: 'margin-top:12px;display:flex' }, live,
        ' Live-Vorschau: das aktuelle Pattern über USB auf dieser Wand zeigen'));

    // Raum
    const setup = A.project().setup;
    const wall = wallFor(info);
    const wallSel = el('select', null, el('option', { value: '' }, '– keine –'),
      setup.walls.map((w) => el('option', { value: w.id }, w.name + ' (Adresse ' + w.address + ')')),
      el('option', { value: '__new' }, '+ neue Wand im Raum anlegen'));
    wallSel.value = wall ? wall.id : '';
    wallSel.addEventListener('change', () => {
      for (const w of setup.walls) if (w.uid === info.uid) w.uid = '';
      let target = setup.walls.find((w) => w.id === wallSel.value);
      if (wallSel.value === '__new') {
        target = S.makeWall(setup.walls.length + 1, { name: info.name, pos: { x: setup.walls.length * 0.4, y: 1.2, z: -setup.room.d / 2 + 0.1 } });
        setup.walls.push(target);
      }
      if (target) { target.uid = info.uid; target.address = info.addr; target.width = info.w; target.height = info.h; if (!target.name) target.name = info.name; }
      A.changed();
      if (window.LEDRoom) window.LEDRoom.refresh();
      renderList();
      renderDetail();
    });
    const cardRoom = el('div', { class: 'card' }, el('h3', null, 'Im Raum'),
      row('Verknüpfte Wand', wallSel, el('span', { class: 'muted' }, 'Position stellst du im Tab „Raum“ ein')));

    box.append(cardHead, cardAddr, cardPanels, cardLook, cardSave, cardTest, cardRoom, ...wiringCard(false));
    updateStatusLine();
  }

  function wiringCard(open) {
    const pins = [
      ['R1', 'GP2'], ['G1', 'GP3'], ['B1', 'GP4'], ['R2', 'GP5'], ['G2', 'GP6'], ['B2', 'GP7'],
      ['A', 'GP8'], ['B', 'GP9'], ['C', 'GP10'], ['D', 'GP11'], ['E', 'GP12'],
      ['CLK', 'GP13'], ['LAT / STB', 'GP14'], ['OE', 'GP15'], ['GND', 'GND'],
    ];
    const t1 = el('table', { class: 'wiring' }, pins.slice(0, 8).map(([a, b]) => el('tr', null, el('td', null, a), el('td', null, '→ ' + b))));
    const t2 = el('table', { class: 'wiring' }, pins.slice(8).map(([a, b]) => el('tr', null, el('td', null, a), el('td', null, '→ ' + b))));
    const t3 = el('table', { class: 'wiring' },
      el('tr', null, el('td', null, 'Pico 2W TX'), el('td', null, '→ GP1 (RX)')),
      el('tr', null, el('td', null, 'GND'), el('td', null, '→ GND')),
      el('tr', null, el('td', null, 'Status-LED'), el('td', null, 'blau = wartet, grün = Signal, lila = Identifizieren')));
    const det = el('details', { class: 'card' }, el('summary', null, el('h3', { style: 'display:inline' }, 'Verkabelung HUB75 → RP2040 Zero')),
      el('div', { class: 'wiring-grid', style: 'margin-top:10px' },
        el('div', null, el('div', { class: 'muted' }, 'HUB75-Eingang'), el('div', { class: 'wiring-grid', style: 'gap:24px' }, t1, t2)),
        el('div', null, el('div', { class: 'muted' }, 'Vom Sender'), t3)),
      el('p', { class: 'muted', style: 'font-size:12px' }, 'Panels mit eigenem 5-V-Netzteil versorgen, GND von Netzteil, Zero und Sender verbinden. Panels mit nur A–D (1/8 Scan, 16 Pixel hoch) lassen E einfach frei.'));
    if (open) det.open = true;
    return [det];
  }

  // ---------------------------------------------------------------- Live-Vorschau

  let lastPreview = 0;
  const cache = {};
  A.onFrame((ts, lb) => {
    if (!st.preview.size || ts - lastPreview < 40) return; // ~25 fps
    lastPreview = ts;
    const pat = A.pattern();
    if (!pat) return;
    const setup = A.project().setup;
    const frames = S.renderWalls(pat, lb, setup, cache);
    for (const port of st.preview) {
      const info = st.info[port];
      if (!info) continue;
      const wall = wallFor(info);
      let buf = wall && wall.width === info.w && wall.height === info.h ? frames[wall.id] : null;
      if (!buf) buf = R.renderPattern(pat, lb, info.w, info.h, cache['dev' + port]), cache['dev' + port] = buf;
      const pk = P.frame(0, buf, 'rgb565', P.FLAG_SHOW);
      A.nativePost('device', { action: 'frame', port, base64: R.bytesToBase64(pk) });
    }
  });

  A.onView((v) => { if (v === 'devices') { renderList(); renderDetail(); } });

  // ---------------------------------------------------------------- Sender (Pico 2W)

  const senderEls = {};

  function renderSender(box, d) {
    const port = d.port;
    const info = st.info[port];
    if (!info) { box.append(el('div', { class: 'card' }, 'Verbinde mit dem Sender …')); return; }
    const outdated = fwS().available && verCmp(fwS().version, info.ver) > 0;
    const E = senderEls;
    E.port = port;
    const btn = (label, cmd, cls) => el('button', { class: cls || '', onclick: () => { send(port, cmd); setTimeout(() => send(port, 'INFO'), 60); } }, label);

    // Kopf
    const head = el('div', { class: 'card' },
      el('h1', null, 'Sender', el('span', { class: 'pill info' }, 'Pico 2W')),
      el('div', { class: 'muted' }, 'Seriennummer ' + info.uid + ' · Firmware ' + info.ver),
      el('div', { class: 'actions' },
        btn('Wände zeigen (Adressen)', 'IDENT 5'),
        el('button', { onclick: () => send(port, 'REBOOT') }, 'Neu starten'),
        outdated ? el('button', { class: 'accent', onclick: () => {
          st.pendingFlash = Date.now() + 20000;
          send(port, 'BOOTSEL');
          A.toast('Update auf Sender-Firmware ' + fwS().version + ' …');
        } }, 'Firmware auf ' + fwS().version + ' aktualisieren') : null));

    // Live-Steuerung
    E.bpm = el('input', { type: 'number', min: 20, max: 300, step: 0.1, style: 'width:90px;font-size:18px;font-weight:700' });
    E.bpm.addEventListener('change', () => send(port, 'BPM ' + E.bpm.value));
    E.pattern = el('select');
    E.pattern.addEventListener('change', () => send(port, 'PATTERN ' + E.pattern.value + (E.now.checked ? ' now' : '')));
    E.now = el('input', { type: 'checkbox' });
    E.auto = el('select', null, [[0, 'aus'], [4, 'alle 4 Takte'], [8, 'alle 8 Takte'], [16, 'alle 16 Takte'], [32, 'alle 32 Takte'], [64, 'alle 64 Takte']]
      .map(([v, l]) => el('option', { value: v }, l)));
    E.auto.addEventListener('change', () => send(port, 'AUTO ' + E.auto.value));
    E.bright = el('input', { type: 'range', min: 0, max: 255, step: 1 });
    E.bright.addEventListener('change', () => send(port, 'BRIGHT ' + E.bright.value));
    E.play = el('button', { onclick: () => send(port, st.info[port].playing ? 'STOP' : 'PLAY') });
    E.black = el('button', { onclick: () => send(port, 'BLACKOUT ' + (st.info[port].blackout ? 0 : 1)) }, 'Blackout');
    E.status = el('span', { class: 'muted' });
    const live = el('div', { class: 'card' }, el('h3', null, 'Live-Steuerung'),
      row('Tempo', el('span', null, E.bpm, ' BPM'), E.status),
      el('div', { class: 'actions', style: 'margin-top:0' },
        btn('Tap', 'TAP', 'accent'), btn('Sync (1)', 'SYNC'), btn('−1', 'BPM ' + (info.bpm - 1)), btn('+1', 'BPM ' + (info.bpm + 1)),
        el('button', { onclick: () => send(port, 'BPM ' + st.info[port].bpm / 2) }, '½'),
        el('button', { onclick: () => send(port, 'BPM ' + st.info[port].bpm * 2) }, '×2'),
        E.play, E.black),
      row('Pattern', E.pattern, el('label', { class: 'inline' }, E.now, ' sofort')),
      el('div', { class: 'actions', style: 'margin-top:0' }, btn('◀ Vorheriges', 'PREV'), btn('Nächstes ▶', 'NEXT')),
      row('Automatisch', E.auto),
      row('Helligkeit (alle Wände)', E.bright),
      el('div', { class: 'actions' }, btn('Als Startwerte speichern', 'SAVE')));

    // Bank
    const geo = S.bankGeometry(A.project());
    const opts = st.bankOpts = st.bankOpts || { fps: 25, format: 'rgb565' };
    E.bankInfo = el('div', { class: 'muted', style: 'font-size:12px' });
    E.progress = el('progress', { max: 1, value: 0, hidden: true, style: 'width:100%' });
    E.estimate = el('div', { class: 'muted', style: 'font-size:12px' });
    const fps = el('select', null, [15, 20, 25, 30, 40].map((v) => el('option', { value: v }, v + ' fps (bei Ref-BPM)')));
    fps.value = String(opts.fps);
    const fmt = el('select', null, el('option', { value: 'rgb888' }, 'RGB888 (beste Farben)'), el('option', { value: 'rgb565' }, 'RGB565 (halbe Größe)'));
    fmt.value = opts.format;
    const estimate = () => {
      const L = R.bankLayout(A.project(), Object.assign({ refBpm: A.project().refBpm }, opts, geo));
      const mb = L.total / 1048576, max = (st.info[port].bank.max || 3 * 1048576) / 1048576;
      E.estimate.textContent = A.project().patterns.length + ' Patterns · Leinwand ' + geo.width + '×' + geo.height + ' · ' +
        (geo.walls.length ? geo.walls.length + (geo.walls.length === 1 ? ' Wand' : ' Wände') + ' (' + (geo.mode === 'span' ? 'verteilt' : 'gleiches Bild') + ')' : 'ohne Raum-Setup (an alle)') +
        ' · ' + mb.toFixed(2) + ' MB von ' + max.toFixed(2) + ' MB' + (mb > max ? ' – zu groß! FPS oder Format verringern.' : '');
      return mb <= max;
    };
    fps.addEventListener('change', () => { opts.fps = +fps.value; estimate(); });
    fmt.addEventListener('change', () => { opts.format = fmt.value; estimate(); });
    E.uploadBtn = el('button', { class: 'accent', onclick: () => {
      if (!estimate()) { A.toast('Die Bank ist zu groß für den Sender', 5000); return; }
      E.uploadBtn.disabled = true;
      A.toast('Rendere Frames …');
      setTimeout(() => {
        try {
          const data = R.buildBank(A.project(), Object.assign({ refBpm: A.project().refBpm }, opts, geo));
          st.upload[port] = { sent: 0, total: data.length, state: 'starting' };
          A.nativePost('device', { action: 'upload', port, base64: R.bytesToBase64(data), crc: P.crc32(data) });
          updateSender(port);
        } catch (err) {
          A.toast('Fehler: ' + err.message, 5000);
          E.uploadBtn.disabled = false;
        }
      }, 30);
    } }, 'Aktuelles Projekt auf den Sender laden');
    const bank = el('div', { class: 'card' }, el('h3', null, 'Pattern-Bank'),
      E.bankInfo,
      row('Bildrate', fps), row('Format', fmt), E.estimate,
      el('div', { class: 'actions' }, E.uploadBtn), E.progress,
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' },
        'Alle Patterns des Projekts werden auf die Referenz-BPM (' + A.project().refBpm + ') gerendert, zusammen mit dem Raum-Setup (Adressen, Ausgänge, Verteilung). Der Sender spielt sie danach ohne Mac ab.'));

    // WLAN
    const w = { mode: info.wifi.mode === 1 ? 'sta' : 'ap', apssid: info.wifi.apSsid, appass: '', ssid: info.wifi.staSsid, pass: '' };
    const txt = (key, type, ph) => { const i = el('input', { type: type || 'text', placeholder: ph || '' }); i.value = w[key] || ''; i.addEventListener('input', () => { w[key] = i.value; }); return i; };
    const mode = el('select', null, el('option', { value: 'ap' }, 'Eigenes Netz (Access Point)'), el('option', { value: 'sta' }, 'Vorhandenes WLAN'));
    mode.value = w.mode;
    mode.addEventListener('change', () => { w.mode = mode.value; });
    E.wifiInfo = el('div', { class: 'muted', style: 'font-size:12px' });
    const wifi = el('div', { class: 'card' }, el('h3', null, 'WLAN (Steuerung per Handy)'),
      E.wifiInfo,
      row('Modus', mode),
      row('Eigenes Netz: Name', txt('apssid')), row('Eigenes Netz: Passwort', txt('appass', 'password', 'unverändert lassen')),
      row('WLAN: Name', txt('ssid')), row('WLAN: Passwort', txt('pass', 'password', 'unverändert lassen')),
      el('div', { class: 'actions' }, el('button', { class: 'accent', onclick: async () => {
        let c = 'WIFI mode=' + w.mode + ' apssid=' + encodeURIComponent(w.apssid) + ' ssid=' + encodeURIComponent(w.ssid || '');
        if (w.appass) c += ' appass=' + encodeURIComponent(w.appass);
        if (w.pass) c += ' pass=' + encodeURIComponent(w.pass);
        const r = await command(port, c);
        if (!r.ok) { A.toast('Fehler: ' + r.error, 5000); return; }
        send(port, 'REBOOT');
        A.toast('Gespeichert – der Sender startet neu');
      } }, 'Speichern & neu starten')),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' },
        'Klappt die Verbindung zum vorhandenen WLAN nicht, öffnet der Sender nach 20 s automatisch sein eigenes Netz.'));

    // Ausgänge
    const baud = el('select', null, [1000000, 2000000, 3000000, 4000000].map((b) => el('option', { value: b }, b / 1e6 + ' MBaud')));
    baud.value = String(info.baud);
    baud.addEventListener('change', () => { send(port, 'BAUD ' + baud.value); send(port, 'SAVE'); });
    const outs = el('div', { class: 'card' }, el('h3', null, 'Anschlüsse'),
      row('UART-Baudrate', baud, el('span', { class: 'muted' }, 'muss bei allen Empfängern gleich sein')),
      el('table', { class: 'wiring', style: 'margin-top:8px' },
        [['GP0', 'Ausgang 1 → GP1 der Empfänger'], ['GP4', 'Ausgang 2 → GP1 der Empfänger'], ['GND', 'gemeinsame Masse mit allen Empfängern'],
          ['GP15', 'Taster gegen GND: tippen = Tempo, halten = Sync'], ['GP14', 'Taster gegen GND: nächstes Pattern']]
          .map(([a, b]) => el('tr', null, el('td', null, a), el('td', null, b)))),
      el('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' }, 'Welche Wand an welchem Ausgang hängt, stellst du im Tab „Raum“ ein.'));

    box.append(head, live, bank, wifi, outs);
    estimate();
    updateSender(port);
  }

  function updateSender(port) {
    const E = senderEls, info = st.info[port];
    if (E.port !== port || !info || !E.bpm || !document.body.contains(E.bpm)) return;
    if (document.activeElement !== E.bpm) E.bpm.value = info.bpm.toFixed(1);
    const pats = st.patterns[port] || [];
    if (E.pattern.options.length !== pats.length) {
      E.pattern.innerHTML = '';
      pats.forEach((p, i) => E.pattern.append(el('option', { value: i }, (i + 1) + '. ' + p.name)));
    }
    if (document.activeElement !== E.pattern) E.pattern.value = String(info.pattern);
    E.auto.value = String(info.auto);
    if (document.activeElement !== E.bright) E.bright.value = info.bright;
    E.play.textContent = info.playing ? '⏸ Pause' : '▶ Start';
    E.black.classList.toggle('active', info.blackout);
    E.status.textContent = 'Takt ' + (Math.floor(info.beat / 4) % 1000 + 1) + ' · ' + (info.fps || 0).toFixed(0) + ' fps' +
      (info.next >= 0 && pats[info.next] ? ' · gleich: ' + pats[info.next].name : '');
    E.bankInfo.textContent = info.bank.ok
      ? 'Auf dem Sender: ' + info.bank.patterns + ' Patterns · ' + info.bank.w + '×' + info.bank.h + ' · Ref-BPM ' + info.bank.refBpm +
        ' · ' + (info.bank.size / 1048576).toFixed(2) + ' MB' + (info.bank.walls ? ' · ' + info.bank.walls + (info.bank.walls === 1 ? ' Wand' : ' Wände') : '')
      : 'Auf dem Sender ist noch keine Bank (' + info.bank.error + ').';
    E.wifiInfo.innerHTML = '';
    E.wifiInfo.append(info.wifi.state === 'verbinde' ? 'Verbinde mit „' + info.wifi.ssid.replace(/"/g, '') + '“ …' :
      el('span', null, (info.wifi.state === 'ap' ? 'Eigenes Netz „' + info.wifi.apSsid + '“' : 'Verbunden mit „' + info.wifi.staSsid + '“') +
        ' · Handy-Steuerung: ', el('a', { href: 'http://' + info.wifi.ip, style: 'color:var(--accent2)' }, 'http://' + info.wifi.ip),
        ' oder http://ledwall.local'));
    const up = st.upload[port];
    const busy = up && (up.state === 'starting' || up.state === 'sending');
    E.progress.hidden = !busy;
    if (up && up.total) E.progress.value = up.sent / up.total;
    E.uploadBtn.disabled = !!busy;
    E.uploadBtn.textContent = busy ? 'Lade hoch … ' + Math.round((up.sent / up.total) * 100) + ' %' : 'Aktuelles Projekt auf den Sender laden';
  }

  // Zustand des Senders regelmäßig abfragen, solange er angezeigt wird
  setInterval(() => {
    const d = selected();
    if (!d || d.kind !== 'sender' || A.view() !== 'devices') return;
    const up = st.upload[d.port];
    if (up && (up.state === 'starting' || up.state === 'sending')) return;
    send(d.port, 'INFO');
  }, 1000);

  window.LEDDevices = { onDevices, onLine, onFlash, onUpload, state: st };

  document.getElementById('btnDevRescan').onclick = () => A.nativePost && A.NATIVE && A.nativePost('device', { action: 'state' });
  renderList();
  renderDetail();
})();
