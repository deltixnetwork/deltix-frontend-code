'use strict';

// Pre-app PIN gate. In the native app the PIN comes first: index.html hides the whole app (class
// pin-gate-pending) and only this script reveals it, once the Android plugin reports the app unlocked.
// The lock itself lives in native code (AppPinPlugin); this file is only the screen in front of it.
(function () {
  const root = document.documentElement;
  const NATIVE = root.classList.contains('pin-gate-pending');
  const PIN_LENGTH = 6;
  const RECOVERY_KEY = 'dltx_pin_recovery';
  const STATE_TIMEOUT_MS = 5000;
  const $ = (id) => document.getElementById(id);
  const resolved = () => Promise.resolve();

  if (!NATIVE) {
    window.DeltixPinGate = {
      ready: resolved(), isShowing: () => false, isRecovering: () => false, whenOpen: resolved,
      onResume: resolved, hold: resolved, back: () => false, cover() {}, completeRecovery: resolved,
    };
    if ($('appPinSettings')) $('appPinSettings').hidden = true;
    return;
  }

  const gate = $('pinGate');
  const ui = { title: $('pinGateTitle'), sub: $('pinGateSub'), body: $('pinGateBody'), actions: $('pinGateActions'), note: $('pinGateNote') };
  const settingsModal = $('pinSettingsModal');
  const padModal = $('pinPadModal');
  const plugin = () => window.Capacitor?.Plugins?.DeltixPin || null;

  let recovering = false;
  try { recovering = sessionStorage.getItem(RECOVERY_KEY) === '1'; } catch { /* storage blocked: the PIN gate applies */ }
  let skipPin = false;       // "continue without a PIN" after a storage failure: this launch only, never saved
  let view = 'boot';
  let lastState = {};
  let gatePad = null;
  let flowPad = null;
  let draftPin = '';         // the PIN being created; held in memory only until it is saved
  let evaluating = null;
  let epoch = 0;             // bumped whenever the app is covered, so an older lock check cannot reveal it
  let bioBusy = false;
  let autoPrompted = false;  // the biometric prompt opens by itself once per lock, not on every redraw
  let saving = false;
  let inerted = [];
  let waiters = [];
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });

  const FINGERPRINT = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/>'
    + '<path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/>'
    + '<path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/>'
    + '<path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/></svg>';

  const BACKSPACE = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"/><path d="m12 9 6 6"/><path d="m18 9-6 6"/></svg>';

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Easy-to-guess PINs: 111111, 123456, 654321, 567890, 121212, 123123, 112233, 123321.
  function weakPin(pin) {
    const digits = [...pin].map(Number);
    const steps = digits.slice(1).map((d, i) => (d - digits[i] + 10) % 10);
    return /^(\d)\1+$/.test(pin)
      || steps.every((s) => s === 1) || steps.every((s) => s === 9)
      || /^(\d{2})\1\1$/.test(pin) || /^(\d{3})\1$/.test(pin)
      || /^(\d)\1(\d)\2(\d)\3$/.test(pin)
      || /^(\d)(\d)(\d)\3\2\1$/.test(pin);
  }
  const WEAK_TEXT = 'That PIN is too easy to guess. Avoid 123456, 111111 and repeating patterns.';
  const LEGACY_TEXT = 'Deltix PINs are now 6 digits. Please choose a new one.';

  function wrongPinText(remaining) {
    if (remaining === 1) return 'Wrong PIN. One attempt left, then the PIN locks and needs an email code.';
    if (remaining > 1) return `Wrong PIN. ${remaining} attempts left.`;
    return 'Wrong PIN.';
  }

  // ---------- PIN pad: six boxes + number keypad (no system keyboard) ----------
  function createPad(host, { onComplete, onBiometric }) {
    host.textContent = '';
    const wrap = h('div', 'pin-pad');
    const boxes = h('div', 'pin-boxes');
    boxes.setAttribute('role', 'group');
    const cells = Array.from({ length: PIN_LENGTH }, () => { const cell = h('span', 'pin-box'); cell.setAttribute('aria-hidden', 'true'); return cell; });
    boxes.append(...cells);
    const message = h('p', 'pin-pad-msg');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    const announce = h('div', 'pin-sr');
    announce.setAttribute('aria-live', 'polite');
    const keypad = h('div', 'pin-keypad');
    keypad.setAttribute('role', 'group');
    keypad.setAttribute('aria-label', 'Number pad');
    wrap.append(boxes, message, announce, keypad);
    host.append(wrap);

    let value = '';
    let revealAt = -1;       // the digit just typed shows briefly, then turns into a dot
    let revealTimer = 0;
    let working = false;
    let failing = false;
    let destroyed = false;

    function paint() {
      cells.forEach((cell, i) => {
        const filled = i < value.length;
        cell.classList.toggle('filled', filled);
        cell.classList.toggle('current', !working && !failing && i === value.length);
        cell.textContent = filled && i === revealAt ? value[i] : '';
      });
      boxes.setAttribute('aria-label', `PIN, ${value.length} of ${PIN_LENGTH} digits entered`);
      announce.textContent = value.length ? `${value.length} of ${PIN_LENGTH} digits` : '';
    }

    const pad = {
      say(text, tone = 'error') {
        message.textContent = text || '';
        message.className = `pin-pad-msg${text ? ` ${tone}` : ''}`;
      },
      press(digit) {
        if (destroyed || working || failing || value.length >= PIN_LENGTH) return;
        value += digit;
        revealAt = value.length - 1;
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => { revealAt = -1; paint(); }, 450);
        paint();
        if (value.length < PIN_LENGTH) { pad.say(''); return; }
        working = true;
        wrap.classList.add('is-working');
        Promise.resolve(onComplete(value, pad))
          .catch(() => pad.fail('Something went wrong. Please try again.'))
          .finally(() => {
            working = false;
            wrap.classList.remove('is-working');
            if (!destroyed && !failing && value.length >= PIN_LENGTH) pad.clear();
            else if (!destroyed) paint();
          });
      },
      back() {
        if (destroyed || working || failing || !value) return;
        value = value.slice(0, -1);
        revealAt = -1;
        paint();
      },
      clear() {
        value = '';
        revealAt = -1;
        paint();
      },
      fail(text) {
        failing = true;
        boxes.classList.add('error', 'shake');
        pad.say(text, 'error');
        paint();
        setTimeout(() => {
          if (destroyed) return;
          value = '';
          revealAt = -1;
          failing = false;
          boxes.classList.remove('error', 'shake');
          paint();
        }, 460);
      },
      destroy() {
        destroyed = true;
        clearTimeout(revealTimer);
        wrap.remove();
      },
    };

    const addKey = (content, label, onPress, extra = '') => {
      const key = h('button', `pin-key ${extra}`.trim());
      key.type = 'button';
      if (content.startsWith('<')) key.innerHTML = content; else key.textContent = content;
      if (label) key.setAttribute('aria-label', label);
      key.addEventListener('click', onPress);
      keypad.append(key);
    };
    for (let d = 1; d <= 9; d += 1) addKey(String(d), null, () => pad.press(String(d)));
    if (onBiometric) addKey(FINGERPRINT, 'Unlock with biometrics', () => onBiometric(), 'pin-key-icon');
    else keypad.append(h('span', 'pin-key pin-key-spacer'));
    addKey('0', null, () => pad.press('0'));
    addKey(BACKSPACE, 'Delete last digit', () => pad.back(), 'pin-key-icon');
    paint();
    return pad;
  }

  // A hardware keyboard (or an emulator) types into whichever pad is on screen.
  function currentPad() {
    if (!gate.hidden) return gatePad;
    if (!padModal.hidden) return flowPad;
    return null;
  }
  document.addEventListener('keydown', (event) => {
    const pad = currentPad();
    if (!pad || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[0-9]$/.test(event.key)) { pad.press(event.key); event.preventDefault(); }
    else if (event.key === 'Backspace' || event.key === 'Delete') { pad.back(); event.preventDefault(); }
  });

  // ---------- Gate chrome ----------
  function setInert(on) {
    if (on) {
      inerted = [...document.body.children].filter((node) => node !== gate && !node.inert && node.tagName !== 'SCRIPT');
      inerted.forEach((node) => { node.inert = true; });
    } else {
      inerted.forEach((node) => { node.inert = false; });
      inerted = [];
    }
  }

  function closeFlows() {
    settingsModal.hidden = true;
    padModal.hidden = true;
    if (flowPad) { flowPad.destroy(); flowPad = null; }
  }

  function render({ name, title = '', sub = '', note = '', pad = null, body = null, actions = [], cover = false }) {
    view = name;
    const wasHidden = gate.hidden;
    gate.classList.toggle('is-cover', cover);
    ui.title.textContent = title;
    ui.sub.textContent = sub;
    ui.note.textContent = note;
    if (gatePad) { gatePad.destroy(); gatePad = null; }
    ui.body.textContent = '';
    if (pad) gatePad = createPad(ui.body, pad);
    else if (body) ui.body.append(body);
    ui.actions.textContent = '';
    for (const action of actions) {
      const button = h('button', action.className || 'pin-gate-link', action.label);
      button.type = 'button';
      button.addEventListener('click', action.onClick);
      ui.actions.append(button);
    }
    root.classList.add('pin-gate-pending');
    gate.hidden = false;
    if (wasHidden) { closeFlows(); setInert(true); }
    if (!cover) liftNativeCover();
  }

  function openUi() {
    view = 'open';
    autoPrompted = false;
    draftPin = '';
    if (gatePad) { gatePad.destroy(); gatePad = null; }
    ui.body.textContent = '';
    gate.hidden = true;
    gate.classList.remove('is-cover');
    root.classList.remove('pin-gate-pending');
    setInert(false);
    liftNativeCover();
    markReady();
    const pending = waiters;
    waiters = [];
    pending.forEach((resolve) => resolve());
  }

  // The native side puts an opaque view over the WebView whenever the app is stopped or starting (AppPinPlugin
  // showCover), because a WebView that was in the background can still show its last signed-in frame for a moment
  // on return. It comes off only once the page has really drawn the PIN screen or the unlocked app.
  let liftToken = 0;
  function liftNativeCover() {
    const native = plugin();
    if (!native) return;
    const token = ++liftToken;
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      if (token !== liftToken || document.hidden) return;
      try { native.uncover().catch(() => {}); } catch { /* a plugin build without uncover(): nothing to lift */ }
    }, 30)));
  }

  const whenOpen = () => (gate.hidden ? resolved() : new Promise((resolve) => waiters.push(resolve)));

  // Opaque screen shown the moment the app leaves the foreground, so nothing of it is visible while the
  // lock is being re-checked on return.
  function cover() {
    epoch += 1;
    liftToken += 1;   // a lift still waiting for its frames must not take the native cover down again
    if (recovering || skipPin || !gate.hidden) return;
    render({ name: 'cover', cover: true });
  }

  // ---------- Views ----------
  function showCreate(state, notice) {
    draftPin = '';
    render({
      name: 'create',
      title: 'Create your PIN',
      sub: 'Choose a 6-digit PIN to lock Deltix on this phone.',
      note: 'It keeps your account safe if someone else uses your phone. Your PIN never replaces your wallet keys or recovery phrase.',
      pad: {
        onComplete: (value, pad) => {
          if (weakPin(value)) { pad.fail(WEAK_TEXT); return; }
          draftPin = value;
          showConfirm(state);
        },
      },
    });
    if (notice && gatePad) gatePad.say(notice, 'info');
  }

  function showConfirm(state) {
    render({
      name: 'confirm',
      title: 'Confirm your PIN',
      sub: 'Enter the same 6 digits once more.',
      pad: {
        onComplete: (value, pad) => {
          if (value !== draftPin) { pad.fail('The PINs don’t match. Try again, or start over.'); return; }
          if (state.biometricAvailable) { showBiometricOffer(); return; }
          return savePin(false);
        },
      },
      actions: [{ label: 'Start over', onClick: () => showCreate(state) }],
    });
  }

  function showBiometricOffer() {
    const icon = h('div', 'pin-gate-bioicon');
    icon.innerHTML = FINGERPRINT;
    render({
      name: 'bio',
      title: 'Unlock with biometrics?',
      sub: 'Open Deltix with your fingerprint or face. Your PIN still works any time.',
      body: icon,
      actions: [
        { label: 'Turn on biometrics', className: 'btn primary', onClick: () => savePin(true) },
        { label: 'Not now', className: 'btn ghost', onClick: () => savePin(false) },
      ],
    });
  }

  async function savePin(biometric) {
    if (saving) return;
    saving = true;
    const pin = draftPin;
    draftPin = '';
    try {
      await plugin().setPin({ pin, biometric });
      openUi();
    } catch (error) {
      if (error?.code === 'PIN_ALREADY_SET') evaluate();
      else showStorageFailed();
    } finally {
      saving = false;
    }
  }

  function showStorageFailed() {
    render({
      name: 'storage',
      title: 'Couldn’t save your PIN',
      sub: 'This phone wouldn’t let Deltix store the PIN securely. Try again, or continue without a PIN until the next time you open the app.',
      actions: [
        { label: 'Try again', className: 'btn primary', onClick: () => evaluate() },
        { label: 'Continue without a PIN for now', className: 'btn ghost', onClick: () => { skipPin = true; openUi(); } },
      ],
    });
  }

  function showUnlock(state) {
    const biometric = Boolean(state.biometricEnabled && state.biometricAvailable);
    render({
      name: 'unlock',
      title: 'Enter your PIN',
      sub: 'Unlock Deltix Network.',
      pad: { onComplete: submitUnlock, onBiometric: biometric ? promptBiometric : null },
      actions: [{ label: 'Forgot PIN?', onClick: showForgot }],
    });
    if (biometric && !autoPrompted) {
      autoPrompted = true;
      setTimeout(promptBiometric, 250);
    }
  }

  async function submitUnlock(value, pad) {
    let result;
    try {
      result = await plugin().verifyPin({ pin: value });
    } catch {
      pad.fail('The PIN could not be checked. Try again.');
      return;
    }
    if (result.verified) { openUi(); return; }
    if (result.lockedOut) { showLockedOut(); return; }
    pad.fail(wrongPinText(result.attemptsRemaining));
  }

  async function promptBiometric() {
    if (bioBusy || view !== 'unlock' || document.hidden) return;
    bioBusy = true;
    try {
      const result = await plugin().authenticateBiometric();
      if (result?.verified) openUi();
    } catch (error) {
      if (error?.code === 'PIN_LOCKED_OUT') showLockedOut();
      // Cancelled or not recognised: the PIN pad stays available.
    } finally {
      bioBusy = false;
    }
  }

  function showLockedOut() {
    render({
      name: 'lockedout',
      title: 'PIN locked',
      sub: 'Too many wrong attempts. Sign in again with an email code to set a new PIN. You’ll be signed out on this phone first; your balance and account are not affected.',
      actions: [{ label: 'Reset PIN with an email code', className: 'btn primary', onClick: startRecovery }],
    });
  }

  function showForgot() {
    render({
      name: 'forgot',
      title: 'Reset your PIN?',
      sub: 'You’ll be signed out on this phone and we’ll email you a one-time code. After you sign in you’ll set a new PIN. Your balance and account are not affected.',
      actions: [
        { label: 'Email me a code', className: 'btn primary', onClick: startRecovery },
        { label: 'Back', className: 'btn ghost', onClick: () => evaluate() },
      ],
    });
  }

  function showUnavailable() {
    render({
      name: 'unavailable',
      title: 'Security check unavailable',
      sub: 'Deltix couldn’t start its PIN protection. Close the app and open it again.',
      actions: [{ label: 'Try again', className: 'btn primary', onClick: () => evaluate() }],
    });
  }

  // ---------- Evaluation: what does the lock say right now? ----------
  async function readState() {
    const p = plugin();
    if (!p) throw new Error('PIN plugin unavailable');
    const state = await Promise.race([
      p.getState(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('PIN state timed out')), STATE_TIMEOUT_MS)),
    ]);
    lastState = state || {};
    return lastState;
  }

  function evaluate() {
    if (evaluating) return evaluating;
    if (bioBusy) return whenOpen();
    const run = (async () => {
      for (;;) {
        const seen = epoch;
        let state = null;
        let failed = false;
        if (!(recovering || skipPin)) {
          try { state = await readState(); } catch { failed = true; }
        }
        if (seen !== epoch) continue;    // the app was covered again while asking: the answer may be stale
        if (recovering || skipPin) openUi();
        else if (failed) showUnavailable();
        else if (!state.configured) showCreate(state, state.legacy ? LEGACY_TEXT : '');
        else if (state.lockedOut) showLockedOut();
        else if (state.locked) showUnlock(state);
        else openUi();
        return;
      }
    })();
    // Released from a callback, never from inside the async body: when the body finishes without awaiting
    // (recovery), clearing it there would run before this assignment and leave a stale promise behind.
    evaluating = run;
    const release = () => { if (evaluating === run) evaluating = null; };
    run.then(release, release);
    return run;
  }

  // ---------- Forgotten PIN: only a fresh email code gets back in ----------
  // The page restarts signed out (app.js drops every saved session when it sees the flag). A new PIN is
  // created once the email code has been verified (completeRecovery).
  function startRecovery() {
    try { sessionStorage.setItem(RECOVERY_KEY, '1'); } catch { /* the PIN gate simply applies again */ }
    location.reload();
  }

  async function completeRecovery() {
    const p = plugin();
    for (let attempt = 0; attempt < 2 && p; attempt += 1) {
      try { await p.resetPinAfterReauthentication(); break; } catch { /* retried once */ }
    }
    try { sessionStorage.removeItem(RECOVERY_KEY); } catch { /* ignore */ }
    recovering = false;
    await evaluate();
    await whenOpen();
  }

  // The app is about to leave on purpose (an ad, the mail app, a link): the next return within `ms` does not lock.
  function hold(ms) {
    const p = plugin();
    if (!p || !p.holdSession) return resolved();
    return Promise.race([p.holdSession({ ms }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]);
  }

  // Hardware Back: inside the gate it steps back where that makes sense (never into the app); in the app it
  // closes an open PIN dialog. Returns whether it handled the press.
  function back() {
    if (!gate.hidden) {
      if (view === 'confirm') { showCreate(lastState); return true; }
      if (view === 'forgot') { evaluate(); return true; }
      return false;
    }
    if (settingsModal.hidden && padModal.hidden) return false;
    closeFlows();
    return true;
  }

  // ---------- In-app: PIN & security (change PIN, biometric switch) ----------
  function toast(text, tone) {
    if (typeof window.toast === 'function') window.toast(text, { tone });
  }

  async function openSettings() {
    try { await readState(); } catch { return; }
    $('pinBioRow').hidden = !lastState.biometricAvailable;
    $('pinBioToggle').checked = Boolean(lastState.biometricEnabled);
    $('pinSettingsHint').textContent = '';
    settingsModal.hidden = false;
  }

  function openFlow(kind) {
    closeFlows();
    let step = kind === 'change' ? 'current' : 'verify';
    let currentPin = '';
    let nextPin = '';
    const copy = {
      current: ['Change PIN', 'Enter your current PIN.'],
      new: ['Change PIN', 'Choose a new 6-digit PIN.'],
      confirm: ['Change PIN', 'Enter the new PIN once more.'],
      verify: [kind === 'bio-on' ? 'Turn on biometrics' : 'Turn off biometrics', 'Enter your PIN to confirm.'],
    };
    const paintStep = () => {
      $('pinPadTitle').textContent = copy[step][0];
      $('pinPadSub').textContent = copy[step][1];
    };
    const lockOut = async () => {
      closeFlows();
      try { await plugin().lock(); } catch { /* the next resume re-checks */ }
      evaluate();
    };
    const finish = (text) => { closeFlows(); toast(text, 'success'); };

    async function onEntered(value, pad) {
      if (step === 'current') {
        const result = await plugin().verifyPin({ pin: value });
        if (result.verified) { currentPin = value; step = 'new'; paintStep(); pad.clear(); return; }
        if (result.lockedOut) { await lockOut(); return; }
        pad.fail(wrongPinText(result.attemptsRemaining));
        return;
      }
      if (step === 'new') {
        if (weakPin(value)) { pad.fail(WEAK_TEXT); return; }
        if (value === currentPin) { pad.fail('Choose a different PIN from your current one.'); return; }
        nextPin = value; step = 'confirm'; paintStep(); pad.clear();
        return;
      }
      if (step === 'confirm') {
        if (value !== nextPin) { nextPin = ''; step = 'new'; paintStep(); pad.fail('The PINs don’t match. Choose the new PIN again.'); return; }
        const result = await plugin().changePin({ currentPin, newPin: value });
        currentPin = ''; nextPin = '';
        if (result.changed) { finish('PIN changed.'); return; }
        if (result.lockedOut) { await lockOut(); return; }
        step = 'current'; paintStep(); pad.fail('Your current PIN could not be confirmed. Start again.');
        return;
      }
      const result = await plugin().setBiometric({ pin: value, enabled: kind === 'bio-on' });
      if (result.updated) { finish(kind === 'bio-on' ? 'Biometric unlock is on.' : 'Biometric unlock is off.'); return; }
      if (result.lockedOut) { await lockOut(); return; }
      pad.fail(wrongPinText(result.attemptsRemaining));
    }

    paintStep();
    flowPad = createPad($('pinPadRoot'), { onComplete: onEntered });
    padModal.hidden = false;
  }

  if ($('appPinSettings')) {
    $('appPinSettings').hidden = false;
    $('appPinSettings').addEventListener('click', openSettings);
  }
  $('pinChangeBtn').addEventListener('click', () => { settingsModal.hidden = true; openFlow('change'); });
  $('pinSettingsClose').addEventListener('click', () => { settingsModal.hidden = true; });
  $('pinBioToggle').addEventListener('change', (event) => {
    const want = event.target.checked;
    event.target.checked = !want;    // only the PIN check below can change it
    settingsModal.hidden = true;
    openFlow(want ? 'bio-on' : 'bio-off');
  });
  $('pinPadCancel').addEventListener('click', closeFlows);

  // ---------- Lifecycle ----------
  document.addEventListener('visibilitychange', () => { if (document.hidden) cover(); else evaluate(); });
  try {
    window.Capacitor?.Plugins?.App?.addListener('appStateChange', ({ isActive }) => { if (isActive) evaluate(); else cover(); });
  } catch { /* the visibility events above still cover and re-check */ }

  window.DeltixPinGate = Object.freeze({
    ready,
    isShowing: () => !gate.hidden,
    isRecovering: () => recovering,
    whenOpen,
    onResume: () => evaluate().then(whenOpen),
    hold,
    back,
    cover,
    completeRecovery,
  });

  evaluate();
}());
