/* Transmittal QR — module screen (uses core.js).
 * Flow: For Transmittal -> On-Going Legal Evaluation -> Returned from Legal -> Transmitted / All Data.
 * A camera scan of NEW data saves it; a scan of data already in a step asks "Move to the next step?"
 * (the record only moves when confirmed). Everybody sees and changes everything. For Transmittal and
 * Returned from Legal are marked overdue after 10 minutes, counted on the server clock (Core.serverNow). */
(function () {
  'use strict';
  const { $, on } = Core;
  const escapeHtml = Core.esc;
  const todayDateStr = Core.todayStr;
  const submit = (op, label, opts) => Core.submit('tqr', op, label, opts).then((r) => { recompute(); return r; });
  window.__tqrApp = { editName, deleteScan, setStatus, forward, back };

  let html5QrCode = null, scanning = false, scanSession = 0, lastScanText = '', lastScanTime = 0;
  let currentScans = [];
  let categoryFilter = 'all';
  function recompute() {
    currentScans = Core.view('tqr').slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  }
  const TR = window.TqrRules;
  const STAGES = TR.STAGES;
  const STAGE_LABEL = { pending: 'For Transmittal', legal: 'On-Going Legal Evaluation', returned: 'Returned from Legal', printed: 'Transmitted / All Data' };
  const nextStage = (st) => STAGES[STAGES.indexOf(st) + 1] || null;
  const prevStage = (st) => STAGES[STAGES.indexOf(st) - 1] || null;
  const findById = (u) => currentScans.find((s) => s.uuid === u);
  const q = (u) => "'" + u + "'";

  function categoryBadge(cat) {
    return cat
      ? '<span class="qr-cat-badge qr-cat-permit" title="Applications">' + escapeHtml(cat) + '</span>'
      : '<span class="qr-cat-badge qr-cat-none">—</span>';
  }
  function matchesCategory(s) {
    if (categoryFilter === 'all') return true;
    if (categoryFilter === '__none') return !s.category;
    return s.category === categoryFilter;
  }

  function sourceBadge(source) {
    return source === 'manual'
      ? '<span class="qr-source-badge qr-source-manual" title="Entered manually">M</span>'
      : '<span class="qr-source-badge qr-source-camera" title="Scanned with camera">QR</span>';
  }
  // ---------- tabs ----------
  const TAB_IDS = { scan: 'tqr-scan-tab', log: 'tqr-log-tab', legal: 'tqr-legal-tab', returned: 'tqr-returned-tab', alldata: 'tqr-alldata-tab' };
  const TAB_BTN = { scan: 'tqr-tab-scan', log: 'tqr-tab-log', legal: 'tqr-tab-legal', returned: 'tqr-tab-returned', alldata: 'tqr-tab-alldata' };
  function switchTab(tab) {
    Object.keys(TAB_IDS).forEach(k => {
      const card = $(TAB_IDS[k]), btn = $(TAB_BTN[k]);
      if (card) card.classList.toggle('hidden', k !== tab);
      if (btn) btn.classList.toggle('active', k === tab);
    });
    if (tab === 'scan') {
      startScanner();
    } else {
      stopScanner();
      renderAll();
    }
  }
  Object.keys(TAB_BTN).forEach(k => on(TAB_BTN[k], 'click', () => switchTab(k)));
  // ---------- scanner (rear camera first, race-safe — same approach as qr-app.js) ----------
  function scanConfig(cameraChoice) {
    return {
      fps: 25,
      // The scan box is the WHOLE picture: only the box is shown (no wider camera
      // background around it) and it is as big as the picture, so a code is read
      // from as far away as the camera can still resolve it.
      qrbox: (vw, vh) => { const s = Math.floor(Math.min(vw, vh)); return { width: s, height: s }; },
      aspectRatio: 1.0,
      disableFlip: false,
      // The camera choice must live inside videoConstraints: html5-qrcode
      // ignores its first argument whenever videoConstraints is set.
      videoConstraints: Object.assign({
        width: { min: 480, ideal: 1920, max: 1920 },
        height: { min: 480, ideal: 1920, max: 1920 },
        advanced: [{ focusMode: 'continuous' }]
      }, cameraChoice),
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    };
  }

  function tryStartWith(cameraChoice) {
    $('tqr-reader').innerHTML = '';
    const inst = new Html5Qrcode('tqr-reader');
    return inst.start({ facingMode: 'environment' }, scanConfig(cameraChoice), onScanSuccess).then(() => inst);
  }

  function startScanner() {
    if (scanning) return;
    const mySession = ++scanSession;
    lastScanText = '';   // a fresh start: the first code in view counts
    // Back camera first: exact rear -> preferred rear -> labelled back/rear (or last listed).
    const chain = tryStartWith({ facingMode: { exact: 'environment' } })
      .catch(() => {
        if (mySession !== scanSession) throw new Error('stale');
        return tryStartWith({ facingMode: 'environment' });
      })
      .catch(() => {
        if (mySession !== scanSession) throw new Error('stale');
        return Html5Qrcode.getCameras().then(cameras => {
          if (mySession !== scanSession) throw new Error('stale');
          if (!cameras || !cameras.length) throw new Error('No camera found on this device.');
          const cam = cameras.find(c => /back|rear|environment/i.test(c.label)) || cameras[cameras.length - 1];
          return tryStartWith({ deviceId: { exact: cam.id } });
        });
      });

    chain.then(inst => {
      if (mySession !== scanSession) {
        inst.stop().then(() => inst.clear()).catch(() => {});
        return;
      }
      html5QrCode = inst;
      scanning = true;
      $('tqr-stop-scan-btn').classList.remove('hidden');
      $('tqr-start-scan-btn').classList.add('hidden');
    }).catch(err => {
      if (mySession !== scanSession) return;
      const msg = (err && err.message) ? err.message : err;
      $('tqr-reader').innerHTML = '<div class="qr-empty">Camera error: ' + escapeHtml(msg) + '</div>';
    });
  }

  function stopScanner() {
    scanSession++;
    if (html5QrCode && scanning) {
      html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
    }
    html5QrCode = null;
    scanning = false;
    const stopBtn = $('tqr-stop-scan-btn'), startBtn = $('tqr-start-scan-btn');
    if (stopBtn) stopBtn.classList.add('hidden');
    if (startBtn) startBtn.classList.remove('hidden');
  }
  on('tqr-stop-scan-btn', 'click', stopScanner);
  on('tqr-start-scan-btn', 'click', startScanner);

  // No waiting time between scans: a different code is taken at once, and the
  // same code is taken again as soon as it has been out of the camera's view for a
  // moment. The camera reports a code ~25 times a second while it is in view, and
  // those repeats count as one scan.
  const REARM_GAP_MS = 1000;
  async function onScanSuccess(decodedText) {
    const now = Date.now();
    const stillInView = decodedText === lastScanText && now - lastScanTime < REARM_GAP_MS;
    lastScanText = decodedText;
    lastScanTime = now;            // refreshed on every frame the code is visible
    if (stillInView) return;
    if (askOpen) return;           // a message box is waiting for an answer
    await saveScanData(decodedText, 'camera');
  }
  // ---------- sounds (made with the browser's own audio, no files) ----------
  let audioCtx = null;
  let soundOn = true;
  try { soundOn = localStorage.getItem('tqrSound') !== 'off'; } catch (e) { /* default on */ }
  function unlockAudio() {
    try {
      if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio on this device */ }
  }
  // Browsers only allow sound after a tap/click; any touch on the page unlocks it.
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(ev => document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));
  function tone(freq, start, dur, type, vol) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol || 0.25, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(start); o.stop(start + dur + 0.02);
  }
  // ok = accepted (rising two-note chime) · ask = the next-step message box opened
  // (two short beeps) · warn = not added / already there / error (low double buzz)
  function playSound(kind) {
    if (!soundOn) return;
    try {
      unlockAudio();
      if (!audioCtx || audioCtx.state === 'suspended') return;
      const t = audioCtx.currentTime;
      if (kind === 'ok') { tone(880, t, 0.12, 'sine', 0.3); tone(1320, t + 0.12, 0.2, 'sine', 0.3); }
      else if (kind === 'ask') { tone(988, t, 0.1, 'sine', 0.3); tone(988, t + 0.16, 0.1, 'sine', 0.3); }
      else { tone(200, t, 0.18, 'square', 0.12); tone(160, t + 0.2, 0.22, 'square', 0.12); }
    } catch (e) { /* cosmetic */ }
  }
  // ---------- voice confirmation ----------
  // Said only for a successful scan / move, never for warnings. Follows the same
  // Sound on/off button as the chimes.
  let voicePref = 'auto', voiceRate = 1.05;
  try { voicePref = localStorage.getItem('tqrVoice') || 'auto'; voiceRate = Number(localStorage.getItem('tqrVoiceSpeed')) || 1.05; } catch (e) { /* defaults */ }
  const VOICE_FOR = { pending: 'Scanned', legal: 'Forwarded to legal', returned: 'Received from legal', printed: 'Transmitted' };
  const VOICE_BACK = { pending: 'Moved back to for transmittal', legal: 'Moved back to ongoing legal evaluation', returned: 'Moved back to returned from legal' };
  let speechPrimed = false;
  function primeSpeech() {
    // iPhones/iPads only allow speech after it was first started by a tap.
    try {
      if (speechPrimed || !('speechSynthesis' in window)) return;
      speechPrimed = true;
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* no speech on this device */ }
  }
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(ev => document.addEventListener(ev, primeSpeech, { capture: true, passive: true }));
  function speak(text) {
    if (!soundOn || !text) return;
    try {
      if (!('speechSynthesis' in window)) return;
      const synth = window.speechSynthesis;
      synth.cancel();                     // never let confirmations pile up when scanning fast
      if (voicePref === 'none') return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = voiceRate;
      u.volume = 1;
      if (voicePref !== 'auto') { const v = (synth.getVoices() || []).find((x) => x.voiceURI === voicePref || x.name === voicePref); if (v) { u.voice = v; u.lang = v.lang; } }
      setTimeout(() => { try { synth.speak(u); } catch (e) { /* cosmetic */ } }, 380);   // after the chime
    } catch (e) { /* cosmetic */ }
  }
  function paintSoundBtn() {
    const b = $('tqr-sound-btn');
    if (b) b.textContent = soundOn ? '🔊 Sound on' : '🔇 Sound off';
  }
  paintSoundBtn();
  on('tqr-sound-btn', 'click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('tqrSound', soundOn ? 'on' : 'off'); } catch (e) { /* ignore */ }
    paintSoundBtn();
    if (soundOn) { playSound('ok'); speak('Sound on'); } else { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
  });

  // Small animated check mark in the middle of the screen — the acknowledgement
  // that a scan (or a move to the next step) was accepted. Not shown for warnings.
  function showCheck(say) {
    try {
      const old = document.querySelector('.tqr-check-pop');
      if (old) old.remove();
      const el = document.createElement('div');
      el.className = 'tqr-check-pop';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = '<svg viewBox="0 0 52 52" width="96" height="96"><circle class="tqr-check-circle" cx="26" cy="26" r="23" fill="none"/><path class="tqr-check-mark" fill="none" d="M15 27 l8 8 l15 -17"/></svg>';
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 1200);
      if (navigator.vibrate) navigator.vibrate(60);
      playSound('ok');
      speak(say);
    } catch (e) { /* purely cosmetic */ }
  }

  // ---------- voice settings (voices installed on this device) ----------
  function fillVoices() {
    const sel = $('tqr-voice-select'); if (!sel || !('speechSynthesis' in window)) return;
    const voices = (speechSynthesis.getVoices() || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = '<option value="auto">Voice: Automatic</option><option value="none">No voice</option>' +
      voices.map((v) => '<option value="' + escapeHtml(v.voiceURI || v.name) + '">' + escapeHtml(v.name + ' (' + v.lang + ')') + '</option>').join('');
    sel.value = voicePref; if (sel.value !== voicePref) sel.value = 'auto';
  }
  try { if ('speechSynthesis' in window) { fillVoices(); speechSynthesis.onvoiceschanged = fillVoices; } } catch (e) { /* ignore */ }
  on('tqr-voice-select', 'change', (e) => { voicePref = e.target.value; try { localStorage.setItem('tqrVoice', voicePref); } catch (x) { /* ignore */ } });
  { const sp = $('tqr-voice-speed'); if (sp) sp.value = String(voiceRate); if (sp && sp.value !== String(voiceRate)) sp.value = '1.05'; }
  on('tqr-voice-speed', 'change', (e) => { voiceRate = Number(e.target.value) || 1.05; try { localStorage.setItem('tqrVoiceSpeed', String(voiceRate)); } catch (x) { /* ignore */ } });
  on('tqr-voice-test', 'click', () => { const was = soundOn; soundOn = true; speak('Forwarded to legal'); soundOn = was; });

  // Returns true when the value was accepted (saved, or a recognised duplicate), so the manual box may clear itself.
  async function saveScanData(rawData, source) {
    const data = (rawData || '').trim();
    if (!data) return false;
    const flash = $('tqr-result-flash');
    flash.classList.remove('hidden', 'duplicate', 'error');
    recompute();
    const existing = Core.store('tqr').findByKey(TR.dataKey(data));
    const dataLine = (e) => `<div class="qr-flash-data">${sourceBadge(e.source)} ${escapeHtml(e.data)} ${categoryBadge(e.category)}</div>`;
    const meta = (e) => `${escapeHtml(e.date)} ${escapeHtml(e.time)} · ${escapeHtml(e.scannedByName)}`;
    if (existing) {
      // Camera scan of data in a working step: ask before moving it. Typing never moves it.
      if (source === 'camera' && existing.status === 'legal') {
        // On-Going Legal Evaluation -> Returned from Legal: no message box, the scan moves it straight away.
        const r2 = await submit({ type: 'move', uuid: existing.uuid, from: 'legal', to: 'returned' }, existing.data);
        if (r2.ok) {
          const e2 = r2.entry || existing;
          showCheck(VOICE_FOR[e2.status]);
          flash.innerHTML = `
            <div class="qr-flash-heading">✔ Moved to ${escapeHtml(STAGE_LABEL[e2.status])}</div>
            ${dataLine(e2)}
            <div class="qr-flash-meta">was in ${escapeHtml(STAGE_LABEL.legal)}</div>`;
        } else {
          playSound('warn');
          flash.classList.add('error');
          flash.innerHTML = `<div class="qr-flash-heading">Not moved</div><div class="qr-flash-meta">${escapeHtml(r2.error)}</div>`;
        }
        return true;
      }
      if (source === 'camera' && existing.status !== 'printed') {
        flash.classList.add('hidden');
        playSound('ask');
        askNextStep(existing, STAGE_LABEL[nextStage(existing.status)]);
        return true;
      }
      playSound('warn');
      flash.classList.add('duplicate');
      flash.innerHTML = `
        <div class="qr-flash-heading">⚠ ${existing.status === 'printed' ? 'Already in Transmitted / All Data — not added again' : 'Already in ' + escapeHtml(STAGE_LABEL[existing.status])}</div>
        ${dataLine(existing)}
        <div class="qr-flash-meta">${existing.status !== 'printed' ? 'Typing does not move it — scan it, or use the ➡ button on its row. ' : 'To process it again use ↩ back on its All Data row. '}First added ${meta(existing)}</div>`;
      return true;
    }
    const r = await submit({ type: 'scan', uuid: Core.uuid(), data, source }, data);
    if (!r.ok) {
      playSound('warn');
      flash.classList.add('error');
      flash.innerHTML = `<div class="qr-flash-heading">Not saved</div><div class="qr-flash-meta">${escapeHtml(r.error || 'Could not save.')}</div>`;
      return false;
    }
    const e = r.entry;
    showCheck(source === 'manual' ? 'Saved' : VOICE_FOR.pending);
    flash.innerHTML = `
      <div class="qr-flash-heading">✔ Saved to For Transmittal${Core.isQueued(e.uuid) && !Core.online() ? ' on this device' : ''}</div>
      ${dataLine(e)}
      <div class="qr-flash-meta">${meta(e)}${Core.isQueued(e.uuid) && !Core.online() ? ' · waiting to sync' : ''}</div>`;
    return true;
  }

  // ---------- message box for the next step ----------
  let askOpen = false;
  function askNextStep(entry, nextLabel) {
    if (askOpen) return;
    askOpen = true;
    const overlay = document.createElement('div');
    overlay.className = 'tqr-modal-overlay';
    overlay.innerHTML = `
      <div class="tqr-modal" role="dialog" aria-modal="true">
        <div class="tqr-modal-title">Move to the next step?</div>
        <div class="tqr-modal-data">${sourceBadge(entry.source)} ${escapeHtml(entry.data)} ${categoryBadge(entry.category)}</div>
        <div class="tqr-modal-steps">
          <span class="tqr-step-from">${escapeHtml(STAGE_LABEL[entry.status])}</span>
          <span class="tqr-step-arrow">➡</span>
          <span class="tqr-step-to">${escapeHtml(nextLabel)}</span>
        </div>
        <div class="tqr-modal-actions">
          <button type="button" class="qr-secondary-btn" id="tqr-ask-no">Cancel</button>
          <button type="button" id="tqr-ask-yes">${escapeHtml(((STAGE_UI[entry.status] || {}).forward || 'Yes, move it').replace('➡ ', ''))}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => { askOpen = false; overlay.remove(); document.removeEventListener('keydown', onKey, true); };
    let answered = false;
    const yes = async () => {
      if (answered) return; answered = true;
      overlay.querySelector('#tqr-ask-yes').disabled = true;
      const flash = $('tqr-result-flash');
      flash.classList.remove('hidden', 'duplicate', 'error');
      const cur = findById(entry.uuid) || entry;
      const r = await submit({ type: 'move', uuid: entry.uuid, from: cur.status, to: nextStage(cur.status) }, entry.data);
      if (r.ok) {
        const e = r.entry || cur;
        showCheck(VOICE_FOR[e.status]);
        flash.innerHTML = `
          <div class="qr-flash-heading">✔ Moved to ${escapeHtml(STAGE_LABEL[e.status])}</div>
          <div class="qr-flash-data">${sourceBadge(e.source)} ${escapeHtml(e.data)} ${categoryBadge(e.category)}</div>
          <div class="qr-flash-meta">was in ${escapeHtml(STAGE_LABEL[cur.status === e.status ? entry.status : cur.status])}</div>`;
      } else {
        playSound('warn');
        flash.classList.add('error');
        flash.innerHTML = `<div class="qr-flash-heading">Not moved</div><div class="qr-flash-meta">${escapeHtml(r.error)}</div>`;
      }
      close();
    };
    const no = () => {
      if (answered) return; answered = true;
      const flash = $('tqr-result-flash');
      flash.classList.remove('hidden', 'error');
      flash.classList.add('duplicate');
      flash.innerHTML = `<div class="qr-flash-heading">Not moved</div><div class="qr-flash-meta">${escapeHtml(entry.data)} stays in ${escapeHtml(STAGE_LABEL[entry.status])}</div>`;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') no(); else if (e.key === 'Enter') yes(); };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('#tqr-ask-yes').addEventListener('click', yes);
    overlay.querySelector('#tqr-ask-no').addEventListener('click', no);
    overlay.querySelector('#tqr-ask-yes').focus();
  }

  on('tqr-manual-save-btn', 'click', async () => {
    const input = $('tqr-manual-input');
    const value = input.value.trim();
    if (!value) { input.focus(); return; }
    if (await saveScanData(value, 'manual')) input.value = '';
    input.focus();
  });
  on('tqr-manual-input', 'keydown', (e) => { if (e.key === 'Enter') $('tqr-manual-save-btn').click(); });

  // ---------- category filter (options come from the same code list the server uses) ----------
  function loadCategoryOptions() {
    const sel = $('tqr-category-filter');
    if (!sel || sel.dataset.loaded) return;
    TR.RULES_DISPLAY_ORDER.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.label; o.textContent = c.label + ' (' + c.code.toUpperCase() + ')';
      sel.appendChild(o);
    });
    const none = document.createElement('option');
    none.value = '__none'; none.textContent = 'No category';
    sel.appendChild(none);
    sel.value = categoryFilter; sel.dataset.loaded = '1';
  }
  on('tqr-category-filter', 'change', (e) => { categoryFilter = e.target.value; renderAll(); });

  // ---------- rendering ----------
  function renderSafely(fn, label) { try { fn(); } catch (e) { console.error('Transmittal QR: failed to render ' + label, e); } }
  function renderAll() {
    recompute();
    renderSafely(() => renderStageTable('pending'), 'For Transmittal');
    renderSafely(() => renderStageTable('legal'), 'On-Going Legal Evaluation');
    renderSafely(() => renderStageTable('returned'), 'Returned from Legal');
    renderSafely(renderAllDataTable, 'Transmitted / All Data');
    renderSafely(updateWaits, 'waiting times');
    renderSafely(checkOverdue, 'overdue check');
  }
  ['log', 'legal', 'returned', 'alldata'].forEach((t) => on('tqr-refresh-' + t + '-btn', 'click', () => { Core.syncNow({ force: true, manual: true }); renderAll(); }));

  function matchesSearch(s, qq) {
    return (s.data || '').toLowerCase().includes(qq) || (s.name || '').toLowerCase().includes(qq) || (s.scannedByName || '').toLowerCase().includes(qq);
  }
  function renderNameContent(name) {
    return name ? '<span class="qr-name-display">' + escapeHtml(name) + '</span>' : '<span class="qr-name-placeholder">+ add name</span>';
  }
  const STAGE_UI = {
    pending:  { prefix: 'log',      empty: 'Nothing waiting for transmittal.', forward: '➡ Forward to Legal',      back: null,                         timed: true },
    legal:    { prefix: 'legal',    empty: 'Nothing under legal evaluation.',  forward: '➡ Received from Legal',   back: '↩ back to transmittal',      timed: false },
    returned: { prefix: 'returned', empty: 'Nothing returned from legal.',     forward: '➡ Transmit to DPD/NDPD',  back: '↩ back to legal evaluation', timed: true }
  };
  const STAGE_SHORT = { legal: 'To Legal Evaluation', returned: 'Returned from Legal' };

  // ---------- 10-minute mark ----------
  // Measured from when the record entered the step, on the SERVER clock (Core.serverNow: the last
  // server time seen, kept on the device), so a device with a wrong clock still agrees. Offline, the
  // notices use the records the device already has.
  const dueMinutes = TR.DUE_MINUTES;
  const DUE_STAGES = ['pending', 'returned'];
  const notified = new Set();
  let overdueSeeded = false;
  const serverNow = () => Core.serverNow();
  const sinceOf = (s) => Date.parse(s.stageAt || s.timestamp) || 0;
  const isOverdue = (s) => DUE_STAGES.includes(s.status) && sinceOf(s) && serverNow() - sinceOf(s) >= dueMinutes * 60000;
  function waitText(ms) {
    const m = Math.floor(Math.max(0, ms) / 60000);
    if (m < 1) return 'under 1 min';
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function updateWaits() {
    document.querySelectorAll('#tqr-panel .tqr-wait').forEach((td) => {
      const since = Number(td.dataset.since) || 0;
      const ms = serverNow() - since;
      const over = since && ms >= dueMinutes * 60000;
      td.textContent = since ? (over ? '⏰ ' + waitText(ms) + ' — overdue' : waitText(ms)) : '—';
      td.classList.toggle('tqr-wait-over', !!over);
      const tr = td.closest('tr');
      if (tr) tr.classList.toggle('tqr-overdue', !!over);
    });
  }
  function setBadge(host, n) {
    if (!host) return;
    let b = host.querySelector(':scope > .tqr-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'tqr-badge'; host.appendChild(b); }
    b.textContent = n;
    b.title = n + ' overdue (over ' + dueMinutes + ' minutes)';
  }
  const baseTitle = document.title;
  function checkOverdue() {
    const over = Core.me() ? Core.view('tqr').filter(isOverdue) : [];
    setBadge($('tqr-tab-log'), over.filter((s) => s.status === 'pending').length);
    setBadge($('tqr-tab-returned'), over.filter((s) => s.status === 'returned').length);
    setBadge(document.querySelector('.sidebar-tab[data-target="tqr-panel"]'), over.length);
    document.title = over.length ? '⏰ (' + over.length + ') ' + baseTitle : baseTitle;
    const key = (s) => s.uuid + ':' + s.status + ':' + sinceOf(s);
    const fresh = over.filter((s) => !notified.has(key(s)));
    fresh.forEach((s) => notified.add(key(s)));
    if (!fresh.length) return;
    if (!overdueSeeded || fresh.length > 3) {
      showToast('⏰ ' + fresh.length + ' record' + (fresh.length === 1 ? ' is' : 's are') + ' past ' + dueMinutes + ' minutes',
        'For Transmittal: ' + fresh.filter((s) => s.status === 'pending').length + ' · Returned from Legal: ' + fresh.filter((s) => s.status === 'returned').length, fresh[0].status);
    } else {
      fresh.forEach((s) => showToast('⏰ Past ' + dueMinutes + ' minutes', s.data + ' — in ' + STAGE_LABEL[s.status], s.status));
    }
    overdueSeeded = true;
  }
  function showToast(title, text, stage) {
    try {
      let box = document.querySelector('.tqr-toasts');
      if (!box) { box = document.createElement('div'); box.className = 'tqr-toasts'; document.body.appendChild(box); }
      const t = document.createElement('div');
      t.className = 'tqr-toast';
      t.innerHTML = '<button type="button" class="tqr-toast-x" title="Close">×</button><div class="tqr-toast-title"></div><div class="tqr-toast-text"></div>';
      t.querySelector('.tqr-toast-title').textContent = title;
      t.querySelector('.tqr-toast-text').textContent = text;
      t.querySelector('.tqr-toast-x').addEventListener('click', (e) => { e.stopPropagation(); t.remove(); });
      t.addEventListener('click', () => { t.remove(); Core.showModule('tqr'); switchTab(stage === 'returned' ? 'returned' : 'log'); });
      box.appendChild(t);
      setTimeout(() => t.remove(), 30000);
    } catch (e) { /* cosmetic */ }
  }
  function stageRows(stage) {
    const ui = STAGE_UI[stage];
    const qq = ($('tqr-' + ui.prefix + '-search').value || '').trim().toLowerCase();
    let rows = currentScans.filter((s) => s.status === stage && matchesCategory(s));
    if (qq) rows = rows.filter((s) => matchesSearch(s, qq));
    return rows;
  }
  // On a phone the tables turn into one card per record; each cell shows its own column name in front of its value.
  function labelCells(wrap) {
    const heads = [...wrap.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    wrap.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => td.setAttribute('data-label', heads[i] || '')));
  }
  const waitingTag = (s) => (Core.isQueued(s.uuid) ? '<span class="qr-pending-tag" title="Saved on this device, waiting to reach the server">⏳</span>' : '');
  function renderStageTable(stage) {
    const ui = STAGE_UI[stage];
    const wrap = $('tqr-' + ui.prefix + '-table-wrap');
    const countLabel = $('tqr-' + ui.prefix + '-count');
    if (!wrap || !countLabel) return;
    const rows = stageRows(stage);
    countLabel.textContent = 'Total: ' + rows.length + ' record' + (rows.length === 1 ? '' : 's');
    if (!rows.length) { wrap.innerHTML = '<div class="qr-empty">' + ui.empty + '</div>'; return; }
    const moved = stage !== 'pending';
    let html = '<table><thead><tr><th>Data</th><th>Category</th><th>Name</th><th>By</th><th>' + (moved ? 'Scanned Date' : 'Date') + '</th>' +
      (moved ? '<th>' + STAGE_SHORT[stage] + ' Date</th><th>Time</th><th>' + STAGE_SHORT[stage] + ' By</th>' : '<th>Time</th>') +
      (ui.timed ? '<th>Waiting (max ' + dueMinutes + ' min)</th>' : '') + '<th></th></tr></thead><tbody>';
    for (const s of rows) {
      const dt = stage === 'pending' ? [s.date, s.time, null] : [s[stage + 'Date'], s[stage + 'Time'], s[stage + 'ByName']];
      html += `<tr>
        <td class="qr-data-cell" title="Scanned data is locked and cannot be edited">${sourceBadge(s.source)} ${escapeHtml(s.data)}${waitingTag(s)}</td>
        <td>${categoryBadge(s.category)}</td>
        <td class="qr-name-cell" onclick="window.__tqrApp.editName(this, ${q(s.uuid)})">${renderNameContent(s.name)}</td>
        <td>${escapeHtml(s.scannedByName)}</td>
        <td>${escapeHtml(s.date)}</td>` +
        (moved ? `<td>${escapeHtml(dt[0] || '—')}</td><td>${escapeHtml(dt[1] || '—')}</td><td>${escapeHtml(dt[2] || '—')}</td>` : `<td>${escapeHtml(s.time)}</td>`) +
        (ui.timed ? `<td class="tqr-wait" data-since="${sinceOf(s)}"></td>` : '') +
        `<td class="qr-row-actions">
          <button class="qr-forward-btn" title="Move to the next step (same as scanning it again)" onclick="window.__tqrApp.forward(${q(s.uuid)})">${ui.forward}</button>
          ${ui.back ? `<button class="qr-revert-btn" onclick="window.__tqrApp.back(${q(s.uuid)})">${ui.back}</button>` : ''}
          ${stage === 'pending' ? `<button class="qr-del-btn" onclick="window.__tqrApp.deleteScan(${q(s.uuid)})">🗑</button>` : ''}
        </td></tr>`;
    }
    wrap.innerHTML = html + '</tbody></table>';
    labelCells(wrap);
    updateWaits();
  }
  ['log', 'legal', 'returned'].forEach((prefix) => {
    const stage = prefix === 'log' ? 'pending' : prefix;
    on('tqr-' + prefix + '-search', 'input', () => renderStageTable(stage));
    on('tqr-clear-' + prefix + '-search-btn', 'click', () => { $('tqr-' + prefix + '-search').value = ''; renderStageTable(stage); });
  });

  // ALL DATA: every record in every step, newest activity first
  function allDataRows() {
    const qq = ($('tqr-alldata-search').value || '').trim().toLowerCase();
    const dateFilter = $('tqr-alldata-date-filter').value || '';
    let results = currentScans.filter((s) => matchesCategory(s)).sort((a, b) => sinceOf(b) - sinceOf(a));
    if (qq) results = results.filter((s) => matchesSearch(s, qq));
    else if (dateFilter) results = results.filter((s) => [s.date, s.legalDate, s.returnedDate, s.printedDate].includes(dateFilter));
    return results;
  }
  function renderAllDataTable() {
    const wrap = $('tqr-alldata-table-wrap');
    const results = allDataRows();
    $('tqr-alldata-count').textContent = 'Total: ' + results.length + ' record' + (results.length === 1 ? '' : 's');
    if (!results.length) { wrap.innerHTML = '<div class="qr-empty">No matching records.</div>'; return; }
    let html = '<table><thead><tr><th>Data</th><th>Category</th><th>Status</th><th>Name</th><th>By</th><th>Scanned Date</th><th>To Legal Evaluation</th><th>Returned from Legal</th><th>Transmitted Date</th><th>Transmitted Time</th><th></th></tr></thead><tbody>';
    for (const s of results) {
      html += `<tr>
        <td class="qr-data-cell">${sourceBadge(s.source)} ${escapeHtml(s.data)}${waitingTag(s)}</td>
        <td>${categoryBadge(s.category)}</td>
        <td><span class="tqr-status tqr-status-${s.status}">${escapeHtml(STAGE_LABEL[s.status] || s.status)}</span></td>
        <td>${escapeHtml(s.name || '')}</td>
        <td>${escapeHtml(s.scannedByName)}</td>
        <td>${escapeHtml(s.date)}</td>
        <td>${escapeHtml(s.legalDate ? s.legalDate + ' ' + (s.legalTime || '') : '—')}</td>
        <td>${escapeHtml(s.returnedDate ? s.returnedDate + ' ' + (s.returnedTime || '') : '—')}</td>
        <td>${escapeHtml(s.printedDate || '—')}</td>
        <td>${escapeHtml(s.printedTime || '—')}</td>
        <td>${s.status === 'printed' ? `<button class="qr-revert-btn" onclick="window.__tqrApp.back(${q(s.uuid)})">↩ back to returned from legal</button>` : ''}</td>
      </tr>`;
    }
    wrap.innerHTML = html + '</tbody></table>';
    labelCells(wrap);
  }
  on('tqr-alldata-search', 'input', renderAllDataTable);
  on('tqr-clear-alldata-search-btn', 'click', () => { $('tqr-alldata-search').value = ''; renderAllDataTable(); });
  on('tqr-alldata-date-filter', 'change', renderAllDataTable);
  on('tqr-alldata-date-filter', 'click', (e) => { try { if (e.target.showPicker) e.target.showPicker(); } catch (err) { /* browser opens it its own way */ } });
  on('tqr-clear-alldata-date-btn', 'click', () => { $('tqr-alldata-date-filter').value = ''; renderAllDataTable(); });

  // ---------- row actions ----------
  function editName(cell, id) {
    if (cell.querySelector('input')) return;
    const scan = findById(id);
    cell.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text'; input.value = (scan && scan.name) || ''; input.placeholder = 'Enter name';
    cell.appendChild(input); input.focus(); input.select();
    let saved = false;
    const save = async () => {
      if (saved) return; saved = true;
      const r = await submit({ type: 'rename', uuid: id, name: input.value.trim() }, scan ? scan.data : '');
      if (!r.ok) alert('Could not save name: ' + r.error);
      renderAll();
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { saved = true; renderAll(); }
    });
  }
  async function deleteScan(id) {
    if (!confirm('Delete this record?')) return;
    const scan = findById(id);
    const r = await submit({ type: 'delete', uuid: id }, scan ? scan.data : '');
    if (!r.ok) alert('Could not delete: ' + r.error);
    renderAll();
  }
  // `from` is the step this screen showed, so if someone else moved it first the server refuses it
  // (the person is told under "Sync issues").
  async function setStatus(id, status, announce) {
    const cur = findById(id);
    const r = await submit({ type: 'move', uuid: id, from: cur ? cur.status : undefined, to: status }, cur ? cur.data : '');
    if (!r.ok) alert(r.error || 'Could not update record.');
    renderAll();
    if (r.ok && announce) {
      const st = (r.entry && r.entry.status) || status;
      showCheck(announce === 'back' ? VOICE_BACK[st] : VOICE_FOR[st]);   // same chime, check and voice as the message box
    }
  }
  function forward(id) { const cur = findById(id); const next = cur && nextStage(cur.status); if (next) setStatus(id, next, true); }
  function back(id) { const cur = findById(id); const prev = cur && prevStage(cur.status); if (prev) setStatus(id, prev, 'back'); }

  // ---------- print the For Transmittal list ----------
  on('tqr-print-btn', 'click', () => {
    const selected = stageRows('pending');
    if (!selected.length) { alert('There is nothing waiting for transmittal to print yet.'); return; }
    const rows = selected.map((s, i) => `
      <tr><td>${i + 1}</td><td>${escapeHtml(s.data)}</td><td>${escapeHtml(s.category || '')}</td><td>${escapeHtml(s.name || '')}</td></tr>`).join('');
    const printedOn = new Date().toLocaleString();
    const docHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Transmittal</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; padding: 40px; }
  h1 { text-align: center; letter-spacing: 2px; margin-bottom: 4px; }
  .meta { text-align: center; color: #555; font-size: 0.85rem; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #333; padding: 8px 10px; font-size: 0.9rem; text-align: left; }
  th { background: #f0f0f0; }
  .signatures { display: flex; justify-content: space-between; margin-top: 70px; }
  .sig-block { width: 45%; text-align: center; }
  .sig-line { border-top: 1px solid #111; margin-top: 50px; padding-top: 6px; font-size: 0.85rem; }
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
  <h1>TRANSMITTAL</h1>
  <div class="meta">Printed on ${escapeHtml(printedOn)}</div>
  <table>
    <thead><tr><th>Count</th><th>Data</th><th>Category</th><th>Name</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="signatures">
    <div class="sig-block"><div class="sig-line">Received by</div></div>
    <div class="sig-block"><div class="sig-line">Endorsed by</div></div>
  </div>
  <script>window.onload = function() { window.print(); };<\/script>
</body>
</html>`;
    const w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups to print the transmittal.'); return; }
    w.document.open(); w.document.write(docHtml); w.document.close();
  });

  // ---------- Excel (All Data) — built here, so it works offline; respects the filters ----------
  on('tqr-download-alldata-btn', 'click', () => {
    recompute();
    const rows = allDataRows();
    const headers = ['Data', 'Category', 'Status', 'Source', 'Name', 'Scanned By', 'Scanned Date', 'Scanned Time',
      'To Legal Evaluation Date', 'To Legal Evaluation Time', 'To Legal Evaluation By', 'Returned from Legal Date', 'Returned from Legal Time', 'Returned from Legal By',
      'Transmitted Date', 'Transmitted Time', 'Transmitted By'];
    const widths = [34, 32, 26, 10, 24, 18, 13, 13, 16, 16, 18, 16, 16, 18, 15, 15, 18];
    const data = rows.map((s) => [s.data || '', s.category || '', STAGE_LABEL[s.status] || s.status, s.source === 'manual' ? 'Manual' : 'Camera', s.name || '',
      s.scannedByName || s.scannedBy || '', s.date || '', s.time || '',
      s.legalDate || '', s.legalTime || '', s.legalByName || '', s.returnedDate || '', s.returnedTime || '', s.returnedByName || '',
      s.printedDate || '', s.printedTime || '', s.printedByName || '']);
    Core.downloadXlsx('Transmittal-All-Data-' + ($('tqr-alldata-date-filter').value || todayDateStr()) + '.xlsx', [{ name: 'All Data', headers, widths, rows: data }]);
  });

  // ---------- module hooks ----------
  Core.register({
    id: 'tqr', panel: 'tqr-panel',
    onShow() { loadCategoryOptions(); switchTab('scan'); },
    onHide() { stopScanner(); },
    onLogout() { currentScans = []; checkOverdue(); },
    onData() {
      recompute();
      const p = $('tqr-panel');
      if (p && !p.classList.contains('hidden')) renderAll(); else checkOverdue();
    },
    describe(o) {
      const t = o.op.type, what = o.label || '';
      return 'Transmittal QR: ' + (t === 'scan' ? 'Save ' : t === 'rename' ? 'Rename ' : t === 'delete' ? 'Delete ' : t === 'move' ? ('Move to ' + (STAGE_LABEL[o.op.to] || o.op.to) + ': ') : '') + what;
    },
    issueFor(o, r) { return r.duplicate ? 'Transmittal QR: ' + o.label + ' — already exists, your copy was not added.' : null; }
  });
  { const df = $('tqr-alldata-date-filter'); if (df) df.value = todayDateStr(); }
  setInterval(() => { updateWaits(); checkOverdue(); }, 15000);   // the clock moves on even when nothing changed
})();
