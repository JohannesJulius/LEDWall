/*
 * Ableton Link über Carabiner: Die Mac-App liest BPM und Beat-Position aus dem laufenden
 * Carabiner-Fenster (CarabinerClient.swift) und
 *  - lässt die Vorschau der App im Ableton-Takt laufen,
 *  - schickt "LINK <bpm> <beat>" laufend an alle verbundenen Pico 2W (USB oder WLAN).
 * Carabiner nimmt nur Verbindungen vom eigenen Mac an, deshalb geht der Weg über die App.
 */
(function () {
  'use strict';

  const A = window.LEDApp;
  const $ = (id) => document.getElementById(id);
  const st = { enabled: false, linkWanted: false, connected: false, peers: 0, bpm: 0, beat: 0, playing: false, hasPlaying: false, error: '', t: 0 };

  function beatNow(extraSeconds) {
    return st.beat + ((performance.now() - st.t) / 60000 + (extraSeconds || 0) / 60) * st.bpm;
  }
  // Carabiner wird auch von der Licht-Brücke genutzt – für die Wand zählt nur, ob Link gewünscht ist
  const active = () => st.linkWanted && st.connected && st.bpm > 0;

  function onStatus(s) {
    const wasActive = active();
    Object.assign(st, s);
    st.t = performance.now();
    render();
    if (active() !== wasActive) {
      A.toast(active() ? 'Ableton Link verbunden – Tempo kommt von Carabiner' : (st.linkWanted ? (st.error || 'Ableton Link getrennt') : 'Ableton Link aus'), 3500);
      push(); // Picos sofort einrasten lassen
    }
  }

  function render() {
    const b = $('btnLink');
    b.classList.toggle('active', active());
    b.textContent = !st.linkWanted ? 'Link' : active() ? 'Link · ' + st.peers : 'Link …';
    b.title = !st.linkWanted ? 'Tempo und Beat von Ableton Link (über das Carabiner-Fenster)'
      : active() ? 'Ableton Link: ' + st.bpm.toFixed(2) + ' BPM, ' + st.peers + ' Teilnehmer – klicken zum Ausschalten'
        : (st.error || 'Verbinde mit Carabiner …');
  }

  function setEnabled(on) {
    try { localStorage.setItem('ledwall-link', on ? '1' : '0'); } catch (e) { /* egal */ }
    A.nativePost('link', { action: on ? 'start' : 'stop' });
  }

  // Takt an alle Pico 2W weitergeben (Laufzeit wird eingerechnet)
  function push() {
    if (!active() || !window.LEDDevices) return;
    for (const d of window.LEDDevices.senders()) {
      window.LEDDevices.sendQuiet(d.port, (lat) => 'LINK ' + st.bpm.toFixed(3) + ' ' + beatNow(lat).toFixed(4));
    }
  }

  A.setExternalClock(() => (active() ? { bpm: st.bpm, beat: beatNow() } : null));
  setInterval(push, 500);

  if (A.NATIVE) {
    $('btnLink').hidden = false;
    $('btnLink').onclick = () => setEnabled(!st.linkWanted);
    let saved = '0';
    try { saved = localStorage.getItem('ledwall-link') || '0'; } catch (e) { /* egal */ }
    if (saved === '1') setEnabled(true);
  }
  render();

  window.LEDLink = { onStatus, state: st, beatNow, setEnabled, active };
})();
