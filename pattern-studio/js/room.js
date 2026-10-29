/*
 * Raum: das echte Setup virtuell nachbauen. Wände im 3D-Raum platzieren und drehen,
 * Adresse und Empfänger zuordnen, live sehen, was jede Wand zeigt. Gespeichert in project.setup.
 */
(function () {
  'use strict';

  const A = window.LEDApp;
  const S = window.LEDSetup;
  const el = A.el;
  const $ = (id) => document.getElementById(id);
  const THREE = window.THREE;
  const DEG = Math.PI / 180;

  let renderer, scene, camera, orbit, gizmo, roomGroup, wallsGroup, raycaster;
  const meshes = {};       // wallId -> { group, screen, canvas, ctx, img, tex, label }
  let selId = null;
  let ready = false;
  const cache = {};

  const setup = () => A.project().setup;
  const wallById = (id) => setup().walls.find((w) => w.id === id) || null;

  // ---------------------------------------------------------------- Szene

  function init() {
    if (ready || !THREE) return;
    ready = true;
    const canvas = $('roomCanvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.outputEncoding = THREE.sRGBEncoding;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0c10);
    camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
    scene.add(new THREE.HemisphereLight(0xb0c0ff, 0x202020, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(3, 6, 4);
    scene.add(sun);

    roomGroup = new THREE.Group();
    wallsGroup = new THREE.Group();
    scene.add(roomGroup, wallsGroup);

    orbit = new THREE.OrbitControls(camera, canvas);
    orbit.enableDamping = true;
    orbit.target.set(0, 1.2, 0);

    gizmo = new THREE.TransformControls(camera, canvas);
    gizmo.setSize(0.8);
    gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
    gizmo.addEventListener('objectChange', onGizmoChange);
    scene.add(gizmo);
    applySnap();

    raycaster = new THREE.Raycaster();
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || gizmo.dragging) return;
      pick(e);
    });

    new ResizeObserver(resize).observe($('roomWrap'));
    rebuild();
    setCamera('persp');
  }

  function resize() {
    if (!renderer) return;
    const w = $('roomWrap').clientWidth, h = $('roomWrap').clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function buildRoom() {
    roomGroup.clear();
    const r = setup().room;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.d), new THREE.MeshStandardMaterial({ color: 0x0e0f13, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    roomGroup.add(floor);
    const grid = new THREE.GridHelper(Math.max(r.w, r.d), Math.round(Math.max(r.w, r.d) * 2), 0x3a3f4c, 0x23262e);
    grid.position.y = 0.002;
    grid.scale.set(r.w / Math.max(r.w, r.d), 1, r.d / Math.max(r.w, r.d));
    roomGroup.add(grid);
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(r.w, r.h, r.d)),
      new THREE.LineBasicMaterial({ color: 0x5a6070 }));
    box.position.y = r.h / 2;
    roomGroup.add(box);
    // Markierung "vorne" (Publikumsseite = +z)
    const front = new THREE.Mesh(new THREE.PlaneGeometry(r.w, 0.06), new THREE.MeshBasicMaterial({ color: 0xff3d7f }));
    front.rotation.x = -Math.PI / 2;
    front.position.set(0, 0.004, r.d / 2 - 0.03);
    roomGroup.add(front);
  }

  function makeLabel(text) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 96;
    const x = c.getContext('2d');
    x.font = 'bold 44px -apple-system, Helvetica, sans-serif';
    x.textAlign = 'center';
    x.fillStyle = 'rgba(0,0,0,.55)';
    x.fillRect(0, 10, 512, 76);
    x.fillStyle = '#fff';
    x.fillText(text, 256, 64);
    const tex = new THREE.CanvasTexture(c);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    spr.scale.set(0.6, 0.11, 1);
    return spr;
  }

  function buildWall(w) {
    const size = S.wallSize(w);
    const group = new THREE.Group();
    group.userData.wallId = w.id;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(size.w + 0.02, size.h + 0.02, 0.04),
      new THREE.MeshStandardMaterial({ color: 0x22252d, roughness: 0.8 }));
    frame.position.z = -0.02;
    group.add(frame);
    const canvas = document.createElement('canvas');
    canvas.width = w.width; canvas.height = w.height;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearFilter;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    else tex.encoding = THREE.sRGBEncoding;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(size.w, size.h), new THREE.MeshBasicMaterial({ map: tex }));
    screen.position.z = 0.001;
    group.add(screen);
    const label = makeLabel(w.name + ' · ' + w.address);
    label.scale.set(size.w * 1.2, size.w * 0.225, 1);
    label.position.y = size.h / 2 + size.w * 0.15;
    group.add(label);
    wallsGroup.add(group);
    meshes[w.id] = { group, screen, canvas, ctx, img: ctx.createImageData(w.width, w.height), tex, label, key: wallKey(w) };
    placeWall(w);
  }

  const wallKey = (w) => [w.width, w.height, w.pitch, w.name, w.address].join('|');

  function placeWall(w) {
    const m = meshes[w.id];
    if (!m) return;
    m.group.position.set(w.pos.x, w.pos.y, w.pos.z);
    m.group.rotation.set(w.rot.x * DEG, w.rot.y * DEG, w.rot.z * DEG, 'YXZ');
  }

  // Szene an das Setup angleichen
  function rebuild() {
    if (!ready) return;
    buildRoom();
    const ids = new Set(setup().walls.map((w) => w.id));
    for (const id of Object.keys(meshes)) {
      const w = wallById(id);
      if (!ids.has(id) || (w && meshes[id].key !== wallKey(w))) {
        if (gizmo.object === meshes[id].group) gizmo.detach();
        wallsGroup.remove(meshes[id].group);
        delete meshes[id];
      }
    }
    for (const w of setup().walls) {
      if (!meshes[w.id]) buildWall(w);
      else placeWall(w);
    }
    if (selId && !wallById(selId)) selId = null;
    attachGizmo();
  }

  function attachGizmo() {
    if (!ready) return;
    if (selId && meshes[selId]) gizmo.attach(meshes[selId].group);
    else gizmo.detach();
  }

  function onGizmoChange() {
    const g = gizmo.object;
    if (!g) return;
    const w = wallById(g.userData.wallId);
    if (!w) return;
    const r = (v) => Math.round(v * 1000) / 1000;
    w.pos = { x: r(g.position.x), y: r(g.position.y), z: r(g.position.z) };
    const e = new THREE.Euler().setFromQuaternion(g.quaternion, 'YXZ');
    w.rot = { x: Math.round(e.x / DEG * 10) / 10, y: Math.round(e.y / DEG * 10) / 10, z: Math.round(e.z / DEG * 10) / 10 };
    A.changed();
    updateInspectorValues();
  }

  function pick(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(v, camera);
    const hits = raycaster.intersectObjects(wallsGroup.children, true);
    let id = null;
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.wallId) o = o.parent;
      if (o) { id = o.userData.wallId; break; }
    }
    select(id);
  }

  function select(id) {
    selId = id;
    attachGizmo();
    renderList();
    renderInspector();
  }

  // Kamera so setzen, dass alle Wände im Bild sind (ohne Wände: der ganze Raum)
  function setCamera(kind) {
    const walls = setup().walls, r = setup().room;
    const box = new THREE.Box3();
    if (walls.length) {
      for (const w of walls) {
        const s = S.wallSize(w), half = Math.max(s.w, s.h) / 2;
        box.expandByPoint(new THREE.Vector3(w.pos.x - half, w.pos.y - half, w.pos.z - half));
        box.expandByPoint(new THREE.Vector3(w.pos.x + half, w.pos.y + half, w.pos.z + half));
      }
    } else {
      box.set(new THREE.Vector3(-r.w / 2, 0, -r.d / 2), new THREE.Vector3(r.w / 2, r.h, r.d / 2));
    }
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const d = Math.max(size.x, size.y, size.z, 0.6) * 1.8 + 0.4;
    if (kind === 'front') camera.position.set(c.x, c.y, c.z + d);
    else if (kind === 'top') camera.position.set(c.x, c.y + d * 1.3, c.z + 0.001);
    else camera.position.set(c.x + d * 0.6, c.y + d * 0.45, c.z + d * 0.9);
    orbit.target.copy(c);
    orbit.update();
  }

  function applySnap() {
    const on = $('roomSnap').checked;
    gizmo.setTranslationSnap(on ? 0.05 : null);
    gizmo.setRotationSnap(on ? 15 * DEG : null);
  }

  // ---------------------------------------------------------------- Seitenleisten

  function field(label, input, extra) {
    return el('div', { class: 'row' }, el('span', { class: 'lbl' }, label), input, extra || el('span'));
  }

  function numField(obj, key, step, onChange, attrs) {
    const i = el('input', Object.assign({ type: 'number', step }, attrs || {}));
    i.value = obj[key];
    i.addEventListener('input', () => { const v = +i.value; if (isFinite(v)) { obj[key] = v; onChange(); } });
    return i;
  }

  function renderSettings() {
    const box = $('roomSettings');
    box.innerHTML = '';
    const s = setup();
    const onRoom = () => { A.changed(); if (ready) buildRoom(); };
    const mode = el('select', null, el('option', { value: 'copy' }, 'Jede Wand zeigt das ganze Pattern'), el('option', { value: 'span' }, 'Pattern über alle Wände verteilt'));
    mode.value = s.mode;
    mode.addEventListener('change', () => { s.mode = mode.value; A.changed(); });
    box.append(
      field('Breite (m)', numField(s.room, 'w', 0.1, onRoom, { min: 1 })),
      field('Tiefe (m)', numField(s.room, 'd', 0.1, onRoom, { min: 1 })),
      field('Höhe (m)', numField(s.room, 'h', 0.1, onRoom, { min: 1 })),
      field('Inhalt', mode),
      el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' }, '„Verteilt“: von vorne gesehen bilden alle Wände eine gemeinsame Leinwand.'));
  }

  function renderList() {
    const ul = $('wallList');
    ul.innerHTML = '';
    setup().walls.forEach((w) => {
      ul.append(el('li', { class: w.id === selId ? 'sel' : '', onclick: () => select(w.id) },
        el('span', null, w.name), el('span', { class: 'addr' }, 'Adr. ' + w.address + (w.uid ? ' · ✓' : ''))));
    });
    if (!setup().walls.length) ul.append(el('li', { class: 'muted' }, 'Noch keine Wand – „+“ klicken.'));
  }

  let inspectorInputs = null;
  function renderInspector() {
    const box = $('wallInspector');
    box.innerHTML = '';
    inspectorInputs = null;
    const w = wallById(selId);
    if (!w) { box.append(el('div', { class: 'empty' }, 'Wand in der Liste oder im Raum anklicken.')); return; }
    const onMove = () => { placeWall(w); A.changed(); };
    const onShape = () => { A.changed(); rebuild(); renderList(); };
    const name = el('input', { type: 'text' });
    name.value = w.name;
    name.addEventListener('change', () => { w.name = name.value; onShape(); });

    const devs = window.LEDDevices ? window.LEDDevices.state : null;
    const receivers = devs ? Object.values(devs.info) : [];
    const recvSel = el('select', null, el('option', { value: '' }, '– kein Empfänger –'),
      receivers.map((i) => el('option', { value: i.uid }, i.name + ' (Adr. ' + i.addr + ')')));
    if (w.uid && !receivers.some((i) => i.uid === w.uid)) recvSel.append(el('option', { value: w.uid }, 'nicht angeschlossen: ' + w.uid.slice(-6)));
    recvSel.value = w.uid || '';
    recvSel.addEventListener('change', () => {
      for (const o of setup().walls) if (o !== w && o.uid === recvSel.value) o.uid = '';
      w.uid = recvSel.value;
      const info = receivers.find((i) => i.uid === w.uid);
      if (info) { w.address = info.addr; w.width = info.w; w.height = info.h; }
      onShape();
      renderInspector();
    });

    const xyz = (obj, step, attrs) => el('div', { class: 'xyz' }, ['x', 'y', 'z'].map((k) => numField(obj, k, step, onMove, attrs)));
    const pos = xyz(w.pos, 0.05);
    const rot = xyz(w.rot, 5);
    inspectorInputs = { pos, rot, w };

    box.append(
      el('div', { class: 'section' }, el('h3', null, 'Wand'),
        field('Name', name),
        field('Adresse', numField(w, 'address', 1, onShape, { min: 1, max: 254 })),
        field('Empfänger', recvSel)),
      el('div', { class: 'section' }, el('h3', null, 'Position (m)'),
        el('div', { class: 'muted', style: 'font-size:11px' }, 'x = links/rechts, y = Höhe (Mitte der Wand), z = vorne/hinten'),
        pos),
      el('div', { class: 'section' }, el('h3', null, 'Drehung (°)'),
        el('div', { class: 'muted', style: 'font-size:11px' }, 'x = kippen, y = drehen (Blickrichtung), z = rollen'),
        rot,
        el('div', { class: 'actions', style: 'display:flex;gap:6px;margin-top:6px' },
          el('button', { onclick: () => { w.rot.y = (w.rot.y + 90) % 360; onMove(); renderInspector(); } }, '↻ 90°'),
          el('button', { onclick: () => { w.rot = { x: 0, y: 0, z: 0 }; onMove(); renderInspector(); } }, 'Gerade'),
          el('button', { onclick: () => { w.pos.y = S.wallSize(w).h / 2; onMove(); renderInspector(); } }, 'Auf den Boden'))),
      el('div', { class: 'section' }, el('h3', null, 'Größe'),
        field('Pixel', el('span', null, w.width + ' × ' + w.height), el('span', { class: 'muted' }, w.uid ? 'vom Empfänger' : '')),
        field('Pixelabstand', numField(w, 'pitch', 0.5, onShape, { min: 0.5 }), el('span', { class: 'muted' }, 'mm')),
        field('Maße', el('span', { class: 'muted' }, (S.wallSize(w).w * 100).toFixed(1) + ' × ' + (S.wallSize(w).h * 100).toFixed(1) + ' cm'))));
  }

  function updateInspectorValues() {
    if (!inspectorInputs) return;
    const { pos, rot, w } = inspectorInputs;
    ['x', 'y', 'z'].forEach((k, i) => {
      if (document.activeElement !== pos.children[i]) pos.children[i].value = w.pos[k];
      if (document.activeElement !== rot.children[i]) rot.children[i].value = w.rot[k];
    });
  }

  // ---------------------------------------------------------------- Ablauf

  function refresh() {
    if (!$('wallList')) return;
    renderSettings();
    renderList();
    renderInspector();
    rebuild();
  }

  A.onView((v) => {
    if (v !== 'room') return;
    init();
    resize();
    refresh();
  });

  A.onFrame((ts, lb) => {
    if (!ready || A.view() !== 'room') return;
    const frames = S.renderWalls(A.pattern(), lb, setup(), cache);
    for (const w of setup().walls) {
      const m = meshes[w.id], f = frames[w.id];
      if (!m || !f || f.length !== w.width * w.height * 3) continue;
      const d = m.img.data;
      for (let i = 0, j = 0; i < f.length; i += 3, j += 4) {
        d[j] = f[i] * 255; d[j + 1] = f[i + 1] * 255; d[j + 2] = f[i + 2] * 255; d[j + 3] = 255;
      }
      m.ctx.putImageData(m.img, 0, 0);
      m.tex.needsUpdate = true;
    }
    orbit.update();
    renderer.render(scene, camera);
  });

  $('btnWallAdd').onclick = () => {
    const s = setup();
    const n = s.walls.length + 1;
    const last = s.walls[s.walls.length - 1];
    const w = S.makeWall(n, last
      ? { pitch: last.pitch, pos: { x: last.pos.x + S.wallSize(last).w + 0.05, y: last.pos.y, z: last.pos.z }, rot: Object.assign({}, last.rot) }
      : { pos: { x: 0, y: 1.2, z: -s.room.d / 2 + 0.1 } });
    s.walls.push(w);
    selId = w.id;
    A.changed();
    refresh();
  };
  $('btnWallDup').onclick = () => {
    const w = wallById(selId);
    if (!w) return;
    const c = JSON.parse(JSON.stringify(w));
    c.id = window.LEDRenderer.newId('wall');
    c.name = w.name + ' Kopie';
    c.uid = '';
    c.address = Math.min(254, Math.max(...setup().walls.map((x) => x.address)) + 1);
    c.pos.x += S.wallSize(w).w + 0.05;
    setup().walls.push(c);
    selId = c.id;
    A.changed();
    refresh();
  };
  $('btnWallDel').onclick = () => {
    const s = setup();
    const i = s.walls.findIndex((w) => w.id === selId);
    if (i < 0 || !confirm('Wand „' + s.walls[i].name + '“ aus dem Raum entfernen?')) return;
    s.walls.splice(i, 1);
    selId = null;
    A.changed();
    refresh();
  };
  for (const b of $('tfMode').children) {
    b.onclick = () => {
      if (!ready) return;
      gizmo.setMode(b.dataset.mode);
      for (const x of $('tfMode').children) x.classList.toggle('on', x === b);
    };
  }
  for (const b of $('camViews').children) b.onclick = () => ready && setCamera(b.dataset.cam);
  $('roomSnap').addEventListener('change', () => ready && applySnap());
  document.addEventListener('keydown', (e) => {
    if (A.view() !== 'room' || !ready || e.metaKey || e.ctrlKey) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes((document.activeElement || {}).tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'w') $('tfMode').children[0].click();
    if (k === 'e') $('tfMode').children[1].click();
  });

  window.LEDRoom = { refresh, select };
  refresh();
})();
