/*
 * Tab „Licht“: alles, was per WLAN im Takt von Ableton Link läuft.
 *
 *  - LED-Wand 64×48: Pico 2W (Sender) mit den RP2040-Zero-Empfängern. Verbinden (WLAN oder USB),
 *    Pattern aus der hochgeladenen Bank wählen, Play/Stop, Helligkeit, Blackout. Folgt Ableton
 *    Link über „LINK <bpm> <beat>“ (link.js). Optional: aktives / Idle-Pattern je nach Play/Stop.
 *  - Relais-Rig und HUB75-Wand 128×96 (früher „DJ Light Bridge“): feste Pattern-Listen, die
 *    Mac-App schickt 30× pro Sekunde eine UDP-Zeile an jedes Ziel (LightBridge.swift).
 */
(function () {
  'use strict';

  const A = window.LEDApp;
  const D = () => window.LEDDevices;
  const L = () => window.LEDLink;
  const el = A.el;
  const box = document.getElementById('lightsDetail');

  const RELAY_PATTERNS = ['Alternate', 'Together', 'Chase', 'All On', 'All Off', 'Fast Chase', 'Reverse Chase', 'Bounce',
    'Cross Alternate', 'Random', 'Build Up', 'Build Down', 'Quarter Chase', 'Double Chase', 'Flicker', 'Random Chase'];
  const WALL_PATTERNS = ['Strobe', 'Color Flash', 'Scanner', 'All On', 'All Off', 'Fast Scanner', 'Bounce Scanner', 'Strobe Noise',
    'Build Up', 'Beat Flash', 'Noise', 'Color Noise', 'Scanner Pair', 'Slow Pulse', 'Build Up 16', 'Build Up 32'];
  const MULTS = [1, 2, 4, 8];

  // Zustand von der Mac-App (LightBridge) und von Carabiner
  let bridge = null;
  let link = { connected: false, peers: 0, bpm: 0, beat: 0, playing: false, hasPlaying: false, error: '', startedByApp: false };

  // 64×48-Wand: aktives / Idle-Pattern (Index in der Bank), lokal gespeichert
  const BW_KEY = 'ledwall-lights-bigwall';
  let bw = { follow: false, active: 0, idle: 0 };
  try { bw = Object.assign(bw, JSON.parse(localStorage.getItem(BW_KEY) || '{}')); } catch (e) { /* Standard */ }
  const saveBw = () => { try { localStorage.setItem(BW_KEY, JSON.stringify(bw)); } catch (e) { /* egal */ } };

  const post = (payload) => A.nativePost('lights', payload);
  const linkPlaying = () => (link.hasPlaying ? link.playing : true);

  // ---------------------------------------------------------------- Aufbau

  let sig = '';
  const E = {};

  function signature() {
    const d = D();
    const senders = d ? d.allSenders().map((s) => s.port + ':' + d.patterns(s.port).map((p) => p.name).join('|') + ':' + !!d.info(s.port)) : [];
    const dests = bridge ? bridge.destinations.map((x) => x.id + x.name + x.host + x.port).join(',') : '-';
    return [A.NATIVE, senders.join(';'), dests].join('#');
  }

  function render() {
    sig = signature();
    box.innerHTML = '';
    box.append(el('h1', null, 'Licht'),
      el('p', { class: 'muted' }, 'Alles hier läuft im Takt von Ableton Link (über Carabiner). Rekordbox, Ableton & Co. geben Tempo und Start/Stop vor.'));
    box.append(statusCard(), bigWallCard(), bridgeCard('relay'), bridgeCard('wall'));
    update();
  }

  function statusCard() {
    E.linkPill = el('span', { class: 'pill' });
    E.linkText = el('span', { class: 'muted' });
    E.bridgeBtn = el('button', { onclick: () => post({ action: 'enable', value: !(bridge && bridge.enabled) }) });
    E.mult = el('div', { class: 'seg' }, MULTS.map((m) => el('button', { 'data-m': m, onclick: () => post({ action: 'set', multiplier: m }) }, m + '×')));
    E.msg = el('code', { class: 'light-msg' });
    E.track = el('div', { class: 'track-state' });
    E.barNum = el('div', { class: 'bar-num' });
    E.dots = el('div', { class: 'beat-big' }, [0, 1, 2, 3].map((i) => el('i', null, String(i + 1))));
    E.playMode = el('div', { class: 'seg' },
      el('button', { 'data-pm': 'link', onclick: () => post({ action: 'set', playMode: 'link' }) }, 'Start/Stop von Link'),
      el('button', { 'data-pm': 'always', onclick: () => post({ action: 'set', playMode: 'always' }) }, 'Immer läuft'));
    E.offset = el('span', { class: 'muted', style: 'font-size:11px' });
    E.trackHint = el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' });
    return el('div', { class: 'card' },
      el('h3', null, 'Takt'),
      el('div', { class: 'beat-live' }, E.track, E.dots, E.barNum),
      E.trackHint,
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Ableton Link'), el('div', null, E.linkText, E.linkPill)),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Track läuft laut'), E.playMode, null),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Takt-Anfang'),
        el('div', null,
          el('button', { onclick: setDownbeat, title: 'Genau auf der „1“ des Tracks klicken' }, 'Jetzt ist die 1'), ' ',
          el('button', { onclick: () => setOffset(0) }, 'Zurücksetzen')),
        E.offset),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Licht-Brücke'), el('div', null, E.bridgeBtn)),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Tempo-Faktor'), E.mult,
        el('span', { class: 'muted', style: 'font-size:11px' }, 'Relais + HUB75')),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Gesendet'), E.msg),
      A.NATIVE ? null : el('p', { class: 'muted' }, 'Die Licht-Brücke (UDP) gibt es nur in der Mac-App.'));
  }

  // ------------------------------------------------- 64×48-Wand (Pico 2W)

  function bigWallCard() {
    const d = D();
    const senders = d ? d.allSenders() : [];
    E.bw = [];
    const list = el('div', null);
    if (!senders.length) list.append(el('p', { class: 'muted' }, 'Noch kein Pico 2W verbunden. Im eigenen WLAN „LEDWall“ ist er unter 192.168.4.1 erreichbar, im Heimnetz unter ledwall.local.'));
    for (const s of senders) list.append(senderBlock(s));

    E.bwHost = el('input', { type: 'text', placeholder: 'ledwall.local oder 192.168.4.1', style: 'width:220px' });
    const add = () => { if (E.bwHost.value.trim()) { d.addNetHost(E.bwHost.value, true); E.bwHost.value = ''; render(); } };
    E.bwHost.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') add(); });

    E.bwLinkBtn = el('button', { onclick: () => L() && L().setEnabled(!L().state.linkWanted) });
    E.bwFollow = el('input', { type: 'checkbox' });
    E.bwFollow.checked = !!bw.follow;
    E.bwFollow.onchange = () => { bw.follow = E.bwFollow.checked; saveBw(); lastAuto = {}; };

    return el('div', { class: 'card' },
      el('h3', null, 'LED-Wand 64×48 · Pico 2W + RP2040 Zero'),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Takt'), el('div', null, E.bwLinkBtn),
        el('span', { class: 'muted', style: 'font-size:11px' }, 'LINK an den Pico, alle 0,5 s')),
      el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Play/Stop folgen'),
        el('label', { class: 'inline' }, E.bwFollow, 'aktives Pattern bei Play, Idle-Pattern bei Stop'), null),
      list,
      el('div', { class: 'actions' }, E.bwHost, el('button', { onclick: add }, '+ Pico 2W im WLAN hinzufügen')));
  }

  function senderBlock(s) {
    const d = D();
    const pats = d.patterns(s.port);
    const e = { port: s.port };
    e.pill = el('span', { class: 'pill' });
    e.sub = el('div', { class: 'muted', style: 'font-size:12px' });
    e.play = el('button', { onclick: () => { const i = d.info(s.port); if (i) d.send(s.port, i.playing ? 'STOP' : 'PLAY'); } });
    e.black = el('button', { onclick: () => { const i = d.info(s.port); if (i) d.send(s.port, 'BLACKOUT ' + (i.blackout ? 0 : 1)); } }, 'Blackout');
    e.bright = el('input', { type: 'range', min: 0, max: 255, style: 'width:140px' });
    e.bright.addEventListener('change', () => d.send(s.port, 'BRIGHT ' + e.bright.value));
    e.now = el('input', { type: 'checkbox' });
    e.grid = el('div', { class: 'pat-grid' }, pats.map((p, i) => el('button', {
      'data-i': i, title: p.name + ' · ' + p.beats + ' Beats',
      onclick: () => d.send(s.port, 'PATTERN ' + i + (e.now.checked ? ' now' : '')),
    }, el('b', null, String(i + 1)), ' ', p.name)));
    const pick = (key) => el('div', { class: 'pat-grid small' }, pats.map((p, i) => el('button', {
      'data-i': i, 'data-k': key, onclick: () => { bw[key] = i; saveBw(); lastAuto = {}; update(); },
    }, el('b', null, String(i + 1)), ' ', p.name)));
    e.active = pick('active');
    e.idle = pick('idle');
    E.bw.push(e);
    const host = s.net ? s.host : 'USB';
    return el('div', { class: 'light-dev' },
      el('div', { class: 'light-dev-head' },
        el('b', null, 'Pico 2W'), el('span', { class: 'muted' }, ' · ' + host), e.pill,
        el('span', { class: 'spacer' }),
        el('button', { onclick: () => { A.setView('devices'); d.select(s.id); } }, 'Bank & Einstellungen …'),
        s.net ? el('button', { class: 'danger', onclick: () => { d.removeNetHost(s.host); render(); } }, 'Entfernen') : null),
      e.sub,
      el('div', { class: 'actions' }, e.play, e.black, el('label', { class: 'inline' }, 'Helligkeit', e.bright),
        el('label', { class: 'inline' }, e.now, 'sofort wechseln (sonst zum nächsten Takt)')),
      pats.length ? el('div', null, el('div', { class: 'grid-lbl' }, 'Pattern'), e.grid,
        el('div', { class: 'grid-lbl' }, 'Aktiv (Link läuft)'), e.active,
        el('div', { class: 'grid-lbl' }, 'Idle (Link gestoppt)'), e.idle)
        : el('p', { class: 'muted' }, d.info(s.port) ? 'Keine Bank auf dem Pico – unter „Bank & Einstellungen …“ das Projekt hochladen.' : 'Verbinde …'));
  }

  // ------------------------------------------------- Relais-Rig / HUB75-Wand (UDP)

  function bridgeCard(kind) {
    const isWall = kind === 'wall';
    const names = isWall ? WALL_PATTERNS : RELAY_PATTERNS;
    const keyA = isWall ? 'wallActive' : 'relayActive', keyI = isWall ? 'wallIdle' : 'relayIdle';
    const card = el('div', { class: 'card' }, el('h3', null, isWall ? 'HUB75-Wand 128×96 · Pico 2 W' : 'Relais-Rig · Pico 2 W'));
    if (!A.NATIVE || !bridge) { card.append(el('p', { class: 'muted' }, 'Nur in der Mac-App verfügbar.')); return card; }

    const dests = bridge.destinations.filter((x) => x.kind === kind);
    const table = el('table', { class: 'panel-table dest-table' },
      el('tr', null, el('th', null, 'Name'), el('th', null, 'Adresse'), el('th', null, 'Port'), el('th', null, ''), el('th', null, '')));
    for (const x of dests) {
      const name = el('input', { type: 'text', value: x.name, style: 'width:140px' });
      const host = el('input', { type: 'text', value: x.host, style: 'width:160px' });
      const port = el('input', { type: 'number', value: x.port, min: 1, max: 65535 });
      const save = () => post({ action: 'updateDest', id: x.id, name: name.value.trim(), host: host.value.trim(), port: parseInt(port.value, 10) || 5005 });
      for (const i of [name, host, port]) i.addEventListener('change', save);
      const pill = el('span', { class: 'pill', 'data-dest': x.id });
      table.append(el('tr', null, el('td', null, name), el('td', null, host), el('td', null, port), el('td', null, pill),
        el('td', null, el('button', { class: 'danger', onclick: () => post({ action: 'removeDest', id: x.id }) }, '✕'))));
    }
    if (!dests.length) table.append(el('tr', null, el('td', { colspan: 5, class: 'muted' }, 'Noch kein Ziel eingetragen.')));

    const nName = el('input', { type: 'text', placeholder: 'Name', style: 'width:140px' });
    const nHost = el('input', { type: 'text', placeholder: 'Hostname oder IP', style: 'width:160px' });
    const nPort = el('input', { type: 'number', value: 5005, min: 1, max: 65535 });
    const add = () => {
      if (!nHost.value.trim()) { A.toast('Bitte Hostname oder IP eingeben'); return; }
      post({ action: 'addDest', kind, name: nName.value.trim(), host: nHost.value.trim(), port: parseInt(nPort.value, 10) || 5005 });
    };
    nHost.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') add(); });

    const grid = (key) => el('div', { class: 'pat-grid' }, names.map((n, i) => el('button', {
      'data-key': key, 'data-n': i + 1, onclick: () => post({ action: 'set', [key]: i + 1 }),
    }, el('b', null, String(i + 1)), ' ', n)));

    card.append(table,
      el('div', { class: 'actions' }, nName, nHost, nPort, el('button', { onclick: add }, '+ Ziel hinzufügen')),
      el('div', { class: 'grid-lbl' }, 'Aktiv (Link läuft)'), grid(keyA),
      el('div', { class: 'grid-lbl' }, 'Idle (Link gestoppt)'), grid(keyI));
    return card;
  }

  // ---------------------------------------------------------------- Aktualisieren

  function setPill(p, cls, text) { p.className = 'pill ' + cls; p.textContent = text; }

  function update() {
    if (!E.linkPill) return;
    const lw = L() ? L().state.linkWanted : false;
    if (!link.connected) setPill(E.linkPill, 'warn', (lw || (bridge && bridge.enabled)) ? 'nicht verbunden' : 'aus');
    else setPill(E.linkPill, linkPlaying() ? 'ok' : 'info', linkPlaying() ? 'läuft' : 'gestoppt');
    E.linkText.textContent = link.connected
      ? link.bpm.toFixed(2) + ' BPM · ' + link.peers + ' Teilnehmer' + (link.exact ? '' : ' · Beat ungenau (ältere Carabiner-Version)') + (link.startedByApp ? ' · Carabiner von der App gestartet' : '')
      : (link.error || 'Carabiner wird automatisch verbunden bzw. gestartet, sobald Link oder die Licht-Brücke an ist.');

    const on = !!(bridge && bridge.enabled);
    E.bridgeBtn.textContent = on ? 'An – 30× pro Sekunde per UDP' : 'Aus – klicken zum Einschalten';
    E.bridgeBtn.classList.toggle('active', on);
    E.bridgeBtn.disabled = !A.NATIVE || !bridge;
    for (const b of E.mult.children) b.classList.toggle('on', !!bridge && +b.dataset.m === bridge.multiplier);
    E.msg.textContent = bridge && bridge.running && bridge.message ? bridge.message : '–';
    for (const b of E.playMode.children) b.classList.toggle('on', playMode() === b.dataset.pm);
    E.playMode.style.opacity = A.NATIVE && bridge ? '' : '.5';
    E.offset.textContent = beatOffset() ? 'Versatz ' + beatOffset() + ' Beat' + (beatOffset() > 1 ? 's' : '') : 'kein Versatz';
    E.trackHint.textContent = !link.connected ? ''
      : playMode() === 'always' ? 'Start/Stop wird ignoriert – es gelten immer die aktiven Patterns.'
        : !link.hasPlaying ? 'Diese Carabiner-Version meldet kein Start/Stop – der Track gilt immer als laufend.'
          : !link.playing ? 'Läuft der Track, aber hier steht „gestoppt“? Dann gibt deine DJ-Software Start/Stop nicht über Link weiter – oben „Immer läuft“ wählen.' : '';
    updateBeat();

    // Relais / HUB75
    if (bridge) {
      for (const b of box.querySelectorAll('.pat-grid button[data-key]')) b.classList.toggle('on', bridge[b.dataset.key] === +b.dataset.n);
      const ds = {};
      for (const x of bridge.destState || []) ds[x.id] = x;
      for (const p of box.querySelectorAll('.pill[data-dest]')) {
        const s = ds[p.dataset.dest];
        if (!bridge.enabled) setPill(p, 'info', 'aus');
        else if (!s || s.state === 'resolving' || s.state === 'off') setPill(p, 'warn', 'suche …');
        else if (s.state === 'ok') setPill(p, 'ok', 'erreichbar');
        else { setPill(p, 'warn', 'nicht erreichbar'); p.title = s.error || ''; }
      }
    }

    // 64×48-Wand
    if (E.bwLinkBtn) {
      E.bwLinkBtn.textContent = lw ? (L().active() ? 'Ableton Link aktiv' : 'Ableton Link – verbinde …') : 'Ableton Link aus – klicken zum Einschalten';
      E.bwLinkBtn.classList.toggle('active', !!(lw && L().active()));
      E.bwLinkBtn.disabled = !A.NATIVE;
    }
    const d = D();
    for (const e of E.bw || []) {
      const i = d.info(e.port);
      const off = d.isOffline(d.allSenders().find((s) => s.port === e.port) || {});
      if (!i) setPill(e.pill, 'warn', off ? 'nicht erreichbar' : 'verbinde …');
      else if (off) setPill(e.pill, 'warn', 'nicht erreichbar');
      else setPill(e.pill, i.link ? 'ok' : 'info', i.link ? 'Link' : 'eigener Takt');
      if (i) {
        e.sub.textContent = i.bpm.toFixed(1) + ' BPM · ' + (i.playing ? 'spielt' : 'gestoppt') + ' · ' +
          (i.bank && i.bank.ok ? (i.patternName || ('Pattern ' + (i.pattern + 1))) + (i.next >= 0 ? ' → ' + (i.next + 1) : '') + ' · ' + i.bank.walls + ' Wand/Wände' : 'keine Bank') +
          ' · ' + (i.fps || 0).toFixed(0) + ' fps';
        e.play.textContent = i.playing ? '❚❚ Stop' : '▶ Play';
        e.black.classList.toggle('active', !!i.blackout);
        if (document.activeElement !== e.bright) e.bright.value = i.bright;
        for (const b of e.grid.children) {
          b.classList.toggle('on', +b.dataset.i === i.pattern);
          b.classList.toggle('next', +b.dataset.i === i.next);
        }
      }
      for (const b of e.active.children) b.classList.toggle('on', +b.dataset.i === bw.active);
      for (const b of e.idle.children) b.classList.toggle('on', +b.dataset.i === bw.idle);
    }
    const badge = document.getElementById('lightsBadge');
    badge.hidden = !(link.connected && (on || lw));
    badge.textContent = '●';
  }

  // ---------------------------------------------------------------- Beat-Anzeige

  const playMode = () => (bridge && bridge.playMode) || 'link';
  const beatOffset = () => (bridge && bridge.beatOffset) || 0;
  function trackPlaying() {
    if (playMode() === 'always') return true;
    return linkPlaying();
  }
  // aktuelle Beat-Position inkl. Versatz (null ohne Link)
  function beatNow() {
    if (!link.connected || !(link.bpm > 0) || !L()) return null;
    return L().beatNow() + beatOffset();
  }

  function updateBeat() {
    if (!E.track) return;
    const b = beatNow();
    const playing = link.connected && trackPlaying();
    E.track.className = 'track-state ' + (!link.connected ? 'off' : playing ? 'on' : 'stop');
    E.track.textContent = !link.connected ? '– kein Link' : playing ? '▶ Track läuft' : '■ Track gestoppt';
    if (b == null) {
      E.barNum.textContent = '–';
      for (const d of E.dots.children) d.className = '';
      return;
    }
    const inBar = ((b % 4) + 4) % 4;
    const cur = Math.floor(inBar);
    const frac = inBar - cur;
    E.barNum.textContent = 'Takt ' + (Math.floor(b / 4) + 1) + ' · Beat ' + (cur + 1) + ' · ' + link.bpm.toFixed(1) + ' BPM';
    [...E.dots.children].forEach((d, i) => {
      d.className = i === cur ? (frac < 0.25 ? 'hit' : 'cur') : '';
      if (i === 0) d.classList.add('one');
    });
  }

  function setOffset(v) {
    post({ action: 'set', beatOffset: ((v % 4) + 4) % 4 });
  }
  // Klick genau auf der „1“: Versatz so wählen, dass die nächstgelegene Zählzeit zur 1 wird
  function setDownbeat() {
    if (!link.connected || !L()) { A.toast('Ableton Link ist nicht verbunden'); return; }
    const raw = L().beatNow();
    const nearest = Math.round(raw);
    setOffset((4 - (((nearest % 4) + 4) % 4)) % 4);
    A.toast('Takt-Anfang gesetzt – diese Zählzeit ist jetzt die 1');
  }

  // 64×48-Wand: bei Play/Stop von Link aktives bzw. Idle-Pattern wählen (zum nächsten Takt)
  let lastAuto = {};
  function autoSwitch() {
    const d = D();
    if (!bw.follow || !d || !link.connected) return;
    const now = performance.now();
    for (const s of d.senders()) {
      const i = d.info(s.port);
      if (!i || !i.bank || !i.bank.ok) continue;
      const want = Math.min(trackPlaying() ? bw.active : bw.idle, i.bank.patterns - 1);
      if (want < 0 || i.pattern === want || i.next === want) continue;
      if (lastAuto[s.port] && now - lastAuto[s.port] < 1500) continue;
      lastAuto[s.port] = now;
      d.send(s.port, 'PATTERN ' + want);
      if (!s.net) d.send(s.port, 'INFO'); // über WLAN kommt der Zustand mit der Antwort
    }
  }

  // ---------------------------------------------------------------- Ereignisse

  function onState(s) {
    const first = !bridge;
    bridge = s;
    if (A.view() !== 'lights') return;
    if (first || signature() !== sig) render(); else update();
  }

  function onLink(s) {
    const was = trackPlaying();
    Object.assign(link, s);
    if (was !== trackPlaying()) lastAuto = {};
    autoSwitch();
    if (A.view() === 'lights') update();
  }

  // Pico 2W abfragen und Anzeige auffrischen, solange der Tab offen ist
  setInterval(() => {
    if (A.view() !== 'lights' || !D()) return;
    for (const s of D().allSenders()) D().send(s.port, D().info(s.port) ? 'INFO' : 'PATTERNS');
  }, 1000);
  setInterval(() => {
    autoSwitch();
    if (A.view() !== 'lights') return;
    if (signature() !== sig) render(); else update();
  }, 300);

  setInterval(() => { if (A.view() === 'lights') updateBeat(); }, 40);

  A.onView((v) => {
    if (v !== 'lights') return;
    if (A.NATIVE) post({ action: 'state' });
    render();
  });
  if (A.NATIVE) post({ action: 'state' });

  window.LEDLights = { onState, onLink, beatOffset, trackPlaying };
})();
