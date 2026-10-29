/*
 * LED Pattern Studio – Editor-Oberfläche
 */
(function () {
  'use strict';

  const R = window.LEDRenderer;
  const PR = window.LEDPresets;
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'ledwall-studio-project-v1';

  // ------------------------------------------------------------------ state

  const state = {
    project: null,
    cur: 0,          // Index des aktuellen Patterns
    sel: -1,         // Index der ausgewählten Ebene (in pattern.layers)
    playing: true,
    bpm: 120,
    beat: 0,         // fortlaufende Beat-Position
    metronome: false,
    ledLook: true,
    grid: false,
    draw: { tool: 'pen', color: '#ffffff', size: 1, filled: false, mirror: false },
    collapsed: new Set(['Bewegung']),
    fileHandle: null,
    view: 'patterns',
  };

  const pattern = () => state.project.patterns[state.cur] || null;
  const layer = () => { const p = pattern(); return p && p.layers[state.sel] ? p.layers[state.sel] : null; };
  const W = () => state.project.width;
  const H = () => state.project.height;
  const mod = (a, n) => ((a % n) + n) % n;

  // ------------------------------------------------------------------ helpers

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k === 'style') e.style.cssText = v;
        else if (v === true) e.setAttribute(k, '');
        else if (v !== false && v != null) e.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
    return e;
  }

  let toastTimer;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
  }

  function fmtSpeed(v) {
    if (v === 0) return '0';
    const sign = v < 0 ? '−' : '';
    const a = Math.abs(v);
    if (a >= 1) return sign + (Number.isInteger(a) ? a : a.toFixed(2));
    const inv = 1 / a;
    if (Math.abs(inv - Math.round(inv)) < 1e-6) return sign + '1/' + Math.round(inv);
    return sign + a.toFixed(3);
  }

  function paletteCss(pal) {
    if (pal.length === 1) return pal[0];
    return 'linear-gradient(90deg,' + pal.concat(pal[0]).join(',') + ')';
  }

  // ------------------------------------------------------------------ native bridge (Mac-App)

  // In der Mac-App läuft die Oberfläche in einem WKWebView; Dateien, Autosave und Updates
  // übernimmt dann die native Seite (mac-app/Sources/AppController.swift).
  const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.native);
  const nativePending = new Map();
  let nativeReq = 0;

  function nativePost(cmd, payload) {
    window.webkit.messageHandlers.native.postMessage(Object.assign({ cmd }, payload || {}));
  }

  function nativeCall(cmd, payload) {
    return new Promise((resolve) => {
      const id = ++nativeReq;
      nativePending.set(id, resolve);
      nativePost(cmd, Object.assign({ id }, payload || {}));
    });
  }

  window.__native = {
    reply(id, res) {
      const r = nativePending.get(id);
      if (r) { nativePending.delete(id); r(res || {}); }
    },
    updateState(s) { onUpdateState(s); },
    // Geräte (devices.js)
    devices(list, fw) { if (window.LEDDevices) window.LEDDevices.onDevices(list, fw); },
    deviceLine(port, line) { if (window.LEDDevices) window.LEDDevices.onLine(port, line); },
    flashResult(r) { if (window.LEDDevices) window.LEDDevices.onFlash(r); },
  };

  // ------------------------------------------------------------------ persistence & undo

  let saveTimer, undoTimer, loopTimer, lastSnap = null;
  let undoStack = [], redoStack = [];

  function snapshot() { return JSON.stringify({ project: state.project, cur: state.cur, sel: state.sel }); }

  function commitUndo() {
    clearTimeout(undoTimer);
    const s = snapshot();
    if (s === lastSnap) return;
    if (lastSnap) { undoStack.push(lastSnap); if (undoStack.length > 200) undoStack.shift(); }
    redoStack = [];
    lastSnap = s;
  }

  function restoreSnap(s) {
    const o = JSON.parse(s);
    state.project = o.project;
    state.project.setup = window.LEDSetup.normalizeSetup(state.project.setup);
    state.cur = Math.min(o.cur, state.project.patterns.length - 1);
    state.sel = o.sel;
    renderAll();
    scheduleSave();
  }

  function undo() {
    commitUndo();
    if (!undoStack.length) return toast('Nichts rückgängig zu machen');
    redoStack.push(lastSnap);
    lastSnap = undoStack.pop();
    restoreSnap(lastSnap);
  }

  function redo() {
    commitUndo();
    if (!redoStack.length) return;
    undoStack.push(lastSnap);
    lastSnap = redoStack.pop();
    restoreSnap(lastSnap);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const json = JSON.stringify(state.project);
      if (NATIVE) nativePost('autosave', { data: json });
      try { localStorage.setItem(STORAGE_KEY, json); } catch (e) { /* Speicher voll o.ä. */ }
    }, 500);
  }

  // Bei jeder inhaltlichen Änderung aufrufen
  function changed(opts) {
    opts = opts || {};
    scheduleSave();
    clearTimeout(undoTimer);
    undoTimer = setTimeout(commitUndo, 400);
    scheduleLoopCheck();
    if (opts.library) renderLibrary();
    if (opts.layers) renderLayers();
    if (opts.inspector) renderInspector();
  }

  function scheduleLoopCheck() {
    clearTimeout(loopTimer);
    loopTimer = setTimeout(updateLoopStatus, 250);
  }

  function updateLoopStatus() {
    const p = pattern(), s = $('loopStatus');
    if (!p) { s.textContent = ''; s.className = 'loop-status'; return; }
    const r = R.checkLoop(p, W(), H());
    if (r.seamless) {
      s.textContent = '✓ Loop nahtlos';
      s.className = 'loop-status ok';
      s.title = 'Ende und Anfang des Loops passen zusammen.';
    } else {
      s.textContent = '⚠ Sprung am Loop-Ende';
      s.className = 'loop-status warn';
      s.title = 'Am Loop-Ende springt das Bild.\nTipp: Geschwindigkeit × Loop-Länge sollte eine ganze Zahl sein – '
        + 'bei Farbwechseln/Streifen sogar ein Vielfaches der Farbanzahl. Oder die Loop-Länge erhöhen.';
    }
  }

  // ------------------------------------------------------------------ library

  function renderLibrary() {
    const ul = $('patternList');
    ul.innerHTML = '';
    state.project.patterns.forEach((p, i) => {
      const cv = el('canvas', { width: W(), height: H() });
      const li = el('li', { class: i === state.cur ? 'sel' : '', onclick: () => selectPattern(i), ondblclick: () => $('patternName').select() },
        cv,
        el('div', { class: 'meta' },
          el('div', { class: 'name' }, p.name),
          el('div', { class: 'sub' }, p.loopBeats + ' Beats · ' + p.layers.length + ' Ebene' + (p.layers.length === 1 ? '' : 'n'))));
      ul.append(li);
    });
    renderThumbs();
  }

  function selectPattern(i) {
    state.cur = i;
    const p = pattern();
    state.sel = p ? p.layers.length - 1 : -1;
    renderAll();
  }

  function addPattern(p) {
    state.project.patterns.splice(state.cur + 1, 0, p);
    state.cur = Math.min(state.cur + 1, state.project.patterns.length - 1);
    state.sel = p.layers.length - 1;
    renderAll();
    changed();
  }

  // ------------------------------------------------------------------ stage head

  function renderStageHead() {
    const p = pattern();
    $('patternName').value = p ? p.name : '';
    $('patternName').disabled = !p;
    $('loopBeats').value = p ? String(p.loopBeats) : '4';
    if (p && !$('loopBeats').value) {
      $('loopBeats').append(el('option', { value: p.loopBeats }, p.loopBeats + ' Beats'));
      $('loopBeats').value = String(p.loopBeats);
    }
    updateLoopStatus();
  }

  // ------------------------------------------------------------------ layers

  function renderLayers() {
    const ul = $('layerList');
    ul.innerHTML = '';
    const p = pattern();
    if (!p) return;
    for (let i = p.layers.length - 1; i >= 0; i--) {
      const l = p.layers[i];
      const eye = el('input', { type: 'checkbox', title: 'Sichtbar' });
      eye.checked = l.enabled;
      eye.addEventListener('click', (e) => e.stopPropagation());
      eye.addEventListener('change', () => { l.enabled = eye.checked; changed({ layers: true }); });
      ul.append(el('li', { class: (i === state.sel ? 'sel ' : '') + (l.enabled ? '' : 'off'), onclick: () => selectLayer(i) },
        eye,
        el('span', { class: 'swatch', style: 'background:' + paletteCss(l.palette) }),
        el('span', { class: 'lname' }, l.name),
        el('span', { class: 'ltype' }, R.LAYER_TYPES[l.type])));
    }
    if (!p.layers.length) ul.append(el('li', { class: 'muted' }, 'Noch keine Ebene – oben „+ Ebene…“ wählen.'));
  }

  function selectLayer(i) {
    state.sel = i;
    renderLayers();
    renderInspector();
    updateDrawBar();
  }

  function moveLayer(dir) {
    const p = pattern(), i = state.sel, j = i + dir;
    if (!p || i < 0 || j < 0 || j >= p.layers.length) return;
    [p.layers[i], p.layers[j]] = [p.layers[j], p.layers[i]];
    state.sel = j;
    changed({ layers: true });
  }

  // ------------------------------------------------------------------ inspector

  const SPEEDS = [-4, -2, -1, -0.5, -0.25, -0.125, -0.0625, 0, 0.0625, 0.125, 0.25, 0.5, 1, 2, 4];
  const RATES = [0.0625, 0.125, 0.25, 0.5, 1, 2, 3, 4, 8, 16];
  const GRAD_SHAPES = { linear: 'Linear', radial: 'Kreise', square: 'Quadrate', diamond: 'Rauten', angular: 'Strahlen', spiral: 'Spirale' };
  const ARMS = (l) => l.params.shape === 'angular' || l.params.shape === 'spiral';

  const PARAM_SCHEMA = {
    solid: [
      { key: 'mode', label: 'Modus', type: 'select', options: { static: 'Feste Farbe', cycle: 'Farbe pro Schritt wechseln', fade: 'Weich durch Palette' }, rebuild: true },
      { key: 'rate', label: 'Wechsel / Beat', type: 'rate', show: (l) => l.params.mode !== 'static' },
    ],
    gradient: [
      { key: 'shape', label: 'Form', type: 'select', options: GRAD_SHAPES, rebuild: true },
      { key: 'size', label: 'Größe (px)', type: 'range', min: 2, max: 256, step: 1 },
      { key: 'speed', label: 'Lauf / Beat', type: 'speed' },
      { key: 'arms', label: 'Arme', type: 'range', min: 1, max: 12, step: 1, show: ARMS },
    ],
    stripes: [
      { key: 'shape', label: 'Form', type: 'select', options: GRAD_SHAPES, rebuild: true },
      { key: 'size', label: 'Abstand (px)', type: 'range', min: 2, max: 128, step: 1 },
      { key: 'duty', label: 'Breite', type: 'range', min: 0.05, max: 0.95, step: 0.01 },
      { key: 'softness', label: 'Weichheit', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'speed', label: 'Lauf / Beat', type: 'speed' },
      { key: 'arms', label: 'Arme', type: 'range', min: 1, max: 12, step: 1, show: ARMS },
    ],
    plasma: [
      { key: 'scale', label: 'Größe', type: 'range', min: 1, max: 40, step: 0.5 },
      { key: 'speed', label: 'Bewegung / Beat', type: 'speed' },
      { key: 'colorSpeed', label: 'Farblauf / Beat', type: 'speed' },
    ],
    noise: [
      { key: 'scale', label: 'Größe', type: 'range', min: 1, max: 40, step: 0.5 },
      { key: 'speed', label: 'Morph / Beat', type: 'speed' },
      { key: 'octaves', label: 'Detail', type: 'range', min: 1, max: 3, step: 1 },
      { key: 'contrast', label: 'Kontrast', type: 'range', min: 0.5, max: 3, step: 0.05 },
    ],
    checker: [
      { key: 'size', label: 'Feldgröße (px)', type: 'range', min: 1, max: 48, step: 1 },
      { key: 'flipRate', label: 'Wechsel / Beat', type: 'speed' },
    ],
    sparkle: [
      { key: 'density', label: 'Dichte', type: 'range', min: 0.002, max: 0.3, step: 0.002 },
      { key: 'rate', label: 'Schübe / Beat', type: 'rate' },
      { key: 'life', label: 'Leuchtdauer (Beats)', type: 'range', min: 0.05, max: 4, step: 0.05 },
      { key: 'cell', label: 'Funkengröße (px)', type: 'range', min: 1, max: 8, step: 1 },
    ],
    rain: [
      { key: 'speed', label: 'Fallgeschw.', type: 'range', min: 0.125, max: 4, step: 0.125 },
      { key: 'trail', label: 'Schweif (px)', type: 'range', min: 1, max: 48, step: 1 },
      { key: 'density', label: 'Dichte', type: 'range', min: 0, max: 1, step: 0.01 },
      { key: 'cell', label: 'Spaltenbreite (px)', type: 'range', min: 1, max: 8, step: 1 },
    ],
    wave: [
      { key: 'amplitude', label: 'Amplitude (px)', type: 'range', min: 0, max: 24, step: 0.5 },
      { key: 'wavelength', label: 'Wellenlänge (px)', type: 'range', min: 4, max: 128, step: 1 },
      { key: 'speed', label: 'Lauf / Beat', type: 'speed' },
      { key: 'thickness', label: 'Dicke (px)', type: 'range', min: 1, max: 12, step: 0.5 },
      { key: 'fill', label: 'Darunter füllen', type: 'check' },
      { key: 'count', label: 'Anzahl', type: 'range', min: 1, max: 6, step: 1 },
      { key: 'spacing', label: 'Abstand (px)', type: 'range', min: 0, max: 24, step: 1 },
    ],
    shape: [
      { key: 'shape', label: 'Form', type: 'select', options: { circle: 'Kreis', square: 'Quadrat', diamond: 'Raute', triangle: 'Dreieck', cross: 'Kreuz', heart: 'Herz' } },
      { key: 'size', label: 'Größe (px)', type: 'range', min: 1, max: 48, step: 0.5 },
      { key: 'thickness', label: 'Linie (0 = voll)', type: 'range', min: 0, max: 12, step: 0.5 },
      { key: 'pulse', label: 'Beat-Wachsen', type: 'range', min: 0, max: 2, step: 0.05 },
      { key: 'moveX', label: 'Pendel X (px)', type: 'range', min: -32, max: 32, step: 1 },
      { key: 'moveY', label: 'Pendel Y (px)', type: 'range', min: -24, max: 24, step: 1 },
      { key: 'moveRate', label: 'Pendel / Beat', type: 'speed' },
      { key: 'tile', label: 'Kacheln (px, 0=aus)', type: 'range', min: 0, max: 64, step: 1 },
      { key: 'colorSpeed', label: 'Farblauf / Beat', type: 'speed' },
    ],
    scanner: [
      { key: 'width', label: 'Breite (px)', type: 'range', min: 1, max: 32, step: 0.5 },
      { key: 'speed', label: 'Durchläufe / Beat', type: 'speed' },
      { key: 'mode', label: 'Modus', type: 'select', options: { bounce: 'Hin und her', wrap: 'Durchlaufen' } },
      { key: 'trail', label: 'Schweif (px)', type: 'range', min: 0, max: 64, step: 1 },
    ],
    draw: [
      { key: 'wrap', label: 'Kacheln (Wrap)', type: 'check' },
    ],
  };

  const TRANSFORM_SCHEMA = [
    { key: 'scrollX', label: 'Scroll X (px/Beat)', type: 'range', min: -64, max: 64, step: 0.5 },
    { key: 'scrollY', label: 'Scroll Y (px/Beat)', type: 'range', min: -48, max: 48, step: 0.5 },
    { key: 'rotate', label: 'Drehen (U/Beat)', type: 'speed' },
    { key: 'angle', label: 'Winkel (°)', type: 'range', min: 0, max: 360, step: 1 },
    { key: 'zoom', label: 'Zoom', type: 'range', min: 0.25, max: 4, step: 0.05 },
    { key: 'kaleido', label: 'Kaleidoskop', type: 'range', min: 0, max: 12, step: 1 },
    { key: 'mirrorX', label: 'Spiegeln ↔', type: 'check' },
    { key: 'mirrorY', label: 'Spiegeln ↕', type: 'check' },
    { key: 'cx', label: 'Mitte X', type: 'range', min: -0.5, max: 1.5, step: 0.01 },
    { key: 'cy', label: 'Mitte Y', type: 'range', min: -0.5, max: 1.5, step: 0.01 },
  ];

  const ENV_SCHEMA = [
    { key: 'mode', label: 'Art', type: 'select', rebuild: true,
      options: { none: 'Aus (immer an)', pulse: 'Puls (wie Kick)', strobe: 'Strobo', sine: 'Atmen (Sinus)', sawUp: 'Rampe auf', sawDown: 'Rampe ab', random: 'Zufall an/aus' } },
    { key: 'rate', label: 'Schläge / Beat', type: 'rate', show: (l) => l.envelope.mode !== 'none' },
    { key: 'decay', label: 'Abklingen', type: 'range', min: 0, max: 1, step: 0.01, show: (l) => l.envelope.mode === 'pulse' },
    { key: 'duty', label: 'An-Anteil', type: 'range', min: 0.05, max: 0.95, step: 0.01, show: (l) => l.envelope.mode === 'strobe' || l.envelope.mode === 'random' },
    { key: 'phase', label: 'Versatz', type: 'range', min: 0, max: 1, step: 0.05, show: (l) => l.envelope.mode !== 'none' },
    { key: 'min', label: 'Minimum', type: 'range', min: 0, max: 1, step: 0.01, show: (l) => l.envelope.mode !== 'none' },
  ];

  const ENV_DEFAULT = { mode: 'none', rate: 1, duty: 0.5, decay: 0.5, phase: 0, min: 0 };
  const TF_DEFAULT = { cx: 0.5, cy: 0.5, angle: 0, rotate: 0, zoom: 1, scrollX: 0, scrollY: 0, mirrorX: false, mirrorY: false, kaleido: 0 };

  function control(obj, f, l, defaults, after) {
    const fire = (rebuild) => {
      if (after) after();
      changed({ layers: f.layersRefresh, inspector: rebuild });
    };
    let input, val = null;
    switch (f.type) {
      case 'range': {
        input = el('input', { type: 'range', min: f.min, max: f.max, step: f.step });
        input.value = obj[f.key];
        val = el('span', { class: 'val' }, String(+(+obj[f.key]).toFixed(3)));
        input.addEventListener('input', () => { obj[f.key] = +input.value; val.textContent = String(+(+input.value).toFixed(3)); fire(false); });
        break;
      }
      case 'speed':
      case 'rate': {
        const list = (f.type === 'rate' ? RATES : SPEEDS).slice();
        if (!list.includes(obj[f.key])) { list.push(obj[f.key]); list.sort((a, b) => a - b); }
        input = el('select', null, list.map((v) => el('option', { value: v }, fmtSpeed(v))));
        input.value = String(obj[f.key]);
        input.addEventListener('change', () => { obj[f.key] = +input.value; fire(false); });
        break;
      }
      case 'select': {
        input = el('select', null, Object.keys(f.options).map((k) => el('option', { value: k }, f.options[k])));
        input.value = obj[f.key];
        input.addEventListener('change', () => { obj[f.key] = input.value; fire(!!f.rebuild); });
        break;
      }
      case 'check': {
        input = el('input', { type: 'checkbox' });
        input.checked = !!obj[f.key];
        input.addEventListener('change', () => { obj[f.key] = input.checked; fire(false); });
        input.style.justifySelf = 'start';
        break;
      }
    }
    const lbl = el('span', { class: 'lbl', title: defaults ? 'Doppelklick: Standardwert' : '' }, f.label);
    if (defaults && f.key in defaults) {
      lbl.addEventListener('dblclick', () => { obj[f.key] = R.clone(defaults[f.key]); fire(true); renderInspector(); });
    }
    return el('div', { class: 'row' }, lbl, input, val || el('span'));
  }

  function section(title, ...content) {
    const s = el('div', { class: 'section' + (state.collapsed.has(title) ? ' collapsed' : '') });
    const h = el('h3', { onclick: () => { s.classList.toggle('collapsed'); state.collapsed[s.classList.contains('collapsed') ? 'add' : 'delete'](title); } }, title);
    s.append(h, ...content.flat().filter(Boolean));
    return s;
  }

  function paletteEditor(l) {
    const bar = el('div', { class: 'palette-bar', style: 'background:' + paletteCss(l.palette) });
    const refreshBar = () => { bar.style.background = paletteCss(l.palette); };
    const wrap = el('div', { class: 'palette' });
    l.palette.forEach((c, i) => {
      const inp = el('input', { type: 'color' });
      inp.value = c;
      inp.addEventListener('input', () => { l.palette[i] = inp.value; refreshBar(); changed(); });
      inp.addEventListener('change', () => renderLayers());
      const x = el('button', { class: 'x', title: 'Entfernen', onclick: () => {
        if (l.palette.length <= 1) return;
        l.palette.splice(i, 1);
        changed({ layers: true, inspector: true });
      } }, '×');
      wrap.append(el('div', { class: 'sw' }, inp, x));
    });
    wrap.append(el('button', { title: 'Farbe hinzufügen', onclick: () => {
      l.palette.push(l.palette[l.palette.length - 1]);
      changed({ layers: true, inspector: true });
    } }, '+'));
    const preset = el('select', null, el('option', { value: '' }, 'Palette laden…'),
      Object.keys(PR.PALETTES).map((k) => el('option', { value: k }, k)));
    preset.addEventListener('change', () => {
      if (!preset.value) return;
      l.palette = PR.PALETTES[preset.value].slice();
      changed({ layers: true, inspector: true });
    });
    return [wrap, bar, el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Vorlage'), preset, el('span'))];
  }

  function envGraph(l, p) {
    const cv = el('canvas', { width: 600, height: 70, style: 'width:100%;height:35px;background:#0c0d10;border-radius:4px;margin-top:4px' });
    const ctx = cv.getContext('2d');
    const beats = 4;
    ctx.strokeStyle = '#2e323c';
    for (let b = 0; b <= beats; b++) { const x = (b / beats) * 600; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 70); ctx.stroke(); }
    ctx.strokeStyle = '#36d1ff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let x = 0; x <= 600; x++) {
      const v = R.envelopeValue(l.envelope, (x / 600) * beats, p.loopBeats);
      const y = 66 - v * 62;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return cv;
  }

  function renderInspector() {
    const box = $('inspector');
    const scroll = box.scrollTop;
    box.innerHTML = '';
    const l = layer(), p = pattern();
    if (!l) { box.append(el('div', { class: 'empty' }, 'Ebene auswählen oder hinzufügen.')); return; }

    const name = el('input', { type: 'text', value: l.name });
    name.addEventListener('input', () => { l.name = name.value; changed(); });
    name.addEventListener('change', () => renderLayers());

    const typeDefaults = R.DEFAULT_PARAMS[l.type];
    const params = PARAM_SCHEMA[l.type].filter((f) => !f.show || f.show(l)).map((f) => control(l.params, f, l, typeDefaults));

    let envCanvas = envGraph(l, p);
    const envRows = ENV_SCHEMA.filter((f) => !f.show || f.show(l)).map((f) => control(l.envelope, f, l, ENV_DEFAULT, () => {
      const n = envGraph(l, p); envCanvas.replaceWith(n); envCanvas = n;
    }));

    box.append(...[
      section('Ebene',
        el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Name'), name, el('span')),
        el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Typ'), el('span', null, R.LAYER_TYPES[l.type]), el('span'))),
      section('Effekt', params, l.type === 'draw' ? el('div', { class: 'muted', style: 'font-size:12px' }, 'Mit den Werkzeugen über der Vorschau direkt auf die Wand malen. Mit „Bewegung“ lässt sich die Zeichnung scrollen oder drehen.') : null),
      l.type === 'draw' ? null : section('Farben',
        paletteEditor(l),
        control(l, { key: 'paletteBlend', label: 'Übergang', type: 'select', options: { smooth: 'Weich', steps: 'Harte Stufen' } }, l),
        control(l, { key: 'hueShift', label: 'Farbrotation (U/Beat)', type: 'speed' }, l),
        control(l, { key: 'hueOffset', label: 'Farbton (°)', type: 'range', min: 0, max: 360, step: 1 }, l)),
      l.type === 'draw' ? section('Farben',
        control(l, { key: 'hueShift', label: 'Farbrotation (U/Beat)', type: 'speed' }, l),
        control(l, { key: 'hueOffset', label: 'Farbton (°)', type: 'range', min: 0, max: 360, step: 1 }, l)) : null,
      section('Bewegung', TRANSFORM_SCHEMA.map((f) => control(l.transform, f, l, TF_DEFAULT)),
        el('button', { onclick: () => { l.transform = R.clone(TF_DEFAULT); changed({ inspector: true }); } }, 'Bewegung zurücksetzen')),
      section('Beat-Hüllkurve', envRows, envCanvas),
      section('Mischen',
        control(l, { key: 'blend', label: 'Mischmodus', type: 'select', options: R.BLEND_MODES }, l),
        control(l, { key: 'opacity', label: 'Deckkraft', type: 'range', min: 0, max: 1, step: 0.01 }, l),
        control(l, { key: 'lumaKey', label: 'Schwarz = transparent', type: 'check' }, l)),
    ].filter(Boolean));
    box.scrollTop = scroll;
  }

  // ------------------------------------------------------------------ preview

  const preview = $('preview');
  const pctx = preview.getContext('2d');
  const off = document.createElement('canvas');
  const octx = off.getContext('2d');
  let mask = null, scale = 8, dpr = 1, img = null, fbuf = null, hover = null;

  function resizePreview() {
    const wrap = $('canvasWrap');
    const w = W(), h = H();
    scale = Math.max(2, Math.floor(Math.min(wrap.clientWidth / w, wrap.clientHeight / h)));
    dpr = window.devicePixelRatio || 1;
    preview.style.width = w * scale + 'px';
    preview.style.height = h * scale + 'px';
    preview.width = Math.round(w * scale * dpr);
    preview.height = Math.round(h * scale * dpr);
    off.width = w; off.height = h;
    img = octx.createImageData(w, h);
    fbuf = new Float32Array(w * h * 3);
    // LED-Maske: schwarz mit runden "Löchern"
    mask = document.createElement('canvas');
    mask.width = preview.width; mask.height = preview.height;
    const m = mask.getContext('2d');
    m.fillStyle = '#000';
    m.fillRect(0, 0, mask.width, mask.height);
    m.globalCompositeOperation = 'destination-out';
    const s = scale * dpr, r = s * 0.42;
    m.beginPath();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { m.moveTo((x + 0.5) * s + r, (y + 0.5) * s); m.arc((x + 0.5) * s, (y + 0.5) * s, r, 0, Math.PI * 2); }
    m.fill();
  }

  function drawPreview(lb) {
    const p = pattern();
    const w = W(), h = H();
    if (p) R.renderPattern(p, lb, w, h, fbuf); else fbuf.fill(0);
    R.toRGBA(fbuf, img.data);
    octx.putImageData(img, 0, 0);
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(off, 0, 0, preview.width, preview.height);
    const s = scale * dpr;
    if (state.ledLook) pctx.drawImage(mask, 0, 0);
    if (state.grid) {
      pctx.strokeStyle = 'rgba(255,255,255,.18)';
      pctx.lineWidth = 1;
      pctx.beginPath();
      for (let x = 8; x < w; x += 8) { pctx.moveTo(x * s + 0.5, 0); pctx.lineTo(x * s + 0.5, preview.height); }
      for (let y = 8; y < h; y += 8) { pctx.moveTo(0, y * s + 0.5); pctx.lineTo(preview.width, y * s + 0.5); }
      pctx.stroke();
      pctx.strokeStyle = 'rgba(255,61,127,.5)';
      pctx.beginPath();
      pctx.moveTo((w / 2) * s + 0.5, 0); pctx.lineTo((w / 2) * s + 0.5, preview.height);
      pctx.moveTo(0, (h / 2) * s + 0.5); pctx.lineTo(preview.width, (h / 2) * s + 0.5);
      pctx.stroke();
    }
    if (hover && isDrawLayer()) {
      const sz = state.draw.size, o = Math.floor((sz - 1) / 2);
      pctx.strokeStyle = '#fff';
      pctx.lineWidth = Math.max(1, dpr);
      pctx.strokeRect((hover[0] - o) * s + 0.5, (hover[1] - o) * s + 0.5, sz * s - 1, sz * s - 1);
    }
  }

  // Mini-Vorschauen in der Pattern-Liste
  let thumbBuf = null, thumbImg = null;
  function renderThumbs() {
    const canvases = $('patternList').querySelectorAll('canvas');
    const w = W(), h = H();
    if (!thumbBuf || thumbBuf.length !== w * h * 3) {
      thumbBuf = new Float32Array(w * h * 3);
      thumbImg = new ImageData(w, h);
    }
    state.project.patterns.forEach((p, i) => {
      const cv = canvases[i];
      if (!cv) return;
      R.renderPattern(p, mod(state.beat, p.loopBeats), w, h, thumbBuf);
      R.toRGBA(thumbBuf, thumbImg.data);
      cv.getContext('2d').putImageData(thumbImg, 0, 0);
    });
  }

  // ------------------------------------------------------------------ timeline

  const tl = $('timeline');
  const tctx = tl.getContext('2d');

  function drawTimeline(lb) {
    const p = pattern();
    const L = p ? p.loopBeats : 4;
    const d = window.devicePixelRatio || 1;
    const cw = tl.clientWidth, ch = tl.clientHeight;
    if (tl.width !== Math.round(cw * d)) { tl.width = Math.round(cw * d); tl.height = Math.round(ch * d); }
    tctx.setTransform(d, 0, 0, d, 0, 0);
    tctx.fillStyle = '#1a1c22';
    tctx.fillRect(0, 0, cw, ch);
    const sub = L <= 4 ? 4 : L <= 8 ? 2 : 1;
    for (let i = 0; i <= L * sub; i++) {
      const b = i / sub, x = Math.round((b / L) * (cw - 1)) + 0.5;
      const isBar = b % 4 === 0, isBeat = Number.isInteger(b);
      tctx.strokeStyle = isBar ? '#5a6070' : isBeat ? '#3a3f4c' : '#262a33';
      tctx.beginPath();
      tctx.moveTo(x, isBeat ? 0 : ch * 0.6);
      tctx.lineTo(x, ch);
      tctx.stroke();
      if (isBar && b < L) { tctx.fillStyle = '#8b90a0'; tctx.font = '10px -apple-system, sans-serif'; tctx.fillText('Takt ' + (b / 4 + 1), x + 4, 11); }
    }
    const px = (lb / L) * cw;
    tctx.fillStyle = 'rgba(54,209,255,.15)';
    tctx.fillRect(0, 0, px, ch);
    tctx.fillStyle = '#36d1ff';
    tctx.fillRect(px - 1, 0, 2, ch);
  }

  let scrubbing = false;
  function scrubTo(e) {
    const p = pattern();
    if (!p) return;
    const r = tl.getBoundingClientRect();
    const f = Math.min(0.9999, Math.max(0, (e.clientX - r.left) / r.width));
    let lb = f * p.loopBeats;
    if (e.shiftKey) lb = Math.round(lb * 4) / 4; // auf 1/4-Beats einrasten
    state.beat = Math.floor(state.beat / p.loopBeats) * p.loopBeats + lb;
  }
  tl.addEventListener('pointerdown', (e) => { scrubbing = true; tl.setPointerCapture(e.pointerId); scrubTo(e); });
  tl.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
  tl.addEventListener('pointerup', () => { scrubbing = false; });

  // ------------------------------------------------------------------ transport

  let audio = null;
  function click(accent) {
    if (!audio) return;
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = accent ? 1760 : 1100;
    g.gain.setValueAtTime(accent ? 0.35 : 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.06);
  }

  function setPlaying(v) {
    state.playing = v;
    $('btnPlay').textContent = v ? '❚❚' : '▶';
    $('btnPlay').classList.toggle('active', !v);
  }

  function setBpm(v) {
    v = Math.max(20, Math.min(300, Math.round(v * 10) / 10));
    if (!isFinite(v)) return;
    state.bpm = v;
    if (document.activeElement !== $('bpmInput')) $('bpmInput').value = v;
  }

  let taps = [];
  function tap() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 2) {
      const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      setBpm(60000 / avg);
      $('bpmInput').value = state.bpm;
      state.beat = Math.round(state.beat); // Schlag auf den Tap ausrichten
    }
    $('btnTap').classList.add('active');
    setTimeout(() => $('btnTap').classList.remove('active'), 90);
  }

  function toggleMetronome() {
    state.metronome = !state.metronome;
    if (state.metronome && !audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio && audio.state === 'suspended') audio.resume();
    $('btnMetro').classList.toggle('active', state.metronome);
  }

  // ------------------------------------------------------------------ main loop

  let lastTs = 0, lastBeatInt = -1, lastThumb = 0;
  const frameHooks = [];
  const dots = $('beatDots').children;

  function frame(ts) {
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    if (state.playing) state.beat += (dt * state.bpm) / 60;
    const p = pattern();
    const L = p ? p.loopBeats : 4;
    const lb = mod(state.beat, L);
    const bi = Math.floor(state.beat);
    if (bi !== lastBeatInt) {
      if (state.playing && state.metronome) click(mod(bi, 4) === 0);
      lastBeatInt = bi;
    }
    const f = state.beat - bi;
    for (let i = 0; i < 4; i++) {
      dots[i].classList.toggle('on', i === mod(bi, 4) && f < 0.5);
      dots[i].classList.toggle('down', i === 0);
    }
    $('position').textContent = 'Takt ' + (Math.floor(lb / 4) + 1) + ' · ' + (Math.floor(lb % 4) + 1);
    if (state.view === 'patterns') {
      if (img) drawPreview(lb);
      drawTimeline(lb);
      if (ts - lastThumb > 120) { renderThumbs(); lastThumb = ts; }
    }
    for (const hook of frameHooks) {
      try { hook(ts, lb); } catch (e) { console.error(e); }
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ drawing

  const isDrawLayer = () => { const l = layer(); return !!l && l.type === 'draw'; };

  function updateDrawBar() {
    const on = isDrawLayer();
    $('drawBar').hidden = !on;
    preview.classList.toggle('drawing', on);
    for (const b of $('drawTools').children) b.classList.toggle('active', b.dataset.tool === state.draw.tool);
  }

  function setTool(t) { state.draw.tool = t; updateDrawBar(); }

  function screenPixel(e) {
    const r = preview.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * W());
    const y = Math.floor(((e.clientY - r.top) / r.height) * H());
    if (x < 0 || y < 0 || x >= W() || y >= H()) return null;
    return [x, y];
  }

  let stroke = null; // { base: Uint8Array, bmp: Uint8Array, start: [x,y], last: [x,y] }

  function rgbaOf(hex) { const c = R.hexToRgb(hex); return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), 255]; }

  // Alle Zeichenfunktionen arbeiten in Bildschirm-Pixeln; jeder Punkt wird über die
  // aktuelle Bewegung der Ebene in die Bitmap abgebildet ("malen, wo man es sieht").
  function plot(ctx, x, y) {
    const w = W(), h = H(), sz = state.draw.size, o = Math.floor((sz - 1) / 2);
    const put = (px, py) => {
      for (let dy = 0; dy < sz; dy++) for (let dx = 0; dx < sz; dx++) {
        const qx = px - o + dx, qy = py - o + dy;
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const bp = R.layerPixel(ctx.layer, qx, qy, ctx.beat, w, h);
        if (!bp) continue;
        const i = (bp[1] * w + bp[0]) * 4, c = ctx.rgba;
        ctx.bmp[i] = c[0]; ctx.bmp[i + 1] = c[1]; ctx.bmp[i + 2] = c[2]; ctx.bmp[i + 3] = c[3];
      }
    };
    put(x, y);
    if (state.draw.mirror) put(w - 1 - x, y);
  }

  function line(ctx, x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      plot(ctx, x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function rect(ctx, a, b, filled) {
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (filled || x === x0 || x === x1 || y === y0 || y === y1) plot(ctx, x, y);
    }
  }

  function ellipse(ctx, a, b, filled) {
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
    const rx = Math.abs(b[0] - a[0]) / 2 + 0.5, ry = Math.abs(b[1] - a[1]) / 2 + 0.5;
    const inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      if (!inside(x, y)) continue;
      if (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) plot(ctx, x, y);
    }
  }

  // Füllen arbeitet direkt in der Bitmap (zusammenhängende gleichfarbige Fläche)
  function flood(bmp, x, y, rgba) {
    const w = W(), h = H();
    const i0 = (y * w + x) * 4;
    const target = [bmp[i0], bmp[i0 + 1], bmp[i0 + 2], bmp[i0 + 3]];
    if (target.every((v, k) => v === rgba[k])) return;
    const same = (i) => bmp[i] === target[0] && bmp[i + 1] === target[1] && bmp[i + 2] === target[2] && bmp[i + 3] === target[3];
    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      if (!same(i)) continue;
      bmp[i] = rgba[0]; bmp[i + 1] = rgba[1]; bmp[i + 2] = rgba[2]; bmp[i + 3] = rgba[3];
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }

  function applyStroke(l, sp) {
    const t = state.draw.tool;
    const ctx = {
      layer: l, bmp: stroke.bmp, beat: mod(state.beat, pattern().loopBeats),
      rgba: t === 'erase' ? [0, 0, 0, 0] : rgbaOf(state.draw.color),
    };
    if (t === 'pen' || t === 'erase') {
      const from = stroke.last || sp;
      line(ctx, from[0], from[1], sp[0], sp[1]);
      stroke.last = sp;
    } else if (t === 'line' || t === 'rect' || t === 'ellipse') {
      stroke.bmp.set(stroke.base);
      const a = stroke.start;
      if (t === 'line') line(ctx, a[0], a[1], sp[0], sp[1]);
      else if (t === 'rect') rect(ctx, a, sp, state.draw.filled);
      else ellipse(ctx, a, sp, state.draw.filled);
    }
    l.params.pixels = R.encodeBitmap(stroke.bmp);
  }

  preview.addEventListener('pointerdown', (e) => {
    const l = layer();
    if (!l || l.type !== 'draw') return;
    const sp = screenPixel(e);
    if (!sp) return;
    const t = state.draw.tool;
    if (t === 'pick') {
      const i = (sp[1] * W() + sp[0]) * 4;
      state.draw.color = R.rgbToHex(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255);
      $('drawColor').value = state.draw.color;
      setTool('pen');
      return;
    }
    const base = R.decodeBitmap(l.params.pixels, W(), H());
    stroke = { base: new Uint8Array(base), bmp: new Uint8Array(base), start: sp, last: null };
    if (t === 'fill') {
      const bp = R.layerPixel(l, sp[0], sp[1], mod(state.beat, pattern().loopBeats), W(), H());
      if (bp) flood(stroke.bmp, bp[0], bp[1], rgbaOf(state.draw.color));
      l.params.pixels = R.encodeBitmap(stroke.bmp);
      stroke = null;
      changed();
      return;
    }
    preview.setPointerCapture(e.pointerId);
    applyStroke(l, sp);
  });

  preview.addEventListener('pointermove', (e) => {
    hover = screenPixel(e);
    const l = layer();
    if (stroke && l && l.type === 'draw' && hover) applyStroke(l, hover);
  });
  preview.addEventListener('pointerleave', () => { hover = null; });
  preview.addEventListener('pointerup', () => { if (stroke) { stroke = null; changed(); } });

  function clearDraw() {
    const l = layer();
    if (!l || l.type !== 'draw') return;
    l.params.pixels = '';
    changed();
  }

  // ------------------------------------------------------------------ files

  async function download(name, data, type) {
    if (NATIVE) {
      const payload = data instanceof Blob
        ? { base64: R.bytesToBase64(new Uint8Array(await data.arrayBuffer())) }
        : { text: String(data) };
      const r = await nativeCall('saveFile', Object.assign({ name }, payload));
      if (r.error) toast('Fehler: ' + r.error, 4000);
      return !!r.ok;
    }
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return true;
  }

  const safeName = (s) => (s || 'projekt').replace(/[^\wäöüÄÖÜß\- ]+/g, '').trim().replace(/\s+/g, '-') || 'projekt';

  async function saveProject(saveAs) {
    commitUndo();
    const json = JSON.stringify(state.project, null, 1);
    const name = safeName(state.project.name) + '.ledproj.json';
    if (NATIVE) {
      const r = await nativeCall('saveProject', { name, data: json, saveAs: !!saveAs });
      if (r.ok) toast('Gespeichert: ' + r.name);
      else if (r.error) toast('Fehler: ' + r.error, 4000);
      return;
    }
    if (window.showSaveFilePicker) {
      try {
        if (!state.fileHandle || saveAs) {
          state.fileHandle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'LEDWall-Projekt', accept: { 'application/json': ['.json'] } }] });
        }
        const w = await state.fileHandle.createWritable();
        await w.write(json);
        await w.close();
        toast('Gespeichert: ' + state.fileHandle.name);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    download(name, json, 'application/json');
    toast('Projekt als Datei heruntergeladen');
  }

  function loadProjectObject(obj, handle) {
    state.project = R.normalizeProject(obj);
    state.project.setup = window.LEDSetup.normalizeSetup(state.project.setup);
    state.cur = 0;
    state.sel = pattern() ? pattern().layers.length - 1 : -1;
    state.fileHandle = handle || null;
    setBpm(state.project.refBpm);
    undoStack = []; redoStack = []; lastSnap = null;
    commitUndo();
    resizePreview();
    renderAll();
    scheduleSave();
  }

  async function openProject() {
    if (NATIVE) {
      const r = await nativeCall('openProject');
      if (!r.ok) { if (r.error) toast('Fehler: ' + r.error, 4000); return; }
      try { loadProjectObject(JSON.parse(r.text)); toast('Geöffnet: ' + r.name); }
      catch (e) { toast('Fehler: ' + e.message, 4000); }
      return;
    }
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'LEDWall-Projekt', accept: { 'application/json': ['.json'] } }] });
        const f = await h.getFile();
        loadProjectObject(JSON.parse(await f.text()), h);
        toast('Geöffnet: ' + f.name);
      } catch (e) {
        if (e && e.name !== 'AbortError') toast('Fehler: ' + e.message, 4000);
      }
      return;
    }
    $('fileInput').click();
  }

  $('fileInput').addEventListener('change', async () => {
    const f = $('fileInput').files[0];
    if (!f) return;
    try { loadProjectObject(JSON.parse(await f.text())); toast('Geöffnet: ' + f.name); }
    catch (e) { toast('Fehler: ' + e.message, 4000); }
    $('fileInput').value = '';
  });

  function newProject() {
    if (state.project.patterns.length && !confirm('Neues Projekt anlegen? Nicht gespeicherte Änderungen gehen verloren.')) return;
    const p = R.makeProject();
    p.patterns.push(R.makePattern('Neues Pattern', [R.makeLayer('solid', { palette: ['#000000'], name: 'Hintergrund' })], 4));
    loadProjectObject(p);
    if (NATIVE) nativePost('fileReset');
  }

  // ------------------------------------------------------------------ export

  function exportOpts() {
    return { refBpm: +$('expBpm').value || 120, fps: +$('expFps').value || 30, format: $('expFormat').value };
  }

  function updateExportSummary() {
    const o = exportOpts();
    const L = R.bankLayout(state.project, o);
    $('expFpb').textContent = L.fpb + ' (≈ ' + Math.round((L.fpb * o.refBpm) / 60) + ' fps bei ' + o.refBpm + ' BPM)';
    const kb = (b) => (b / 1024).toFixed(0) + ' KB';
    const rows = state.project.patterns.map((p, i) => el('tr', null,
      el('td', null, p.name), el('td', { class: 'r' }, p.loopBeats + ' Beats'),
      el('td', { class: 'r' }, L.entries[i].frames + ' Frames'), el('td', { class: 'r' }, kb(L.entries[i].bytes))));
    const mb = L.total / (1024 * 1024);
    const warn = [];
    if (mb > 1.5) warn.push('Größer als ~1,5 MB: passt nicht mehr komfortabel in den Flash eines RP2040 Zero (2 MB).');
    if (mb > 3) warn.push('Größer als ~3 MB: wird auch auf dem Pico 2W (4 MB Flash) eng. Weniger FPS, RGB565 oder kürzere Loops wählen.');
    $('expSummary').innerHTML = '';
    $('expSummary').append(
      el('table', null, rows,
        el('tr', { class: 'tot' }, el('td', null, 'Gesamt (' + state.project.patterns.length + ' Patterns)'), el('td'), el('td'), el('td', { class: 'r' }, mb.toFixed(2) + ' MB'))),
      ...warn.map((w) => el('div', { class: 'warn' }, '⚠ ' + w)));
  }

  function openExport() {
    $('expBpm').value = state.project.refBpm;
    updateExportSummary();
    $('expProgress').hidden = true;
    $('exportDialog').showModal();
  }

  ['expBpm', 'expFps', 'expFormat'].forEach((id) => $(id).addEventListener('input', updateExportSummary));

  $('btnExportBank').addEventListener('click', () => {
    const o = exportOpts();
    state.project.refBpm = o.refBpm;
    changed();
    $('expProgress').hidden = false;
    $('expProgress').value = 0;
    $('btnExportBank').disabled = true;
    toast('Rendere Frames…');
    setTimeout(async () => {
      try {
        const data = R.buildBank(state.project, o);
        const ok = await download(safeName(state.project.name) + '.lwb', new Blob([data], { type: 'application/octet-stream' }));
        if (ok) {
          toast('Bank exportiert (' + (data.length / 1024).toFixed(0) + ' KB)');
          $('exportDialog').close();
        }
      } catch (e) {
        toast('Export fehlgeschlagen: ' + e.message, 5000);
      }
      $('btnExportBank').disabled = false;
      $('expProgress').hidden = true;
    }, 40);
  });

  $('btnExportJson').addEventListener('click', () => {
    state.project.refBpm = exportOpts().refBpm;
    download(safeName(state.project.name) + '.ledproj.json', JSON.stringify(state.project, null, 1), 'application/json');
  });

  // ------------------------------------------------------------------ settings

  function openSettings() {
    $('setName').value = state.project.name;
    $('setBpm').value = state.project.refBpm;
    $('setW').value = W();
    $('setH').value = H();
    $('settingsDialog').showModal();
  }

  $('settingsDialog').addEventListener('close', () => {
    if ($('settingsDialog').returnValue !== 'ok') return;
    const pr = state.project;
    pr.name = $('setName').value || pr.name;
    pr.refBpm = +$('setBpm').value || pr.refBpm;
    const nw = Math.max(1, Math.min(256, $('setW').value | 0)), nh = Math.max(1, Math.min(256, $('setH').value | 0));
    if (nw !== pr.width || nh !== pr.height) {
      for (const p of pr.patterns) for (const l of p.layers) {
        if (l.type !== 'draw' || !l.params.pixels) continue;
        const old = R.decodeBitmap(l.params.pixels, pr.width, pr.height);
        const nb = new Uint8Array(nw * nh * 4);
        for (let y = 0; y < Math.min(nh, pr.height); y++) {
          nb.set(old.subarray(y * pr.width * 4, (y * pr.width + Math.min(nw, pr.width)) * 4), y * nw * 4);
        }
        l.params.pixels = R.encodeBitmap(nb);
      }
      pr.width = nw; pr.height = nh;
      resizePreview();
    }
    renderAll();
    changed();
  });

  // ------------------------------------------------------------------ updates (nur Mac-App)

  let upd = null, updNotified = '';

  const UPD_TEXT = {
    idle: '',
    checking: 'Suche nach Updates …',
    uptodate: 'Du hast die neueste Version.',
    none: 'Noch keine Veröffentlichung gefunden (oder das Repository ist privat).',
    verifying: 'Prüfe Download …',
    installing: 'Installiere – die App startet gleich neu …',
  };

  function onUpdateState(s) {
    upd = s;
    const btn = $('btnUpdate');
    btn.hidden = false;
    const avail = s.state === 'available';
    btn.textContent = avail ? '⬆ Update ' + s.latest : '↻';
    btn.title = avail ? 'Update verfügbar' : 'Nach Updates suchen';
    btn.classList.toggle('accent', avail);
    if (avail && !s.manual && updNotified !== s.latest) {
      updNotified = s.latest;
      toast('Update ' + s.latest + ' verfügbar – oben rechts klicken', 4000);
    }
    renderUpdateDialog();
  }

  function renderUpdateDialog() {
    if (!upd) return;
    const s = upd;
    $('updCurrent').textContent = s.current;
    let text = UPD_TEXT[s.state] || '';
    if (s.state === 'available') text = 'Version ' + s.latest + ' ist verfügbar.';
    if (s.state === 'downloading') text = 'Lade herunter … ' + s.progress + ' %';
    if (s.state === 'error') text = '⚠ ' + s.error;
    $('updStatus').textContent = text;
    $('updLast').textContent = s.lastCheck ? 'Zuletzt geprüft: ' + s.lastCheck : '';
    $('updNotes').hidden = !(s.state === 'available' && s.notes);
    $('updNotes').textContent = s.notes || '';
    $('updProgress').hidden = s.state !== 'downloading';
    $('updProgress').value = s.progress / 100;
    const busy = ['checking', 'downloading', 'verifying', 'installing'].includes(s.state);
    $('btnUpdCheck').disabled = busy;
    $('btnUpdInstall').hidden = !(s.state === 'available' || (s.state === 'error' && s.latest && s.latest !== s.current && s.url));
    $('btnUpdInstall').disabled = busy;
    $('updAuto').checked = s.autoCheck;
  }

  function openUpdates(check) {
    if (!NATIVE) return;
    renderUpdateDialog();
    if (!$('updateDialog').open) $('updateDialog').showModal();
    if (check || !upd || ['idle', 'error', 'none', 'uptodate'].includes(upd.state)) nativePost('update', { action: 'check' });
  }

  function menuUndo() {
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) &&
        !['checkbox', 'range', 'color'].includes(document.activeElement.type)) { document.execCommand('undo'); return; }
    undo();
  }

  function menuRedo() {
    if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) &&
        !['checkbox', 'range', 'color'].includes(document.activeElement.type)) { document.execCommand('redo'); return; }
    redo();
  }

  // Von der Mac-App (Menü) aufgerufen
  window.__app = {
    newProject: () => newProject(),
    openProject: () => openProject(),
    save: () => saveProject(false),
    saveAs: () => saveProject(true),
    exportBank: () => openExport(),
    settings: () => openSettings(),
    updates: () => openUpdates(true),
    undo: menuUndo,
    redo: menuRedo,
    snapshot: () => { commitUndo(); return JSON.stringify(state.project); },
  };

  // ------------------------------------------------------------------ Ansichten (Patterns / Geräte / Raum)

  const viewHooks = [];

  function setView(v) {
    state.view = v;
    for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.view === v);
    $('patternsView').hidden = v !== 'patterns';
    $('devicesView').hidden = v !== 'devices';
    $('roomView').hidden = v !== 'room';
    for (const h of viewHooks) h(v);
    if (v === 'patterns') resizePreview();
  }

  // Schnittstelle für devices.js und room.js
  window.LEDApp = {
    NATIVE,
    el, toast, nativePost, fmtSpeed,
    project: () => state.project,
    pattern,
    patternIndex: () => state.cur,
    beat: () => state.beat,
    view: () => state.view,
    changed: (opts) => changed(opts),
    onFrame: (fn) => frameHooks.push(fn),
    onView: (fn) => viewHooks.push(fn),
    selectPattern: (i) => selectPattern(i),
  };

  // ------------------------------------------------------------------ render all

  function renderAll() {
    if (window.LEDRoom) window.LEDRoom.refresh();
    renderLibrary();
    renderStageHead();
    renderLayers();
    renderInspector();
    updateDrawBar();
  }

  // ------------------------------------------------------------------ wiring

  // Beispiel-Zeichnung für das Demo-Pattern
  function smileyBitmap(w, h) {
    const bmp = new Uint8Array(w * h * 4);
    const cx = w / 2 - 0.5, cy = h / 2 - 0.5, r = Math.min(w, h) * 0.35;
    const set = (x, y, c) => { const i = (y * w + x) * 4; bmp[i] = c[0]; bmp[i + 1] = c[1]; bmp[i + 2] = c[2]; bmp[i + 3] = 255; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) set(x, y, [255, 210, 0]);
      const eye = Math.hypot(Math.abs(x - cx) - r * 0.38, y - (cy - r * 0.3));
      if (eye < r * 0.13) set(x, y, [20, 10, 0]);
      const m = Math.hypot(x - cx, y - (cy + r * 0.05));
      if (y > cy + r * 0.15 && m > r * 0.5 && m < r * 0.66) set(x, y, [20, 10, 0]);
    }
    return R.encodeBitmap(bmp);
  }

  function init() {
    // Auswahllisten befüllen
    PR.PRESETS.forEach((p, i) => $('presetSelect').append(el('option', { value: i }, p.name)));
    Object.keys(R.LAYER_TYPES).forEach((t) => $('addLayerSelect').append(el('option', { value: t }, R.LAYER_TYPES[t])));

    let saved = null;
    try { saved = JSON.parse(window.__NATIVE_AUTOSAVE__ || localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { saved = null; }
    if (saved) {
      try { state.project = R.normalizeProject(saved); } catch (e) { saved = null; }
    }
    if (!saved) {
      state.project = R.makeProject();
      state.project.patterns = PR.PRESETS.slice(0, 6).map(PR.instantiate);
      const drawDemo = R.makePattern('Eigene Zeichnung', [
        R.makeLayer('solid', { name: 'Hintergrund', palette: ['#050010'] }),
        R.makeLayer('draw', { name: 'Zeichnung', transform: { scrollX: 16 } }),
      ], 4);
      drawDemo.layers[1].params.pixels = smileyBitmap(state.project.width, state.project.height);
      state.project.patterns.push(drawDemo);
    }
    state.project.setup = window.LEDSetup.normalizeSetup(state.project.setup);
    state.sel = pattern() ? pattern().layers.length - 1 : -1;
    setBpm(state.project.refBpm);
    commitUndo();
    for (const b of $('tabs').children) b.onclick = () => setView(b.dataset.view);

    $('btnNew').onclick = newProject;
    $('btnOpen').onclick = openProject;
    $('btnSave').onclick = (e) => saveProject(e.altKey);
    $('btnExport').onclick = openExport;
    $('btnSettings').onclick = openSettings;
    $('btnUpdate').onclick = () => openUpdates(false);
    $('btnUpdCheck').onclick = () => nativePost('update', { action: 'check' });
    $('btnUpdInstall').onclick = () => nativePost('update', { action: 'install' });
    $('updAuto').addEventListener('change', () => nativePost('update', { action: 'autoCheck', value: $('updAuto').checked }));
    $('btnUpdRelease').onclick = () => { if (upd && upd.url) nativePost('openURL', { url: upd.url }); };
    if (NATIVE) {
      document.body.classList.add('native');
      $('appVersion').textContent = 'Version ' + ((window.__NATIVE_APP__ && window.__NATIVE_APP__.version) || '');
      nativePost('update', { action: 'state' });
    }

    $('btnPlay').onclick = () => setPlaying(!state.playing);
    $('bpmInput').addEventListener('input', () => { const v = +$('bpmInput').value; if (v >= 20 && v <= 300) state.bpm = v; });
    $('bpmInput').addEventListener('change', () => setBpm(+$('bpmInput').value || state.bpm));
    $('btnHalf').onclick = () => { setBpm(state.bpm / 2); $('bpmInput').value = state.bpm; };
    $('btnDouble').onclick = () => { setBpm(state.bpm * 2); $('bpmInput').value = state.bpm; };
    $('btnTap').onclick = tap;
    $('btnMetro').onclick = toggleMetronome;

    $('presetSelect').addEventListener('change', () => {
      const i = $('presetSelect').value;
      if (i === '') return;
      addPattern(PR.instantiate(PR.PRESETS[+i]));
      $('presetSelect').value = '';
    });
    $('btnAddPattern').onclick = () => addPattern(R.makePattern('Neues Pattern', [R.makeLayer('solid', { name: 'Hintergrund', palette: ['#000000'] })], 4));
    $('btnPatDup').onclick = () => {
      const p = pattern();
      if (!p) return;
      const c = R.clone(p);
      c.id = R.newId('pat');
      c.name = p.name + ' Kopie';
      c.layers.forEach((l) => { l.id = R.newId('layer'); });
      addPattern(c);
    };
    $('btnPatDel').onclick = () => {
      const p = pattern();
      if (!p || !confirm('Pattern „' + p.name + '“ löschen?')) return;
      state.project.patterns.splice(state.cur, 1);
      state.cur = Math.max(0, Math.min(state.cur, state.project.patterns.length - 1));
      state.sel = pattern() ? pattern().layers.length - 1 : -1;
      renderAll();
      changed();
    };
    const movePat = (d) => {
      const ps = state.project.patterns, i = state.cur, j = i + d;
      if (j < 0 || j >= ps.length) return;
      [ps[i], ps[j]] = [ps[j], ps[i]];
      state.cur = j;
      changed({ library: true });
    };
    $('btnPatUp').onclick = () => movePat(-1);
    $('btnPatDown').onclick = () => movePat(1);

    $('patternName').addEventListener('input', () => {
      const p = pattern();
      if (!p) return;
      p.name = $('patternName').value;
      const n = $('patternList').querySelectorAll('.name')[state.cur];
      if (n) n.textContent = p.name;
      changed();
    });
    $('loopBeats').addEventListener('change', () => {
      const p = pattern();
      if (!p) return;
      p.loopBeats = +$('loopBeats').value;
      changed({ library: true, inspector: true });
    });
    $('ledLook').addEventListener('change', () => { state.ledLook = $('ledLook').checked; });
    $('showGrid').addEventListener('change', () => { state.grid = $('showGrid').checked; });

    $('addLayerSelect').addEventListener('change', () => {
      const t = $('addLayerSelect').value;
      const p = pattern();
      $('addLayerSelect').value = '';
      if (!t || !p) return;
      const l = R.makeLayer(t);
      if (p.layers.length && t !== 'draw' && t !== 'solid') l.blend = t === 'sparkle' || t === 'rain' ? 'add' : 'normal';
      p.layers.splice(state.sel + 1, 0, l);
      state.sel = state.sel + 1;
      if (t === 'draw') setTool('pen');
      changed({ library: true, layers: true, inspector: true });
      updateDrawBar();
    });
    $('btnLayerUp').onclick = () => moveLayer(1);
    $('btnLayerDown').onclick = () => moveLayer(-1);
    $('btnLayerDup').onclick = () => {
      const p = pattern(), l = layer();
      if (!l) return;
      const c = R.clone(l);
      c.id = R.newId('layer');
      c.name = l.name + ' Kopie';
      p.layers.splice(state.sel + 1, 0, c);
      state.sel++;
      changed({ library: true, layers: true, inspector: true });
    };
    $('btnLayerDel').onclick = () => {
      const p = pattern();
      if (!layer()) return;
      p.layers.splice(state.sel, 1);
      state.sel = Math.min(state.sel, p.layers.length - 1);
      changed({ library: true, layers: true, inspector: true });
      updateDrawBar();
    };

    for (const b of $('drawTools').children) b.onclick = () => setTool(b.dataset.tool);
    $('drawColor').addEventListener('input', () => { state.draw.color = $('drawColor').value; });
    $('drawSize').addEventListener('change', () => { state.draw.size = +$('drawSize').value; });
    $('drawFilled').addEventListener('change', () => { state.draw.filled = $('drawFilled').checked; });
    $('drawMirror').addEventListener('change', () => { state.draw.mirror = $('drawMirror').checked; });
    $('btnClearDraw').onclick = clearDraw;

    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      // In der Mac-App laufen ⌘-Kürzel über das native Menü
      if (mod && NATIVE) return;
      if (mod && k === 's') { e.preventDefault(); saveProject(e.shiftKey); return; }
      if (mod && k === 'o') { e.preventDefault(); openProject(); return; }
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      const typing = tag === 'INPUT' && !['checkbox', 'range', 'color'].includes(document.activeElement.type) || tag === 'TEXTAREA';
      if (mod && k === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod || typing || document.querySelector('dialog[open]')) return;
      if (e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); if (document.activeElement) document.activeElement.blur(); }
      else if (k === 't') tap();
      else if (k === 'm') toggleMetronome();
      else if (state.view === 'patterns' && isDrawLayer()) {
        const tools = { p: 'pen', b: 'pen', e: 'erase', l: 'line', r: 'rect', o: 'ellipse', f: 'fill', i: 'pick' };
        if (tools[k]) setTool(tools[k]);
      }
    });

    new ResizeObserver(() => resizePreview()).observe($('canvasWrap'));
    window.addEventListener('beforeunload', () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.project)); } catch (e) { /* ignorieren */ }
    });

    resizePreview();
    renderAll();
    requestAnimationFrame(frame);
  }

  init();
})();
