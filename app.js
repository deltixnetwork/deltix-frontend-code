'use strict';

// In the native app shell (Capacitor) there is no same-origin backend —
// point at the production API instead.
const API = window.Capacitor ? 'https://app.deltixllc.com/api' : '/api';
const APP_VERSION = '1.5.3';
const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem('dltx_token') || null,
  email: localStorage.getItem('dltx_email') || null,
  refCode: null,
  avatar: localStorage.getItem('dltx_avatar') || '🦊',
  validators: [],
  address: null,
  balances: null,
  energy: null,
  hideBalances: localStorage.getItem('dltx_hide_balances') === '1',
};

// ---------- API helper ----------
// Self-healing session: if the server ever reports the session/wallet as
// gone (stale token, or — in local dev — a server restart that wiped
// in-memory data), sign the user out and return to the sign-in screen
// instead of leaving stale cached numbers on screen.
//
// Mobile networks drop requests and hosts restart, so idempotent reads are
// retried briefly before the user ever sees an error.
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_BACKOFF_MS = 500;

function friendlyError(status, json) {
  if (json && json.error) return json.error;
  if (status === 429) return 'You are going a little fast. Please wait a moment and try again.';
  if (status >= 500) return 'Deltix is busy right now. Please try again in a moment.';
  if (status === 404) return 'That is not available right now.';
  return 'Something went wrong. Please try again.';
}

async function api(method, path, body, { retries = method === 'GET' ? 2 : 0 } = {}) {
  let res = null;
  let offline = false;
  for (let attempt = 0; ; attempt++) {
    offline = false;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Deltix-Client': 'deltix-app',
          'X-App-Version': APP_VERSION,
          ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      offline = true; // DNS failure, dropped connection, airplane mode…
    }
    const transient = offline || RETRY_STATUSES.has(res.status);
    if (!transient || attempt >= retries) break;
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
  }
  if (offline) {
    const err = new Error('No connection. Check your internet and try again.');
    err.offline = true;
    throw err;
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Server-side forced update — lock the UI until the app is updated.
    if (res.status === 426) {
      $('updateGate').hidden = false;
      const err426 = new Error(json.error || 'Update required');
      err426.status = 426;
      throw err426;
    }
    const staleSession = res.status === 401 || (res.status === 404 && /wallet not found/i.test(json.error || ''));
    if (staleSession) {
      // An open arcade game must never survive a dead session — otherwise every
      // retry (Play again, finishing the round) just re-fails with a raw
      // "missing/invalid token" error and the user looks stuck mid-game.
      const gameModal = $('gameModal');
      if (gameModal && !gameModal.hidden && typeof window.closeGame === 'function') window.closeGame();
      const instantModal = $('instantModal');
      if (instantModal && !instantModal.hidden && typeof window.closeInstantGame === 'function') window.closeInstantGame();
      if (state.token) {
        clearAccountSession();
        showScreen('screen-email');
        toast('Your session has expired — please sign in again.');
      }
    }
    const err = new Error(friendlyError(res.status, json));
    err.status = res.status;
    err.data = json;
    throw err;
  }
  return json;
}

// ---------- Play Integrity (native anti-clone attestation) ----------
// Requests a one-time nonce from the backend, asks the Play Integrity API for a
// signed token on-device, and returns it to attach to a gated action. Always a
// safe no-op on the web / when integrity is disabled — the backend decides.
async function getIntegrityPayload() {
  try {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return {};
    const PlayIntegrity = cap.Plugins && cap.Plugins.PlayIntegrity;
    if (!PlayIntegrity) return {};
    const { enabled, nonce, cloudProjectNumber } = await api('POST', '/integrity/nonce');
    if (!enabled || !nonce) return {};
    const { token } = await PlayIntegrity.requestIntegrityToken({
      nonce,
      googleCloudProjectNumber: Number(cloudProjectNumber) || 0,
    });
    return token ? { integrityToken: token, integrityNonce: nonce } : {};
  } catch {
    // Never let attestation problems block the UI — backend enforces policy.
    return {};
  }
}

// ---------- Forced update gate ----------
function versionLt(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return true;
    if ((pa[i] || 0) > (pb[i] || 0)) return false;
  }
  return false;
}
async function checkAppVersion() {
  try {
    const v = await api('GET', '/app/version');
    if (versionLt(APP_VERSION, v.minSupported)) {
      $('updateGate').hidden = false;
      const isNative = window.Capacitor?.isNativePlatform?.();
      $('updateReloadBtn').onclick = () => {
        if (isNative) {
          // Deep-link straight to the Play listing; falls back to the web URL.
          window.open('market://details?id=network.deltix.app', '_system');
          setTimeout(() => window.open(v.updateUrl, '_system'), 400);
        } else {
          location.reload(true);
        }
      };
      return false;
    }
    $('updateGate').hidden = true;
  } catch {
    /* offline or server unreachable — do not lock the user out */
  }
  return true;
}
// Re-check whenever the app returns to the foreground, and auto-refresh active tab data.
// Web and native both signal a resume, so coalesce them into one round of requests.
let lastResumeAt = 0;
function onAppResumed() {
  if (Date.now() - lastResumeAt < 1500) return;
  lastResumeAt = Date.now();
  checkAppVersion();
  if (state.token && $('screen-main')?.classList.contains('active')) {
    refreshCurrentView({ silent: true });
    if (typeof checkMysteryHour === 'function') checkMysteryHour();
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) onAppResumed();
});

// Capacitor native app lifecycle resume
try {
  window.Capacitor?.Plugins?.App?.addListener('appStateChange', ({ isActive }) => {
    if (isActive) onAppResumed();
  });
} catch {}

// ---------- UI helpers ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  const authed = id === 'screen-main';
  $('topbar').hidden = !authed;
  closeSidenav();
  if (!authed) {
    document.body.classList.remove('has-ad-banner');
    const cap = window.Capacitor;
    if (cap?.Plugins?.AdMob) cap.Plugins.AdMob.hideBanner().catch(() => {});
  } else {
    updateTabAd();
  }
}

function showTab(id, { refresh = true } = {}) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  $(id).classList.add('active');
  document.querySelectorAll('.tabbtn, .sidenav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === id)
  );
  updateTabAd(id);
  if (id === 'tab-energy') {
    renderEnergy();
    if (state.token) loadEnergy();
  } else if (id === 'tab-missions') {
    renderMissions();
    if (state.token) loadMissions();
  } else if (refresh && state.token) {
    refreshTabContent(id);
  }
}

function refreshTabContent(id) {
  if (id === 'tab-wallet') {
    Promise.allSettled([loadWallet(), loadTx(), loadStats()]);
  } else if (id === 'tab-stake') {
    Promise.allSettled([loadWallet(), loadStakes(), loadValidators()]);
  } else if (id === 'tab-arcade') {
    if (typeof loadArcade === 'function') loadArcade().catch(() => {});
  } else if (id === 'tab-community') {
    Promise.allSettled([loadGovernance(), loadReferrals(), loadGlobe(), loadLeaderboard(), loadPassport()]);
  } else if (id === 'tab-rewards') {
    loadRewards().catch(() => {});
  } else if (id === 'tab-network') {
    Promise.allSettled([loadChain(), loadStats()]);
  }
}

let isRefreshing = false;
async function refreshCurrentView({ isPull = false, silent = false } = {}) {
  if (isRefreshing || !state.token) return;
  isRefreshing = true;
  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.classList.add('spinning');

  const activeTab = document.querySelector('.tab.active')?.id || 'tab-wallet';
  const tasks = [loadWallet(), loadStats()];

  if (activeTab === 'tab-wallet') {
    tasks.push(loadTx(), loadStakes());
  } else if (activeTab === 'tab-stake') {
    tasks.push(loadStakes(), loadValidators());
  } else if (activeTab === 'tab-community') {
    tasks.push(loadGovernance(), loadReferrals(), loadGlobe(), loadLeaderboard(), loadPassport());
  } else if (activeTab === 'tab-arcade') {
    if (typeof loadArcade === 'function') tasks.push(loadArcade());
  } else if (activeTab === 'tab-network') {
    tasks.push(loadChain());
  } else if (activeTab === 'tab-energy') {
    tasks.push(loadEnergy());
  } else if (activeTab === 'tab-rewards') {
    tasks.push(loadRewards());
  } else if (activeTab === 'tab-missions') {
    tasks.push(loadMissions());
  }

  try {
    await Promise.allSettled(tasks);
    if (!silent && !isPull) toast('Updated');
  } catch {
    /* errors handled in individual loaders */
  } finally {
    isRefreshing = false;
    if (refreshBtn) refreshBtn.classList.remove('spinning');
  }
}

// ---------- Pull / Slide to Refresh (mobile touch + gesture) ----------
function initPullToRefresh() {
  const ptr = $('ptrIndicator');
  const icon = $('ptrIcon');
  const text = $('ptrText');
  if (!ptr || !icon || !text) return;

  let startY = 0;
  let startX = 0;
  let isTracking = false;
  let isPulling = false;
  const PULL_THRESHOLD = 58;
  const MAX_PULL = 84;

  function isEligible() {
    const isMain = $('screen-main')?.classList.contains('active');
    if (!isMain || !state.token || isRefreshing) return false;

    // Must not have any modal/overlay open
    const overlays = ['gameModal', 'instantModal', 'dbrowser', 'explorer', 'dappPage', 'stakeModal', 'sendModal', 'deleteModal', 'swapModal', 'dappModal'];
    for (const id of overlays) {
      const el = $(id);
      if (el && !el.hidden) return false;
    }

    const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    return scrollTop <= 1;
  }

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (!isEligible()) return;
    startY = e.touches[0].screenY;
    startX = e.touches[0].screenX;
    isTracking = true;
    isPulling = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!isTracking || isRefreshing) return;
    if (e.touches.length !== 1) return;

    const touchY = e.touches[0].screenY;
    const touchX = e.touches[0].screenX;
    const deltaY = touchY - startY;
    const deltaX = Math.abs(touchX - startX);

    // Cancel if pulling up or horizontal swipe
    if (deltaY <= 0 || deltaX > deltaY) {
      isTracking = false;
      resetPtr();
      return;
    }

    const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    if (scrollTop > 1) {
      isTracking = false;
      resetPtr();
      return;
    }

    isPulling = true;
    const pullDistance = Math.min(MAX_PULL, deltaY * 0.45);
    ptr.style.height = `${pullDistance}px`;
    ptr.classList.add('pulling');
    ptr.classList.remove('resetting');

    if (pullDistance >= PULL_THRESHOLD) {
      ptr.classList.add('ready');
      icon.textContent = '↑';
      text.textContent = 'Release to refresh';
    } else {
      ptr.classList.remove('ready');
      icon.textContent = '↓';
      text.textContent = 'Slide to refresh';
    }
  }, { passive: true });

  async function handleEnd() {
    if (!isTracking && !isPulling) return;
    const wasPulling = isPulling;
    const isReady = ptr.classList.contains('ready');
    isTracking = false;
    isPulling = false;

    if (wasPulling && isReady && !isRefreshing) {
      ptr.classList.remove('pulling', 'ready');
      ptr.classList.add('refreshing');
      ptr.style.height = '48px';
      icon.textContent = '↻';
      text.textContent = 'Refreshing…';

      try {
        window.Capacitor?.Plugins?.Haptics?.impact?.({ style: 'Light' });
      } catch {}

      await refreshCurrentView({ isPull: true });

      icon.textContent = '✓';
      text.textContent = 'Refreshed';
      setTimeout(resetPtr, 350);
    } else {
      resetPtr();
    }
  }

  function resetPtr() {
    ptr.classList.remove('pulling', 'ready', 'refreshing');
    ptr.classList.add('resetting');
    ptr.style.height = '0px';
    setTimeout(() => {
      ptr.classList.remove('resetting');
      icon.textContent = '↓';
      text.textContent = 'Slide to refresh';
    }, 280);
  }

  document.addEventListener('touchend', handleEnd, { passive: true });
  document.addEventListener('touchcancel', resetPtr, { passive: true });
}

$('refreshBtn')?.addEventListener('click', () => refreshCurrentView());
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
const fmt = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });

// ---------- Reward celebration popup ----------
// A branded, animated confetti popup used for claims and wins instead of a raw
// toast. Falls back to toast() automatically when amount is zero/non-positive.
const CONFETTI_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6'];
let rewardPopTimer;
function celebrate(opts = {}) {
  const {
    amount = 0,
    unit = '$DLTX',
    title = 'Reward Claimed!',
    subtitle = '',
    icon = '💎',
    duration = 4200,
  } = opts;

  // Nothing worth celebrating — keep the plain toast for zero/failed payouts.
  const value = Number(amount) || 0;
  if (value <= 0) {
    if (subtitle || title) toast(subtitle || title);
    return;
  }

  try { window.Capacitor?.Plugins?.Haptics?.notification?.({ type: 'Success' }); } catch {}
  try { navigator.vibrate?.([12, 40, 18]); } catch {}
  try { window.ArcadeSound?.reward?.(); } catch {}

  document.getElementById('rewardPop')?.remove();
  clearTimeout(rewardPopTimer);

  const confetti = Array.from({ length: 26 }, (_, i) => {
    const c = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    const left = Math.round(Math.random() * 100);
    const delay = (Math.random() * 0.35).toFixed(2);
    const dur = (1.1 + Math.random() * 0.9).toFixed(2);
    const rot = Math.round(Math.random() * 360);
    const round = i % 3 === 0 ? 'border-radius:50%;' : '';
    return `<i style="left:${left}%;background:${c};${round}animation-delay:${delay}s;animation-duration:${dur}s;transform:rotate(${rot}deg)"></i>`;
  }).join('');

  const pop = document.createElement('div');
  pop.className = 'reward-pop';
  pop.id = 'rewardPop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-live', 'polite');
  pop.innerHTML = `
    <div class="rp-confetti">${confetti}</div>
    <div class="rp-card" role="document">
      <div class="rp-badge"><span class="rp-icon">${icon}</span></div>
      <div class="rp-title">${title}</div>
      <div class="rp-amount"><span class="rp-plus">+</span><span class="rp-num">0</span> <small>${unit}</small></div>
      <div class="rp-sub"${subtitle ? '' : ' hidden'}>${subtitle}</div>
      <button class="rp-close" type="button">Awesome</button>
    </div>`;
  document.body.appendChild(pop);
  requestAnimationFrame(() => pop.classList.add('show'));

  // Count-up animation on the amount for a rewarding reveal.
  const numEl = pop.querySelector('.rp-num');
  const start = performance.now();
  const runUp = 700;
  (function tick(now) {
    const p = Math.min(1, (now - start) / runUp);
    const eased = 1 - Math.pow(1 - p, 3);
    numEl.textContent = fmt(value * eased);
    if (p < 1) requestAnimationFrame(tick);
    else numEl.textContent = fmt(value);
  })(start);

  const close = () => {
    clearTimeout(rewardPopTimer);
    pop.classList.remove('show');
    pop.classList.add('hide');
    setTimeout(() => pop.remove(), 260);
  };
  pop.querySelector('.rp-close').addEventListener('click', close);
  pop.addEventListener('click', (e) => { if (e.target === pop) close(); });
  rewardPopTimer = setTimeout(close, duration);
}
window.celebrate = celebrate;

// ---------- Auth flow ----------
// Separate Sign in / Sign up paths: sign-up collects the referral code and the
// 18+ / terms acceptance, sign-in only needs the email.
let authMode = 'signin';
function setAuthMode(mode) {
  authMode = mode === 'signup' ? 'signup' : 'signin';
  const isSignup = authMode === 'signup';
  document.querySelectorAll('.auth-switch-btn').forEach((b) => {
    const on = b.dataset.mode === authMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $('signupFields').hidden = !isSignup;
  $('authTitle').textContent = isSignup ? 'Create your account 🚀' : 'Welcome back 👋';
  $('authSub').textContent = isSignup
    ? 'Enter your email — we’ll send a one-time code and create your wallet instantly.'
    : 'Enter the email you signed up with — we’ll send a one-time code.';
  $('sendCodeBtn').textContent = isSignup ? 'Create account →' : 'Sign in →';
  $('authAlt').innerHTML = isSignup
    ? 'Already have an account? <button type="button" class="link-btn" id="authAltBtn">Sign in instead</button>'
    : 'New to Deltix? <button type="button" class="link-btn" id="authAltBtn">Create an account</button>';
  $('authAltBtn').addEventListener('click', () => setAuthMode(isSignup ? 'signin' : 'signup'));
  $('verifyBtn').textContent = isSignup ? 'Verify & create wallet' : 'Verify & sign in';
  $('emailHint').textContent = '';
  updateSendCodeState();
}
function updateSendCodeState() {
  $('sendCodeBtn').disabled = authMode === 'signup' && !$('ageGate').checked;
}
document.querySelectorAll('.auth-switch-btn').forEach((b) =>
  b.addEventListener('click', () => setAuthMode(b.dataset.mode))
);
$('ageGate').addEventListener('change', updateSendCodeState);
setAuthMode('signin');

$('sendCodeBtn').addEventListener('click', async () => {
  const email = $('emailInput').value.trim().toLowerCase();
  const hint = $('emailHint');
  const isSignup = authMode === 'signup';
  hint.className = 'hint';
  if (isSignup && !$('ageGate').checked) {
    hint.textContent = 'You must confirm you are 18+ and accept the Terms to continue.';
    hint.classList.add('error');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    hint.textContent = 'Please enter a valid email.';
    hint.classList.add('error');
    return;
  }
  $('sendCodeBtn').disabled = true;
  try {
    const referralCode = isSignup ? $('refCodeInput').value.trim().toUpperCase() : '';
    const integrityPayload = await getIntegrityPayload();
    const r = await api('POST', '/auth/register', {
      email,
      mode: authMode,
      ...(referralCode ? { referralCode } : {}),
      ...integrityPayload,
    });
    state.email = email;
    $('otpSubtitle').textContent = `We sent a code to ${email}`;
    const dev = $('devBanner');
    if (r.devCode) {
      dev.hidden = false;
      dev.textContent = `DEV mode — your code is ${r.devCode}`;
      $('codeInput').value = r.devCode;
    } else {
      dev.hidden = true;
    }
    showScreen('screen-otp');
  } catch (e) {
    // Guide the user straight to the right tab instead of a dead end.
    if (e.data?.code === 'ACCOUNT_NOT_FOUND') setAuthMode('signup');
    else if (e.data?.code === 'ACCOUNT_EXISTS') setAuthMode('signin');
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    updateSendCodeState();
  }
});

$('backToEmail').addEventListener('click', () => showScreen('screen-email'));

/** Blanks every account-scoped value in memory and on screen.
 *  Without this the next account inherits the previous one's rendered
 *  balances, address, history and referral code until its own loads land. */
function resetAccountUI() {
  state.refCode = null;
  state.address = null;
  state.balances = null;
  state.energy = null;

  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  const setHtml = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
  $('totalBalance').innerHTML = '0.00 <small>$DLTX</small>';
  ['liquidBalance', 'stakedBalance', 'pendingRewards'].forEach((id) => setText(id, '0'));
  setText('walletAddressTxt', '0x…');
  setText('profileEmail', '—');
  setText('profileRef', 'Ref —');
  setText('myRefCode', '—');
  setText('refInfo', '');
  setHtml('refSlots', '');
  setHtml('refList', '');
  setHtml('txList', '<p class="muted center">No activity yet.</p>');
  setHtml('myStakes', '<p class="muted center">You have no active stakes.</p>');
  setHtml('statsGrid', '');
  setHtml('arcadeMeta', '');
  renderEnergy();
  if (typeof resetRewardsUI === 'function') resetRewardsUI();
  if (typeof resetCommunityUI === 'function') resetCommunityUI();
  if (typeof resetMissionsUI === 'function') resetMissionsUI();
  if (typeof resetVaultUI === 'function') resetVaultUI();
}

/** Full sign-out: drops the session as well as the rendered account data. */
function clearAccountSession() {
  state.token = null;
  state.email = null;
  localStorage.removeItem('dltx_token');
  localStorage.removeItem('dltx_email');
  // Shared devices must not keep the previous person's email/code on the form.
  ['emailInput', 'codeInput', 'refCodeInput'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
  const ageGate = $('ageGate');
  if (ageGate) ageGate.checked = false;
  const devBanner = $('devBanner');
  if (devBanner) devBanner.hidden = true;
  resetAccountUI();
}

$('verifyBtn').addEventListener('click', async () => {
  const code = $('codeInput').value.trim();
  const hint = $('otpHint');
  hint.className = 'hint';
  if (!/^\d{6}$/.test(code)) {
    hint.textContent = 'Enter the 6-digit code.';
    hint.classList.add('error');
    return;
  }
  $('verifyBtn').disabled = true;
  try {
    const r = await api('POST', '/auth/verify', { email: state.email, code });
    state.token = r.token;
    localStorage.setItem('dltx_token', r.token);
    if (r.user && r.user.email) state.email = r.user.email;
    if (state.email) localStorage.setItem('dltx_email', state.email);
    toast(r.message || 'Welcome!');
    await enterApp();
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('verifyBtn').disabled = false;
  }
});

$('logoutBtn').addEventListener('click', () => {
  clearAccountSession();
  showScreen('screen-email');
  setAuthMode('signin');
});

// ---------- Account deletion (required by Apple 5.1.1(v) / Play policy) ----------
$('deleteAccountBtn').addEventListener('click', () => {
  $('deleteConfirmInput').value = '';
  $('deleteHint').className = 'hint';
  $('deleteHint').textContent = '';
  $('deleteModal').hidden = false;
});
$('cancelDelete').addEventListener('click', () => ($('deleteModal').hidden = true));
$('confirmDelete').addEventListener('click', async () => {
  const hint = $('deleteHint');
  hint.className = 'hint';
  if ($('deleteConfirmInput').value.trim() !== 'DELETE') {
    hint.textContent = 'Type DELETE (in capitals) to confirm.';
    hint.classList.add('error');
    return;
  }
  $('confirmDelete').disabled = true;
  try {
    await api('DELETE', '/auth/account');
    $('deleteModal').hidden = true;
    clearAccountSession();
    showScreen('screen-email');
    setAuthMode('signup');
    toast('Account permanently deleted');
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('confirmDelete').disabled = false;
  }
});

// ---------- Tabs / side navigation ----------
// The tabs live in a slide-out sidebar (☰). Opening it shows a backdrop;
// tapping a tab, the backdrop, the ✕, Escape, or swiping left closes it.
function openSidenav() {
  const nav = $('sidenav'); const bd = $('sidenavBackdrop');
  if (!nav || !bd) return;
  bd.hidden = false;
  requestAnimationFrame(() => { nav.classList.add('open'); bd.classList.add('show'); });
  nav.setAttribute('aria-hidden', 'false');
  document.body.classList.add('nav-open');
}
function closeSidenav() {
  const nav = $('sidenav'); const bd = $('sidenavBackdrop');
  if (!nav || !bd) return;
  nav.classList.remove('open');
  bd.classList.remove('show');
  nav.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('nav-open');
  // Hide the backdrop after the fade-out so it can't block taps.
  setTimeout(() => { if (!nav.classList.contains('open')) bd.hidden = true; }, 260);
}
function toggleSidenav() {
  $('sidenav')?.classList.contains('open') ? closeSidenav() : openSidenav();
}

$('menuBtn')?.addEventListener('click', toggleSidenav);
$('sidenavClose')?.addEventListener('click', closeSidenav);
$('sidenavBackdrop')?.addEventListener('click', closeSidenav);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidenav(); });

document.querySelectorAll('.sidenav-item').forEach((b) =>
  b.addEventListener('click', () => { showTab(b.dataset.tab); closeSidenav(); })
);

// Swipe-left on the open drawer to dismiss it.
(() => {
  const nav = $('sidenav');
  if (!nav) return;
  let x0 = null;
  nav.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  nav.addEventListener('touchmove', (e) => {
    if (x0 === null) return;
    if (x0 - e.touches[0].clientX > 55) { closeSidenav(); x0 = null; }
  }, { passive: true });
  nav.addEventListener('touchend', () => { x0 = null; });
})();

// ---------- Data loading ----------
async function enterApp() {
  // Never let the previous account's numbers survive into this session.
  resetAccountUI();
  showScreen('screen-main');
  showTab('tab-wallet', { refresh: false });
  // Recover the email from the JWT for sessions that signed in before we
  // started persisting it (so the profile never shows a blank email).
  if (!state.email && state.token) {
    state.email = emailFromToken(state.token);
    if (state.email) localStorage.setItem('dltx_email', state.email);
  }
  renderProfile();
  // One-request startup: /bootstrap returns wallet + stats + tx + referrals +
  // energy in a single round-trip. Each loader falls back to its own request
  // for any missing part (and on older backends without /bootstrap), so this is
  // both faster and backward-compatible.
  const boot = await api('GET', '/bootstrap').catch(() => null);
  await Promise.allSettled([
    loadWallet(boot?.wallet),
    loadStats(boot?.stats),
    loadTx(boot?.transactions),
    loadReferrals(boot?.referrals),
    loadEnergy(boot?.energy),
  ]);
  if (typeof checkMysteryHour === 'function') checkMysteryHour();
}

/** Extracts the email claim from the JWT payload (no verification needed). */
function emailFromToken(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(part));
    return payload.email || null;
  } catch {
    return null;
  }
}

// ---------- Profile (avatar + masked email + referral) ----------
const AVATAR_CHOICES = [
  '🦊','🐼','🐯','🦁','🐸','🐵','🐨','🐧','🦉','🐙','🐝','🦄','🐳','🦖','🐺','🐻','🐰','🐷',
  '🐮','🐔','🦩','🦋','🐢','🦈','🐬','🦓','🦍','🐹','🦔','🐴','🦌','🦚',
  '👾','🤖','👽','🎮','🕹️','🎲','🎯','🎨','🎧','🎸','🚀','🛰️','⚽','🏀','🏆','🥇',
  '⚡','🔥','🌟','💎','🌈','🌙','☀️','🍀','🌸','🍕','🍩','🧊','🪐','🔮','🎃','🦴',
];
// Premium avatars: unlocked via an opt-in rewarded ad. The unlock is a
// non-transferable cosmetic owned by the account — the AdMob-compliant reward.
// unlockedAvatars() / unlockedThemes() read that account state (see loadEnergy).
const PREMIUM_AVATARS = ['🐉','🦅','🧙','🥷','👑','🛸','🦸','🧛','🧜','🧚','🤴','👸','🦹','🧞','🐲','⚔️','🗿','💫'];

// App themes: "classic" and the community-requested dark "midnight" are free.
// The colour packs use the same AdMob-compliant model — an opt-in rewarded ad
// unlocks a non-transferable cosmetic theme (never $DLTX). Ownership is stored
// on the account (see loadEnergy); only the current selection is per-device.
const THEMES = [
  { id: 'classic',  name: 'Classic',  free: true },
  { id: 'midnight', name: 'Midnight', free: true, dark: true },
  { id: 'emerald',  name: 'Emerald',  free: false },
  { id: 'sunset',   name: 'Sunset',   free: false },
  { id: 'royal',    name: 'Royal',    free: false },
  { id: 'ocean',    name: 'Ocean',    free: false },
  { id: 'rose',     name: 'Rose',     free: false },
  { id: 'mint',     name: 'Mint',     free: false },
  { id: 'amber',    name: 'Amber',    free: false },
  { id: 'carbon',   name: 'Carbon',   free: false, dark: true },
  { id: 'cyber',    name: 'Cyber',    free: false, dark: true },
  { id: 'aurora',   name: 'Aurora',   free: false, dark: true },
];
function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  if (t.id === 'classic') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t.id;
  if (t.dark) document.documentElement.dataset.dark = 'on';
  else delete document.documentElement.dataset.dark;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.dark ? '#0b1120' : '#ffffff');
}
applyTheme(localStorage.getItem('dltx_theme') || 'classic');

function renderThemeGrid() {
  const grid = $('themeGrid');
  if (!grid) return;
  const unlocked = unlockedThemes();
  const current = localStorage.getItem('dltx_theme') || 'classic';
  grid.innerHTML = THEMES.filter((t) => t.free || ADS_ENABLED || unlocked.includes(t.id)).map((t) => {
    const locked = !t.free && !unlocked.includes(t.id);
    return `<button class="theme-opt ${t.id === current ? 'active' : ''} ${locked ? 'locked' : ''}" data-theme-id="${t.id}"><span class="sw sw-${t.id}"></span>${t.name}</button>`;
  }).join('');
  grid.querySelectorAll('.theme-opt').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.themeId;
      if (b.classList.contains('locked')) {
        // Clear opt-in disclosure before the rewarded ad (AdMob requirement).
        if (!window.confirm('▶ Watch a short ad to unlock this theme?')) return;
        b.disabled = true;
        const earned = await playRewardedAd();
        if (!earned) {
          b.disabled = false;
          toast('Ad not completed — theme stays locked.');
          return;
        }
        if (!(await unlockCosmetic('theme', id))) {
          b.disabled = false;
          return;
        }
        toast('Theme unlocked 🎉');
      }
      localStorage.setItem('dltx_theme', id);
      applyTheme(id);
      renderThemeGrid();
    })
  );
}

/** Masks an email to its first 2 letters + domain, e.g. de****@gmail.com */
function maskEmail(email) {
  if (!email || !email.includes('@')) return '—';
  const [name, domain] = email.split('@');
  const head = name.slice(0, 2);
  return `${head}****@${domain}`;
}

function renderProfile() {
  const av = $('avatarBtn');
  if (av) av.textContent = state.avatar;
  const em = $('profileEmail');
  if (em) em.textContent = maskEmail(state.email);
  const ref = $('profileRef');
  if (ref) ref.textContent = state.refCode ? `Ref ${state.refCode}` : 'Ref —';
}

function openAvatarPicker() {
  const grid = $('avatarGrid');
  const unlocked = unlockedAvatars();
  const all = [
    ...AVATAR_CHOICES.map((e) => ({ e, locked: false })),
    // Ad-free builds hide still-locked premiums (no way to unlock them).
    ...PREMIUM_AVATARS.filter((e) => ADS_ENABLED || unlocked.includes(e))
      .map((e) => ({ e, locked: !unlocked.includes(e) })),
  ];
  grid.innerHTML = all
    .map(({ e, locked }) => `<button class="avatar-opt ${e === state.avatar ? 'active' : ''} ${locked ? 'locked' : ''}" data-emoji="${e}">${e}</button>`)
    .join('');
  grid.querySelectorAll('.avatar-opt').forEach((b) =>
    b.addEventListener('click', async () => {
      const emoji = b.dataset.emoji;
      if (b.classList.contains('locked')) {
        // Clear opt-in disclosure before the rewarded ad (AdMob requirement).
        if (!window.confirm('▶ Watch a short ad to unlock this premium avatar?')) return;
        b.disabled = true;
        const earned = await playRewardedAd();
        if (!earned) {
          b.disabled = false;
          toast('Ad not completed — avatar stays locked.');
          return;
        }
        if (!(await unlockCosmetic('avatar', emoji))) {
          b.disabled = false;
          return;
        }
        toast('Premium avatar unlocked 🎉');
      }
      state.avatar = emoji;
      localStorage.setItem('dltx_avatar', state.avatar);
      renderProfile();
      openAvatarPicker(); // re-render lock/active states
    })
  );
  renderThemeGrid();
  $('avatarModal').hidden = false;
}
$('avatarBtn').addEventListener('click', openAvatarPicker);
$('avatarClose').addEventListener('click', () => ($('avatarModal').hidden = true));
$('profileRef').addEventListener('click', () => {
  if (!state.refCode) return;
  navigator.clipboard?.writeText(state.refCode);
  toast('Referral code copied');
});

function getValidatorShield(name, index = 0) {
  const n = String(name || '').toLowerCase();
  if (n.includes('nova')) return 'assets/shield-blue.svg';
  if (n.includes('helios')) return 'assets/shield-orange.svg';
  if (n.includes('genesis')) return 'assets/shield-purple.svg';
  if (n.includes('aurora') || n.includes('guardian')) return 'assets/shield-green.svg';
  const colors = ['assets/shield-blue.svg', 'assets/shield-green.svg', 'assets/shield-orange.svg', 'assets/shield-purple.svg', 'assets/shield-red.svg'];
  return colors[index % colors.length];
}

async function loadWallet(prefetched) {
  try {
    const w = prefetched || await api('GET', '/wallet');
    state.address = w.address;
    state.balances = w;
    renderBalances();
    const addr = $('walletAddress');
    if (addr) {
      addr.onclick = () => {
        navigator.clipboard?.writeText(state.address);
        toast('Address copied');
      };
    }
  } catch (e) {
    console.warn('loadWallet:', e.message);
  }
}

// ---------- Privacy: hide / unhide address + balances ----------
const MASK = '••••••';
const shortAddr = (a) => (a && a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a || '');
function renderBalances() {
  const w = state.balances;
  if (!w) return;
  const hide = state.hideBalances;
  $('totalBalance').innerHTML = hide ? `${MASK} <small>$DLTX</small>` : `${fmt(w.totalValue)} <small>$DLTX</small>`;
  $('liquidBalance').textContent = hide ? MASK : fmt(w.balance);
  $('stakedBalance').textContent = hide ? MASK : fmt(w.stakedBalance);
  $('pendingRewards').textContent = hide ? MASK : fmt(w.pendingRewards);
  const addrTxt = $('walletAddressTxt');
  if (addrTxt) {
    addrTxt.textContent = hide
      ? `0x${'•'.repeat(6)}…${'•'.repeat(4)}`
      : shortAddr(w.address);
  }
  const eye = $('privacyToggle');
  if (eye) {
    eye.textContent = hide ? '🙈' : '👁';
    eye.title = hide ? 'Show address and balances' : 'Hide address and balances';
  }
}
$('privacyToggle')?.addEventListener('click', (e) => {
  e.stopPropagation(); // do not trigger the copy-address handler
  state.hideBalances = !state.hideBalances;
  localStorage.setItem('dltx_hide_balances', state.hideBalances ? '1' : '0');
  renderBalances();
  toast(state.hideBalances ? 'Balances hidden' : 'Balances visible');
});

async function loadStats(prefetched) {
  try {
    const s = prefetched || await api('GET', '/network/stats');
    const g = $('statsGrid');
    const items = [
      ['Consensus', 'DPoS'],
      ['Validators', s.network.validators],
      ['Participants', s.network.users],
      ['Total staked', fmt(s.network.totalStaked)],
      ['Total supply', fmt(s.tokenomics.totalSupply)],
      ['Base APY (est.)', (s.tokenomics.baseStakingApy * 100).toFixed(1) + '%'],
    ];
    g.innerHTML = items
      .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join('');

    // Network tab — supply dashboard (C = S − L)
    const t = s.tokenomics;
    const rows = [
      ['Total supply (S)', fmt(t.totalSupply) + ' $DLTX'],
      ['Burned (B)', fmt(t.totalBurned) + ' $DLTX'],
      ['Staked / locked (L)', fmt(t.lockedInStaking) + ' $DLTX'],
      ['Circulating (C = S − L)', fmt(t.circulatingSupply) + ' $DLTX'],
      ['Annual issuance rate', (t.annualInflationRate * 100).toFixed(1) + '%'],
      ['Base staking APY (est.)', (t.baseStakingApy * 100).toFixed(1) + '%'],
      ['Staking ratio', t.totalSupply ? ((t.lockedInStaking / t.totalSupply) * 100).toFixed(2) + '%' : '0%'],
    ];
    $('supplyList').innerHTML = rows
      .map(([k, v]) => `<div class="supply-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join('');
  } catch (e) {
    /* public endpoint; ignore */
  }
}

async function loadValidators() {
  try {
    const r = await api('GET', '/network/validators');
    state.validators = r.validators || [];
    const list = $('validatorList');
    if (!list) return;
    list.innerHTML = state.validators
      .map((v, i) => {
        const apy = (0.08 * (1 - v.commission) * 100).toFixed(1);
        const shield = getValidatorShield(v.name, i);
        return `
        <div class="validator-card-3d">
          <div class="val-left">
            <img src="${shield}" class="val-3d-shield" alt="Shield"/>
            <div class="val-info">
              <div class="val-title-row">
                <span class="val-name ${v.name.toLowerCase().includes('genesis') ? 'genesis-txt' : ''}">${v.name}</span>
                <span class="timer-badge">● ${v.uptime}% uptime</span>
              </div>
              <div class="meta">Commission ${(v.commission * 100).toFixed(0)}% · Staked ${fmt(v.total_staked)} $DLTX</div>
            </div>
          </div>
          <div class="val-actions-col">
            <span class="apy-badge-red">~${apy}% APY</span>
            <button class="delegate-btn-red" data-validator="${v.id}" data-name="${v.name}">Delegate</button>
          </div>
        </div>`;
      })
      .join('');
    list.querySelectorAll('[data-validator]').forEach((btn) =>
      btn.addEventListener('click', () => openStakeModal(btn.dataset.validator, btn.dataset.name))
    );
  } catch (e) {
    /* non-critical; ignore */
  }
}

async function loadStakes() {
  try {
    const r = await api('GET', '/staking');
    const el = $('myStakes');
    if (!el) return;
    const active = (r.stakes || []).filter((s) => s.status === 'active');
    if (!active.length) {
      el.innerHTML = '<p class="muted center">You have no active stakes.</p>';
      return;
    }
    el.innerHTML = active
      .map(
        (s, i) => {
          const shield = getValidatorShield(s.validator, i);
          return `
      <div class="stake-card-3d">
        <div class="stake-card-top">
          <img src="${shield}" class="stake-3d-shield" alt="Shield"/>
          <div class="stake-info">
            <div class="stake-title-row">
              <span class="stake-val-name">${s.validator}</span>
              <span class="timer-badge">${s.startedAt ? 'Since ' + new Date(s.startedAt).toLocaleDateString() : 'Active'}</span>
            </div>
            <div class="meta">${fmt(s.amount)} $DLTX · ${(s.apy * 100).toFixed(1)}% APY · x${s.multiplier.toFixed(2)}</div>
            <div class="stake-rewards-txt">Rewards: ${fmt(s.pendingRewards)} $DLTX</div>
          </div>
          <img src="assets/chips-stack.svg" class="stake-3d-chips" alt="Chips"/>
        </div>
        <div class="stake-actions-row">
          <button class="stake-action-btn ghost" data-claim="${s.id}">Claim</button>
          <button class="stake-action-btn primary" data-unstake="${s.id}">Unstake</button>
        </div>
      </div>`;
        }
      )
      .join('');
    el.querySelectorAll('[data-claim]').forEach((b) =>
      b.addEventListener('click', () => claim(b.dataset.claim))
    );
    el.querySelectorAll('[data-unstake]').forEach((b) =>
      b.addEventListener('click', () => unstake(b.dataset.unstake))
    );
  } catch (e) {
    /* non-critical; ignore */
  }
}

async function loadTx(prefetched) {
  try {
    const r = prefetched || await api('GET', '/wallet/transactions');
    state.txs = r.transactions || [];
    const el = $('txList');
    if (!el) return;
    if (!state.txs.length) {
      el.innerHTML = '<p class="muted center">No activity yet.</p>';
      return;
    }
    const negatives = ['stake', 'send', 'treasury_burn', 'paid_spin_wager'];
    el.innerHTML = state.txs
      .map((t, i) => {
        const neg = negatives.includes(t.type);
        const cls = neg ? 'minus' : 'plus';
        const sign = neg ? '−' : '+';
        const date = new Date(t.created_at).toLocaleString();
        return `
        <div class="tx clickable" data-txi="${i}" title="Inspect transaction">
          <div><div class="type">${t.type.replace(/_/g, ' ')}</div><div class="date">${date}</div></div>
          <div class="amt ${cls}">${sign}${fmt(t.amount)}</div>
        </div>`;
      })
      .join('');
    el.querySelectorAll('[data-txi]').forEach((row) =>
      row.addEventListener('click', () => openExplorer({ v: 'wtx', tx: state.txs[Number(row.dataset.txi)] }))
    );
  } catch (e) {
    /* non-critical; ignore */
  }
}

// ---------- Referrals + Ambassador program ----------
async function loadReferrals(prefetched) {
  try {
    const r = prefetched || await api('GET', '/referrals');

    // Referral code + copy
    const codeEl = $('myRefCode');
    codeEl.textContent = r.code;
    codeEl.onclick = () => {
      navigator.clipboard?.writeText(r.code);
      toast('Referral code copied');
    };
    state.refCode = r.code;
    renderProfile();

    // referral slots (unlimited or capped)
    if (r.unlimited) {
      $('refSlots').innerHTML = `<div class="slot used">✓</div><div class="slot-count">${r.slotsUsed} joined · unlimited invites</div>`;
      $('refInfo').textContent =
        `Unlimited invites · +${fmt(r.rewardPerActivation)} $DLTX when a referral keeps a stake of ${fmt(r.minStakeToActivate)}+ $DLTX · Earned so far: ${fmt(r.totalReferralRewards)} $DLTX`;
    } else {
      $('refSlots').innerHTML = Array.from({ length: r.maxDirect }, (_, i) =>
        `<div class="slot ${i < r.slotsUsed ? 'used' : ''}">${i < r.slotsUsed ? '✓' : i + 1}</div>`
      ).join('');
      $('refInfo').textContent =
        `${r.slotsLeft} of ${r.maxDirect} invites left · +${fmt(r.rewardPerActivation)} $DLTX when a referral keeps a stake of ${fmt(r.minStakeToActivate)}+ $DLTX · Earned so far: ${fmt(r.totalReferralRewards)} $DLTX`;
    }

    // Referral list
    const list = $('refList');
    if (!r.referrals.length) {
      list.innerHTML = '<p class="muted center">No referrals yet. Share your code and invite genuine participants.</p>';
    } else {
      list.innerHTML = r.referrals
        .map((x) => {
          const pill = x.status === 'activated' ? 'activated' : /awaiting/.test(x.status) ? 'waiting' : 'pending';
          return `
          <div class="ref-item">
            <div><div class="who">${x.email}</div><div class="status">Joined ${new Date(x.joinedAt).toLocaleDateString()}</div></div>
            <span class="status-pill ${pill}">${x.status}</span>
          </div>`;
        })
        .join('');
    }

    // Redeem box only if not yet sponsored
    $('redeemBox').hidden = r.referredBy;

    // Ambassador card
    const a = r.ambassador;
    $('tierBadge').textContent = a.tier;
    $('tierMeta').textContent =
      a.tier === 'Ambassador'
        ? 'You are a Deltix Ambassador. Thank you for growing the network responsibly.'
        : `Next tier: ${a.level === 0 ? 'Advocate — 1 activated referral + any active stake.' : `Ambassador — ${a.requirements.ambassador.activeReferrals} activated referrals + ${fmt(a.requirements.ambassador.ownStake)} $DLTX staked.`}`;
    const refGoal = a.level === 0 ? a.requirements.advocate.activeReferrals : a.requirements.ambassador.activeReferrals;
    const stakeGoal = a.requirements.ambassador.ownStake;
    $('tierProgress').innerHTML = `
      <div class="progress-row"><span>Activated referrals ${a.activeReferrals}/${refGoal}</span>
        <div class="bar"><i style="width:${Math.min(100, (a.activeReferrals / refGoal) * 100)}%"></i></div></div>
      <div class="progress-row"><span>Own stake ${fmt(a.ownStaked)}/${fmt(stakeGoal)}</span>
        <div class="bar"><i style="width:${Math.min(100, (a.ownStaked / stakeGoal) * 100)}%"></i></div></div>`;
  } catch (e) {
    /* non-critical tab; ignore */
  }
}

$('redeemBtn').addEventListener('click', async () => {
  const code = $('redeemInput').value.trim().toUpperCase();
  const hint = $('redeemHint');
  hint.className = 'hint';
  if (!code) {
    hint.textContent = 'Enter a referral code.';
    hint.classList.add('error');
    return;
  }
  $('redeemBtn').disabled = true;
  try {
    const r = await api('POST', '/referrals/redeem', { code });
    hint.textContent = r.message;
    hint.classList.add('ok');
    toast('Sponsor linked');
    await loadReferrals();
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('redeemBtn').disabled = false;
  }
});

// ---------- Deltix DAO (live governance) ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function loadGovernance() {
  try {
    const g = await api('GET', '/governance');
    const paused = !!g.dao.votingPaused;
    const pill = $('daoPill');
    if (pill) {
      pill.textContent = paused ? 'Paused' : 'Live';
      pill.classList.toggle('paused', paused);
    }
    const proposeSection = $('proposeSection');
    if (proposeSection) proposeSection.hidden = paused;

    if (paused) {
      $('daoMeta').textContent =
        'DAO voting is temporarily closed by the protocol steward while governance is being upgraded. ' +
        'All tallies are reset to zero and will reopen with the next governance cycle. ' +
        'Your staked $DLTX still counts — 1 staked $DLTX = 1 vote when voting resumes.';
    } else {
      $('daoMeta').textContent =
        `The DAO decides protocol changes by stake-weighted vote — 1 staked $DLTX = 1 vote. ` +
        `Your voting power: ${fmt(g.votingPower)} $DLTX. ` +
        `Proposing requires ${fmt(g.dao.minStakeToPropose)}+ $DLTX staked · voting period ${g.dao.votingPeriodDays} days · quorum ${fmt(g.dao.quorumVotes)} voted stake.`;
    }

    const list = $('daoList');
    if (!g.proposals.length) {
      list.innerHTML = paused
        ? '<p class="muted center">Voting is closed — proposals will appear here when the DAO reopens.</p>'
        : '<p class="muted center">No proposals yet — submit the first one below.</p>';
      return;
    }
    list.innerHTML = g.proposals
      .map((p) => {
        const total = p.totalWeight || 0;
        const forPct = total ? (p.forWeight / total) * 100 : 0;
        const againstPct = total ? (p.againstWeight / total) * 100 : 0;
        const ends = new Date(p.endsAt);
        const active = p.status === 'active';
        const statusPill = active
          ? '<span class="status-pill voting">voting open</span>'
          : `<span class="status-pill ${p.status}">${p.status}</span>`;
        const timeInfo = active
          ? `Voting ends ${ends.toLocaleDateString()} ${ends.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : `Ended ${ends.toLocaleDateString()}`;
        const voteUi = p.yourVote
          ? `<div class="p-meta">You voted <b>${p.yourVote.choice}</b> with ${fmt(p.yourVote.weight)} $DLTX.</div>`
          : active
            ? `<div class="vote-actions">
                 <button class="mini-btn" data-vote-for="${p.id}">Vote FOR</button>
                 <button class="mini-btn against" data-vote-against="${p.id}">Vote AGAINST</button>
               </div>`
            : '';
        return `
        <div class="proposal">
          <div class="p-head"><div class="p-title">${escapeHtml(p.title)}</div>${statusPill}</div>
          <div class="p-desc">${escapeHtml(p.description)}</div>
          <div class="votebar"><i class="for" style="width:${forPct}%"></i><i class="against" style="width:${againstPct}%"></i></div>
          <div class="p-meta">FOR ${fmt(p.forWeight)} · AGAINST ${fmt(p.againstWeight)} · ${p.voters} voter${p.voters === 1 ? '' : 's'} · quorum ${fmt(p.quorum)}</div>
          <div class="p-meta">By ${p.author} · ${timeInfo}</div>
          ${voteUi}
        </div>`;
      })
      .join('');

    list.querySelectorAll('[data-vote-for]').forEach((b) =>
      b.addEventListener('click', () => castVote(b.dataset.voteFor, 'for'))
    );
    list.querySelectorAll('[data-vote-against]').forEach((b) =>
      b.addEventListener('click', () => castVote(b.dataset.voteAgainst, 'against'))
    );
  } catch (e) {
    /* non-critical tab; ignore */
  }
}

async function castVote(proposalId, choice) {
  try {
    const r = await api('POST', `/governance/proposals/${proposalId}/vote`, { choice });
    toast(r.message);
    await loadGovernance();
  } catch (e) {
    toast(e.message);
  }
}

$('proposeBtn').addEventListener('click', async () => {
  const title = $('propTitle').value.trim();
  const description = $('propDesc').value.trim();
  const hint = $('propHint');
  hint.className = 'hint';
  if (title.length < 8) {
    hint.textContent = 'Title must be at least 8 characters.';
    hint.classList.add('error');
    return;
  }
  if (description.length < 20) {
    hint.textContent = 'Describe the change in at least 20 characters.';
    hint.classList.add('error');
    return;
  }
  $('proposeBtn').disabled = true;
  try {
    const r = await api('POST', '/governance/proposals', { title, description });
    hint.textContent = r.message;
    hint.classList.add('ok');
    $('propTitle').value = '';
    $('propDesc').value = '';
    toast('Proposal submitted — voting is open');
    await loadGovernance();
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('proposeBtn').disabled = false;
  }
});

// ---------- Deltix Chain (live blocks) ----------
async function loadChain() {
  try {
    const [info, blocks, integrity] = await Promise.all([
      api('GET', '/chain/info'),
      api('GET', '/chain/blocks?limit=6'),
      api('GET', '/chain/verify').catch(() => null),
    ]);
    const integrityRow = integrity
      ? ['Integrity', integrity.valid ? '✓ verified (' + integrity.blocks + ' blocks)' : '⚠ ' + (integrity.error || 'check failed')]
      : null;
    $('chainInfo').innerHTML = [
      ['Chain', info.chainId],
      ['Height', '#' + info.height],
      ['Latest hash', info.latestHash.slice(0, 18) + '…'],
      ['Block time', info.blockTimeMs / 1000 + 's'],
      ['Total txs on chain', info.totalTxs],
      ['Pending txs', info.pendingTxs],
      ...(integrityRow ? [integrityRow] : []),
    ]
      .map(([k, v]) => `<div class="supply-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join('');
    $('blockList').innerHTML = blocks.blocks
      .map(
        (b) => `
      <div class="block-card clickable" data-height="${b.height}" title="Open block">
        <div>
          <div class="name">Block #${b.height} <span class="hash">${b.hash.slice(0, 14)}…</span></div>
          <div class="meta">${b.txCount} tx · by ${b.validator} · ${new Date(b.timestamp).toLocaleTimeString()}</div>
        </div>
        <span class="status-pill activated">sealed</span>
      </div>`
      )
      .join('');
    $('blockList').querySelectorAll('[data-height]').forEach((card) =>
      card.addEventListener('click', () => openExplorer({ v: 'block', height: Number(card.dataset.height) }))
    );
  } catch (e) {
    /* non-critical; ignore */
  }
}
setInterval(() => {
  if (state.token && document.getElementById('tab-network').classList.contains('active')) loadChain();
}, 15000);

// ---------- P2P send ----------
const BASE_FEE_RATE = 0.001;
const MIN_BASE_FEE = 0.01;

function updateSendPreview() {
  const amount = Number($('sendAmount').value);
  const el = $('sendPreview');
  if (!Number.isFinite(amount) || amount <= 0) {
    el.innerHTML = '';
    return;
  }
  const fee = Math.max(MIN_BASE_FEE, amount * BASE_FEE_RATE);
  el.innerHTML = [
    ['Amount', fmt(amount) + ' $DLTX'],
    ['Base fee (burned)', fmt(fee) + ' $DLTX'],
    ['Total debit', fmt(amount + fee) + ' $DLTX'],
  ]
    .map(([k, v]) => `<div class="supply-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join('');
}

$('sendBtn').addEventListener('click', () => {
  $('sendTo').value = '';
  $('sendAmount').value = '';
  $('sendPreview').innerHTML = '';
  $('sendHint').className = 'hint';
  const s = state.balances || {};
  const sendable = s.sendableBalance != null ? s.sendableBalance : s.balance;
  $('sendHint').textContent = `Transferable: ${fmt(sendable)} $DLTX`
    + (s.bonusLocked > 0 ? ` · ${fmt(s.bonusLocked)} welcome bonus locked (stake/use only)` : '');
  $('sendModal').hidden = false;
});
$('receiveBtn').addEventListener('click', () => {
  if (!state.address) return;
  navigator.clipboard?.writeText(state.address);
  toast('Your address was copied — share it to receive $DLTX');
});
$('cancelSend').addEventListener('click', () => ($('sendModal').hidden = true));
$('sendAmount').addEventListener('input', updateSendPreview);
$('confirmSend').addEventListener('click', async () => {
  const toAddress = $('sendTo').value.trim();
  const amount = Number($('sendAmount').value);
  const hint = $('sendHint');
  hint.className = 'hint';
  if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
    hint.textContent = 'Enter a valid 0x address.';
    hint.classList.add('error');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    hint.textContent = 'Enter a positive amount.';
    hint.classList.add('error');
    return;
  }
  $('confirmSend').disabled = true;
  try {
    const r = await api('POST', '/wallet/send', { toAddress, amount });
    $('sendModal').hidden = true;
    toast(`Sent ${fmt(r.amount)} $DLTX · ${fmt(r.feeBurned)} burned`);
    await Promise.all([loadWallet(), loadTx(), loadStats()]);
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('confirmSend').disabled = false;
  }
});

// ---------- Stake modal ----------
let pendingValidator = null;
function openStakeModal(id, name) {
  pendingValidator = id;
  $('stakeModalTitle').textContent = `Delegate to ${name}`;
  const v = state.validators.find((x) => String(x.id) === String(id));
  if (v) {
    const apy = (0.08 * (1 - v.commission) * 100).toFixed(1);
    const terms = [
      ['Validator commission', (v.commission * 100).toFixed(0) + '%'],
      ['Reported uptime', v.uptime + '%'],
      ['Estimated APY (variable)', '~' + apy + '%'],
      ['Unstake burn fee', '1% of principal'],
    ];
    $('stakeModalTerms').innerHTML = terms
      .map(([k, val]) => `<div class="supply-row"><span class="k">${k}</span><span class="v">${val}</span></div>`)
      .join('');
  } else {
    $('stakeModalTerms').innerHTML = '';
  }
  $('stakeAmount').value = '';
  $('stakeModalHint').textContent = '';
  $('stakeModal').hidden = false;
}
$('cancelStake').addEventListener('click', () => ($('stakeModal').hidden = true));
$('confirmStake').addEventListener('click', async () => {
  const amount = Number($('stakeAmount').value);
  const hint = $('stakeModalHint');
  hint.className = 'hint';
  if (!Number.isFinite(amount) || amount <= 0) {
    hint.textContent = 'Enter a positive amount.';
    hint.classList.add('error');
    return;
  }
  $('confirmStake').disabled = true;
  try {
    await api('POST', '/staking/stake', { validatorId: pendingValidator, amount });
    $('stakeModal').hidden = true;
    toast('Delegation created');
    await Promise.all([loadWallet(), loadStakes(), loadValidators(), loadTx(), loadStats(), loadReferrals(), loadGovernance()]);
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('confirmStake').disabled = false;
  }
});

async function claim(id) {
  try {
    const r = await api('POST', `/staking/${id}/claim`);
    celebrate({
      amount: r.rewardsPaid,
      title: 'Staking Rewards Claimed!',
      subtitle: 'Added to your wallet balance.',
      icon: '🏆',
    });
    await Promise.all([loadWallet(), loadStakes(), loadTx()]);
  } catch (e) {
    toast(e.message);
  }
}
async function unstake(id) {
  try {
    const stake = (await api('GET', '/staking')).stakes.find((s) => String(s.id) === String(id));
    if (stake) {
      const fee = Number(stake.amount) * 0.01;
      const returned = Number(stake.amount) - fee;
      if (!window.confirm(`Unstake ${fmt(stake.amount)} $DLTX?\n\nBurn fee: ${fmt(fee)} $DLTX\nYou receive: ${fmt(returned)} $DLTX + ${fmt(stake.pendingRewards)} rewards`)) return;
    }
    const r = await api('POST', `/staking/${id}/unstake`);
    toast(`Unstaked ${fmt(r.returnedPrincipal)} $DLTX · burned ${fmt(r.feeBurned)} fee`);
    await Promise.all([loadWallet(), loadStakes(), loadValidators(), loadTx(), loadStats()]);
  } catch (e) {
    toast(e.message);
  }
}

// ---------- D-Browser security interstitial + in-app browser ----------
let pendingDappUrl = null;
let pendingDappName = '';
const dbState = { history: [], index: -1, currentUrl: '' };
const ALLOWED_DAPP_HOSTS = new Set([
  'a-network.net', 'www.a-network.net', 'deltixllc.com', 'www.deltixllc.com',
  'app.uniswap.org', 'pancakeswap.finance', 'www.sushi.com', 'app.1inch.io',
]);
document.querySelectorAll('#dappGrid .dapp').forEach((d) =>
  d.addEventListener('click', () => {
    // Native in-app dApp pages (no external navigation)
    if (d.dataset.page) {
      if (d.dataset.page === 'swap') return openSwapChooser();
      if (d.dataset.page === 'dao') return showTab('tab-community');
      if (d.dataset.page === 'explorer') return openExplorer({ v: 'home' });
      return openDappPage(d.dataset.page, d.dataset.name);
    }
    let url;
    try {
      url = new URL(d.dataset.url);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' || !ALLOWED_DAPP_HOSTS.has(url.hostname)) return;
    // Own trusted properties open directly inside D-Browser
    if (d.dataset.direct === '1') return openDBrowser(url.href, d.dataset.name);
    pendingDappUrl = url.href;
    pendingDappName = d.dataset.name;
    $('dappModalTitle').textContent = `Open ${d.dataset.name}?`;
    $('dappModalUrl').textContent = url.href;
    $('dappModal').hidden = false;
  })
);
$('cancelDapp').addEventListener('click', () => ($('dappModal').hidden = true));
$('confirmDapp').addEventListener('click', () => {
  $('dappModal').hidden = true;
  if (!pendingDappUrl) return;
  openDBrowser(pendingDappUrl, pendingDappName);
  pendingDappUrl = null;
  pendingDappName = '';
});

// ---------- Swap venue chooser: A-Network DEX + external EVM DEXes ----------
const SWAP_VENUES = [
  { name: 'A-Network DEX', url: 'https://a-network.net/dex', tag: 'Recommended · Deltix partner', mono: 'A', color: 'linear-gradient(150deg, #3b82f6, #1e40af)' },
  { name: 'Uniswap', url: 'https://app.uniswap.org', tag: 'Ethereum & EVM chains', mono: 'U', color: 'linear-gradient(150deg, #ff5caa, #d6157e)' },
  { name: 'PancakeSwap', url: 'https://pancakeswap.finance', tag: 'BNB Chain & EVM', mono: 'P', color: 'linear-gradient(150deg, #53dee9, #1fc7d4)' },
  { name: 'SushiSwap', url: 'https://www.sushi.com/swap', tag: 'Multi-chain EVM', mono: 'S', color: 'linear-gradient(150deg, #a855f7, #6d28d9)' },
  { name: '1inch', url: 'https://app.1inch.io', tag: 'EVM DEX aggregator', mono: '1', color: 'linear-gradient(150deg, #475569, #0f172a)' },
];
function openSwapChooser() {
  $('swapOptions').innerHTML = SWAP_VENUES.map((v, i) => `
    <div class="swap-venue" data-vi="${i}">
      <div class="swap-venue-logo" style="background:${v.color}">${v.mono}</div>
      <div>
        <div class="swap-venue-name">${v.name}</div>
        <div class="swap-venue-tag">${v.tag}</div>
      </div>
    </div>`).join('');
  $('swapOptions').querySelectorAll('.swap-venue').forEach((row) =>
    row.addEventListener('click', () => {
      const v = SWAP_VENUES[Number(row.dataset.vi)];
      $('swapModal').hidden = true;
      openDBrowser(v.url, v.name);
    })
  );
  $('swapModal').hidden = false;
}
$('cancelSwap').addEventListener('click', () => ($('swapModal').hidden = true));

function normalizeBrowseInput(raw) {
  const q = String(raw || '').trim();
  if (!q) return null;
  if (/^https?:\/\//i.test(q)) return q;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(q)) return `https://${q}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
}

function updateDbUi() {
  const canBack = dbState.index > 0;
  const canForward = dbState.index >= 0 && dbState.index < dbState.history.length - 1;
  $('dbBack').disabled = !canBack;
  $('dbForward').disabled = !canForward;
  $('dbReload').disabled = !dbState.currentUrl;
  $('dbExternal').disabled = !dbState.currentUrl;
  $('dbGo').disabled = !$('dbInput').value.trim();
  if (dbState.currentUrl) {
    $('dbInput').value = dbState.currentUrl;
    try {
      $('dbHost').textContent = '🔒 ' + new URL(dbState.currentUrl).hostname;
    } catch {
      $('dbHost').textContent = '🔒 dapp';
    }
  }
}

function navigateDb(raw, { push = true, title } = {}) {
  const target = normalizeBrowseInput(raw);
  if (!target) return;

  const frame = $('dbFrame');
  const loading = $('dbLoading');
  loading.hidden = false;
  loading.innerHTML = '◆ Connecting securely…';

  if (push) {
    dbState.history = dbState.history.slice(0, dbState.index + 1);
    dbState.history.push(target);
    dbState.index = dbState.history.length - 1;
  }
  dbState.currentUrl = target;
  if (title) $('dbName').textContent = title;

  frame.dataset.url = target;
  // location.replace keeps the iframe out of the session history,
  // so the hardware back button always controls the app — not the frame.
  try {
    frame.contentWindow.location.replace(target);
  } catch {
    frame.src = target;
  }
  updateDbUi();

  let loaded = false;
  frame.onload = () => {
    loaded = true;
    loading.hidden = true;
    updateDbUi();
  };

  setTimeout(() => {
    if (loaded || dbState.currentUrl !== target) return;
    loading.innerHTML = `<div class="db-blocked">
      <div class="db-blocked-icon">🛡</div>
      <b>This dApp blocks embedded browsing</b>
      <p>Use external mode for this site while keeping D-Browser as your default gateway.</p>
      <button class="btn primary" id="dbBlockedOpen">Open in browser ↗</button>
    </div>`;
    const openBtn = document.getElementById('dbBlockedOpen');
    if (openBtn) openBtn.onclick = () => window.open(target, '_blank', 'noopener');
  }, 5000);
}

/** Open dApps inside the in-app D-Browser overlay (native + web). */
function openDBrowser(url, name) {
  $('dbName').textContent = name || 'D-Browser';
  dbState.history = [];
  dbState.index = -1;
  dbState.currentUrl = '';
  $('dbInput').value = '';
  $('dbrowser').hidden = false;
  document.body.style.overflow = 'hidden';
  updateTabAd();
  navigateDb(url, { push: true, title: name || 'D-Browser' });
}

function openCurrentExternally() {
  if (dbState.currentUrl) window.open(dbState.currentUrl, '_blank', 'noopener');
}
function goFromAddressBar() {
  const q = $('dbInput').value;
  if (!q.trim()) return;
  navigateDb(q, { push: true, title: 'D-Browser' });
}
function goDbBack() {
  if (dbState.index <= 0) return;
  dbState.index -= 1;
  navigateDb(dbState.history[dbState.index], { push: false });
}
function goDbForward() {
  if (dbState.index >= dbState.history.length - 1) return;
  dbState.index += 1;
  navigateDb(dbState.history[dbState.index], { push: false });
}
function reloadDb() {
  if (!dbState.currentUrl) return;
  navigateDb(dbState.currentUrl, { push: false });
}
function goDbHome() {
  navigateDb('https://deltixllc.com', { push: true, title: 'D-Browser' });
}
function closeDBrowser() {
  const frame = $('dbFrame');
  try {
    frame.contentWindow.location.replace('about:blank');
  } catch {
    frame.src = 'about:blank';
  }
  $('dbrowser').hidden = true;
  document.body.style.overflow = '';
  dbState.history = [];
  dbState.index = -1;
  dbState.currentUrl = '';
  $('dbInput').value = '';
  updateDbUi();
  updateTabAd();
}

$('dbClose').addEventListener('click', closeDBrowser);
$('dbExternal').addEventListener('click', openCurrentExternally);
$('dbOpenExt').addEventListener('click', openCurrentExternally);
$('dbBack').addEventListener('click', goDbBack);
$('dbForward').addEventListener('click', goDbForward);
$('dbReload').addEventListener('click', reloadDb);
$('dbHome').addEventListener('click', goDbHome);
$('dbGo').addEventListener('click', goFromAddressBar);
$('dbInput').addEventListener('input', updateDbUi);
$('dbNavForm').addEventListener('submit', (e) => {
  e.preventDefault();
  goFromAddressBar();
});

// Auto-advance OTP focus
$('emailInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('sendCodeBtn').click();
});
$('codeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('verifyBtn').click();
});

// ---------- Deltix Explorer (fully in-app block explorer) ----------
const exp = { stack: [] };
const short = (h, n = 14) => (h ? h.slice(0, n) + '…' : '—');
const kvRow = (k, v) => `<div class="supply-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;

function openExplorer(view) {
  exp.stack = [];
  $('explorer').hidden = false;
  document.body.style.overflow = 'hidden';
  updateTabAd();
  expGo(view || { v: 'home' });
}
function closeExplorer() {
  $('explorer').hidden = true;
  document.body.style.overflow = '';
  exp.stack = [];
  updateTabAd();
}
function expGo(view) {
  exp.stack.push(view);
  expRender();
}
$('expClose').addEventListener('click', closeExplorer);
$('expBack').addEventListener('click', () => {
  if (exp.stack.length > 1) {
    exp.stack.pop();
    expRender();
  } else closeExplorer();
});
$('openExplorer').addEventListener('click', () => openExplorer({ v: 'home' }));
$('seeAllTx').addEventListener('click', () => openExplorer({ v: 'activity' }));
// Public transparency: the chain API is open — anyone can inspect blocks without an account.
$('publicExplorerBtn')?.addEventListener('click', () => openExplorer({ v: 'home' }));

// ---------- Native in-app dApp pages (Collectibles · DeFi Hub · D-Vault) ----------
function openDappPage(page, title) {
  $('dappPageTitle').textContent = title || 'Deltix dApp';
  $('dappPage').hidden = false;
  document.body.style.overflow = 'hidden';
  updateTabAd();
  renderDappPage(page);
}
function closeDappPage() {
  $('dappPage').hidden = true;
  document.body.style.overflow = '';
  updateTabAd();
}
$('dappPageClose').addEventListener('click', closeDappPage);
$('dappPageBack').addEventListener('click', closeDappPage);

function collectibleCard({ icon, name, desc, earned }) {
  return `
  <div class="feature-card collectible ${earned ? 'earned' : 'locked'}">
    <img src="assets/${icon}" class="dapp-3d-icon" alt="" ${earned ? '' : 'style="filter:grayscale(1);opacity:.45"'} />
    <div>
      <div class="name">${name} ${earned ? '<span class="pill live">Earned</span>' : '<span class="pill">Locked</span>'}</div>
      <div class="meta">${desc}</div>
    </div>
  </div>`;
}

async function renderDappPage(page) {
  const body = $('dappPageBody');
  body.innerHTML = '<p class="muted center">Loading…</p>';
  try {
    if (page === 'nfts') {
      const bal = state.balances || {};
      const staked = Number(bal.stakedBalance || 0);
      const total = Number(bal.totalValue || 0);
      const txCount = (state.txs || []).length;
      body.innerHTML = `
        <div class="feature-card">
          <div class="name">Deltix Collectibles</div>
          <div class="meta">On-chain achievement badges tied to your validator activity. Collectibles are
          utility rewards — they carry no monetary value and cannot be bought, sold, or transferred.</div>
        </div>
        ${collectibleCard({ icon: 'shield-blue.svg', name: 'Genesis Wallet', desc: 'Created a Deltix wallet on-chain.', earned: !!state.address })}
        ${collectibleCard({ icon: 'icon-staked-coins.svg', name: 'Active Validator', desc: 'Delegated a stake to a Deltix validator.', earned: staked > 0 })}
        ${collectibleCard({ icon: 'icon-rewards-trophy.svg', name: 'Whale Watch', desc: 'Hold 100+ $DLTX combined balance.', earned: total >= 100 })}
        ${collectibleCard({ icon: 'dapp-explorer.svg', name: 'Chain Native', desc: 'Recorded 5+ transactions on the Deltix chain.', earned: txCount >= 5 })}
        ${collectibleCard({ icon: 'art-vault-safe.svg', name: 'Vault Keeper', desc: 'Backed up your account data in D-Vault.', earned: localStorage.getItem('dltx_vault_backup') === '1' })}
      `;
    } else if (page === 'defi') {
      const bal = state.balances || {};
      body.innerHTML = `
        <div class="feature-card">
          <div class="name">Deltix DeFi Hub</div>
          <div class="meta">Every DeFi primitive here runs natively on the Deltix chain — no external
          wallets or contracts required.</div>
        </div>
        <div class="card supply-list">
          <div class="supply-row"><span class="k">Available</span><span class="v">${fmt(bal.balance || 0)} $DLTX</span></div>
          <div class="supply-row"><span class="k">Staked</span><span class="v">${fmt(bal.stakedBalance || 0)} $DLTX</span></div>
          <div class="supply-row"><span class="k">Pending rewards</span><span class="v">${fmt(bal.pendingRewards || 0)} $DLTX</span></div>
        </div>
        <div class="feature-card clickable" id="dpGoStake">
          <img src="assets/dapp-defi.svg" class="dapp-3d-icon" alt="" />
          <div><div class="name">Staking · up to 15% APY →</div>
          <div class="meta">Delegate $DLTX to network validators and earn per-minute rewards.</div></div>
        </div>
        <div class="feature-card clickable" id="dpGoSend">
          <img src="assets/icon-liquid-drop.svg" class="dapp-3d-icon" alt="" />
          <div><div class="name">P2P Transfers · 1% burn →</div>
          <div class="meta">Send $DLTX wallet-to-wallet. Every transfer burns 1%, making $DLTX deflationary.</div></div>
        </div>
        <div class="feature-card clickable" id="dpGoDex">
          <img src="assets/dapp-swap.svg" class="dapp-3d-icon" alt="" />
          <div><div class="name">A-Network DEX →</div>
          <div class="meta">Swap assets on our partner DEX, right inside D-Browser.</div></div>
        </div>
      `;
      $('dpGoStake').addEventListener('click', () => { closeDappPage(); showTab('tab-stake'); });
      $('dpGoSend').addEventListener('click', () => { closeDappPage(); showTab('tab-wallet'); });
      $('dpGoDex').addEventListener('click', () => { closeDappPage(); openDBrowser('https://a-network.net/dex', 'A-Network DEX'); });
    } else if (page === 'storage') {
      body.innerHTML = `
        <div class="feature-card">
          <div class="name">D-Vault — your data, your keys</div>
          <div class="meta">Export a full, portable backup of your Deltix account: wallet address,
          balances, stakes, and transaction history as signed JSON. Stored only on your device —
          Deltix never uploads your backup anywhere.</div>
        </div>
        <div class="card">
          <button class="btn primary" id="dpExportBtn">⬇ Download account backup (JSON)</button>
          <p class="hint" id="dpExportHint"></p>
        </div>
        <div class="feature-card">
          <div class="name">Decentralized storage — roadmap</div>
          <div class="meta">Encrypted off-device vault replication across Deltix validator nodes is
          planned for a future network upgrade, governed by the Deltix DAO.</div>
        </div>
      `;
      $('dpExportBtn').addEventListener('click', async () => {
        try {
          const [wallet, txs, stakes] = await Promise.all([
            api('GET', '/wallet'), api('GET', '/wallet/transactions'), api('GET', '/staking'),
          ]);
          const backup = {
            app: 'Deltix Network', exportedAt: new Date().toISOString(),
            email: state.email, wallet, transactions: txs, stakes,
          };
          const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `deltix-vault-backup-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
          localStorage.setItem('dltx_vault_backup', '1');
          $('dpExportHint').textContent = 'Backup downloaded. Keep it somewhere safe.';
          $('dpExportHint').className = 'hint ok';
        } catch (e) {
          $('dpExportHint').textContent = e.message;
          $('dpExportHint').className = 'hint error';
        }
      });
    }
  } catch (e) {
    body.innerHTML = `<p class="muted center">${escapeHtml(e.message)}</p>`;
  }
}

async function expRender() {
  const v = exp.stack[exp.stack.length - 1];
  $('expBack').textContent = exp.stack.length > 1 ? '‹ Back' : '‹ Close';
  const body = $('expBody');
  body.innerHTML = '<p class="muted center">Loading…</p>';
  try {
    if (v.v === 'home') await expHome(body);
    else if (v.v === 'block') await expBlockView(body, v.height);
    else if (v.v === 'ctx') await expChainTxView(body, v);
    else if (v.v === 'wtx') expWalletTxView(body, v.tx);
    else if (v.v === 'activity') await expActivityView(body);
  } catch (e) {
    body.innerHTML = `<p class="muted center">${escapeHtml(e.message)}</p>`;
  }
}

async function expHome(body) {
  $('expCrumb').textContent = 'deltix-1 · latest blocks';
  const [info, blocks] = await Promise.all([api('GET', '/chain/info'), api('GET', '/chain/blocks?limit=30')]);
  body.innerHTML =
    `<div class="card supply-list">` +
    kvRow('Chain', info.chainId) +
    kvRow('Height', '#' + info.height) +
    kvRow('Total transactions', info.totalTxs) +
    kvRow('Pending', info.pendingTxs) +
    kvRow('Validators', info.validators.length) +
    kvRow('Genesis hash', `<span class="hash">${short(info.genesisHash)}</span>`) +
    `</div>` +
    `<div class="feature-card"><div class="name">Open & transparent by design</div>
     <div class="meta">Every block, transaction and hash link on the Deltix chain is public — anyone can
     verify the full history without an account. The network is live, but $DLTX has no monetary value,
     is not redeemable for real currency, and is not an investment.</div></div>` +
    `<h3 class="section-title">Latest blocks</h3><div id="expBlocks"></div>`;
  $('expBlocks').innerHTML = blocks.blocks
    .map(
      (b) => `
    <div class="block-card clickable" data-h="${b.height}">
      <div>
        <div class="name">Block #${b.height} <span class="hash">${short(b.hash)}</span></div>
        <div class="meta">${b.txCount} tx · by ${b.validator} · ${new Date(b.timestamp).toLocaleString()}</div>
      </div>
      <span class="status-pill activated">sealed</span>
    </div>`
    )
    .join('');
  $('expBlocks').querySelectorAll('[data-h]').forEach((c) =>
    c.addEventListener('click', () => expGo({ v: 'block', height: Number(c.dataset.h) }))
  );
}

async function expBlockView(body, height) {
  $('expCrumb').textContent = `block #${height}`;
  const { block } = await api('GET', '/chain/blocks/' + height);
  const txs = block.transactions || [];
  body.innerHTML =
    `<div class="card supply-list">` +
    kvRow('Block', '#' + block.height) +
    kvRow('Hash', `<span class="hash">${short(block.hash, 22)}</span>`) +
    kvRow('Previous', `<span class="hash">${short(block.prevHash, 22)}</span>`) +
    kvRow('Validator', escapeHtml(block.validator)) +
    kvRow('Sealed', new Date(block.timestamp).toLocaleString()) +
    kvRow('Transactions', txs.length) +
    `</div><h3 class="section-title">Transactions</h3><div id="expTxs">${txs.length ? '' : '<p class="muted center">Empty block.</p>'}</div>`;
  $('expTxs').innerHTML = txs
    .map(
      (t, i) => `
    <div class="tx clickable" data-i="${i}">
      <div><div class="type">${t.type.replace(/_/g, ' ')}</div><div class="date hash">${short(t.id, 20)}</div></div>
      <div class="amt plus">${fmt(t.amount)}</div>
    </div>`
    )
    .join('');
  $('expTxs').querySelectorAll('[data-i]').forEach((row) =>
    row.addEventListener('click', () => {
      const t = txs[Number(row.dataset.i)];
      expGo({ v: 'ctx', id: t.id, pre: { status: 'confirmed', blockHeight: block.height, blockHash: block.hash, tx: t } });
    })
  );
}

async function expChainTxView(body, view) {
  $('expCrumb').textContent = 'transaction';
  const r = view.pre || (await api('GET', '/chain/tx/' + encodeURIComponent(view.id)));
  const t = r.tx;
  const statusPill =
    r.status === 'confirmed'
      ? `<span class="status-pill activated">confirmed</span>`
      : `<span class="status-pill voting">pending</span>`;
  const metaRows = Object.entries(t.meta || {})
    .filter(([k]) => k !== 'chainTx')
    .map(([k, val]) => kvRow(escapeHtml(k), escapeHtml(typeof val === 'object' ? JSON.stringify(val) : String(val))))
    .join('');
  body.innerHTML =
    `<div class="card supply-list">` +
    kvRow('Status', statusPill) +
    (r.status === 'confirmed'
      ? kvRow('Block', `<button class="db-link" id="expTxBlock">#${r.blockHeight} ↗</button>`)
      : '') +
    kvRow('Tx hash', `<span class="hash">${short(t.id, 26)}</span>`) +
    kvRow('Type', t.type.replace(/_/g, ' ')) +
    kvRow('Amount', fmt(t.amount) + ' $DLTX') +
    kvRow('From', `<span class="hash">${escapeHtml(short(String(t.from || '—'), 22))}</span>`) +
    kvRow('To', `<span class="hash">${escapeHtml(short(String(t.to || '—'), 22))}</span>`) +
    kvRow('Submitted', new Date(t.submittedAt).toLocaleString()) +
    `</div>` +
    (metaRows ? `<h3 class="section-title">Details</h3><div class="card supply-list">${metaRows}</div>` : '');
  const blockBtn = document.getElementById('expTxBlock');
  if (blockBtn) blockBtn.addEventListener('click', () => expGo({ v: 'block', height: r.blockHeight }));
}

function expWalletTxView(body, t) {
  $('expCrumb').textContent = 'my transaction';
  const meta = t.meta || {};
  const metaRows = Object.entries(meta)
    .filter(([k]) => k !== 'chainTx')
    .map(([k, val]) => kvRow(escapeHtml(k), escapeHtml(typeof val === 'object' ? JSON.stringify(val) : String(val))))
    .join('');
  body.innerHTML =
    `<div class="card supply-list">` +
    kvRow('Type', t.type.replace(/_/g, ' ')) +
    kvRow('Amount', fmt(t.amount) + ' $DLTX') +
    kvRow('Date', new Date(t.created_at).toLocaleString()) +
    kvRow('Record', '#' + t.id) +
    `</div>` +
    (metaRows ? `<h3 class="section-title">Details</h3><div class="card supply-list">${metaRows}</div>` : '') +
    (meta.chainTx
      ? `<button class="btn primary" id="expViewOnChain">View on Deltix Chain ◆</button>`
      : `<p class="muted small-note center">This record predates on-chain linking.</p>`);
  const btn = document.getElementById('expViewOnChain');
  if (btn) btn.addEventListener('click', () => expGo({ v: 'ctx', id: meta.chainTx }));
}

async function expActivityView(body) {
  $('expCrumb').textContent = 'my activity';
  const r = await api('GET', '/wallet/transactions?limit=200');
  if (!r.transactions.length) {
    body.innerHTML = '<p class="muted center">No activity yet.</p>';
    return;
  }
  const negatives = ['stake', 'send', 'treasury_burn', 'paid_spin_wager'];
  body.innerHTML = `<div class="tx-list" id="expAct"></div>`;
  document.getElementById('expAct').innerHTML = r.transactions
    .map((t, i) => {
      const neg = negatives.includes(t.type);
      return `
      <div class="tx clickable" data-i="${i}">
        <div><div class="type">${t.type.replace(/_/g, ' ')}</div><div class="date">${new Date(t.created_at).toLocaleString()}</div></div>
        <div class="amt ${neg ? 'minus' : 'plus'}">${neg ? '−' : '+'}${fmt(t.amount)}</div>
      </div>`;
    })
    .join('');
  document.getElementById('expAct').querySelectorAll('[data-i]').forEach((row) =>
    row.addEventListener('click', () => expGo({ v: 'wtx', tx: r.transactions[Number(row.dataset.i)] }))
  );
}

function expSearch() {
  const q = $('expSearch').value.trim();
  if (!q) return;
  $('expSearch').value = '';
  if (/^#?\d+$/.test(q)) expGo({ v: 'block', height: Number(q.replace('#', '')) });
  else if (/^[0-9a-f]{8,64}$/i.test(q)) expGo({ v: 'ctx', id: q });
  else toast('Enter a block height (e.g. 12) or a tx hash');
}
$('expSearchBtn').addEventListener('click', expSearch);
$('expSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') expSearch();
});

// ---------- AdMob (native app only — Sustainability Fund banner) ----------
// Production ad units from the Deltix Network AdMob account.
//   App id (AndroidManifest): ca-app-pub-6703659529197503~2016406742
const ADMOB_BANNER_ID = 'ca-app-pub-6703659529197503/5133524678';
const ADMOB_INTERSTITIAL_ID = 'ca-app-pub-6703659529197503/1357931192';
// Rewarded unit: used ONLY for non-transferable cosmetics (premium avatar
// unlocks) — never $DLTX, which is P2P-transferable (AdMob rewarded-ad policy).
const ADMOB_REWARDED_ID = 'ca-app-pub-6703659529197503/5850926156';
// UX decision: disable all bottom banner placements (persistent footer + game-over MREC)
// and keep only interstitial + rewarded formats.
const BANNER_ADS_ENABLED = false;
const ADS_ENABLED = true; // ADS ENABLED: interstitial + rewarded (Energy/cosmetics) live
const ADMOB_TESTING = false; // PRODUCTION BUILD: live AdMob creatives
window.ADS_ENABLED = ADS_ENABLED;
let adsReady = false;
let gamesSinceInterstitial = 0;
let lastInterstitialAt = 0;

async function initAds() {
  try {
    if (!ADS_ENABLED) return;
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
    const AdMob = cap.Plugins && cap.Plugins.AdMob;
    if (!AdMob) return;
    // GDPR/UMP consent (EEA, UK, Switzerland): gather consent before ads load.
    // Never allowed to block the app — failures fall through to ad init.
    try {
      const info = await AdMob.requestConsentInfo();
      if (info && info.isConsentFormAvailable && info.status === 'REQUIRED') {
        await AdMob.showConsentForm();
      }
    } catch {
      /* consent flow unavailable — continue; SDK serves non-personalized ads */
    }
    await AdMob.initialize({ initializeForTesting: ADMOB_TESTING });
    adsReady = true;
  } catch {
    /* ads are never allowed to break the app */
  }
}

/** Banner is placed cleanly across all tabs, fitting neatly between the header and the raised footer tab bar. */
let currentTabId = 'tab-wallet';

async function updateTabAd(tabId) {
  if (tabId) currentTabId = tabId;
  const cap = window.Capacitor;
  if (!adsReady || !cap || !cap.Plugins || !cap.Plugins.AdMob) return;

  if (!BANNER_ADS_ENABLED) {
    try {
      await cap.Plugins.AdMob.hideBanner();
      shownBannerSize = null;
      document.body.classList.remove('has-ad-banner');
    } catch {}
    return;
  }

  const isMainScreen = document.getElementById('screen-main')?.classList.contains('active');
  const isOverlayOpen = (!document.getElementById('dbrowser')?.hidden) ||
                        (!document.getElementById('explorer')?.hidden) ||
                        (!document.getElementById('dappPage')?.hidden) ||
                        (!document.getElementById('gameModal')?.hidden);

  // Policy guardrail: Hide banner during full-screen interactive overlays or authentication
  if (!isMainScreen || isOverlayOpen) {
    try {
      await cap.Plugins.AdMob.hideBanner();
      document.body.classList.remove('has-ad-banner');
    } catch {}
    return;
  }

  try {
    await showBannerAd('ADAPTIVE_BANNER');
    document.body.classList.add('has-ad-banner');
  } catch {
    /* ignore ad errors */
  }
}
window.updateTabAd = updateTabAd;

/** Single-banner helper: the plugin holds one banner view, so switching sizes
 *  (adaptive tab banner ↔ game-over MREC) requires a remove + re-show. */
let shownBannerSize = null;
async function showBannerAd(adSize) {
  const AdMob = window.Capacitor.Plugins.AdMob;
  if (shownBannerSize && shownBannerSize !== adSize) {
    await AdMob.removeBanner().catch(() => {});
    shownBannerSize = null;
  }
  await AdMob.showBanner({
    adId: ADMOB_BANNER_ID,
    adSize,
    position: 'BOTTOM_CENTER',
    margin: 0,
    isTesting: ADMOB_TESTING,
  });
  shownBannerSize = adSize;
}

/** Medium-rectangle banner shown only on the game-over screen. */
async function showGameOverAd() {
  if (!BANNER_ADS_ENABLED) return;
  const cap = window.Capacitor;
  if (!adsReady || !cap?.Plugins?.AdMob) return;
  try {
    await showBannerAd('MEDIUM_RECTANGLE');
    // Pads #gameMount so replay/quit buttons never sit under the ad (accidental-click guardrail).
    document.body.classList.add('has-gameover-ad');
  } catch {
    /* ignore ad errors */
  }
}
async function hideGameOverAd() {
  document.body.classList.remove('has-gameover-ad');
  const cap = window.Capacitor;
  if (!adsReady || !cap?.Plugins?.AdMob) return;
  try {
    await cap.Plugins.AdMob.removeBanner();
    shownBannerSize = null;
  } catch {
    /* ignore ad errors */
  }
}
window.showGameOverAd = showGameOverAd;
window.hideGameOverAd = hideGameOverAd;

// ---------- Deltix Energy (watch-to-earn status ranks — no monetary value, never $DLTX) ----------
const ENERGY_RANKS = [
  { name: 'Deltix Soldier',   min: 1,    max: 49,       asset: '09_soldier_shield.png' },
  { name: 'Deltix Inspector', min: 50,   max: 100,      asset: '10_inspector_shield.png' },
  { name: 'Deltix Guardian',  min: 101,  max: 250,      asset: '11_guardian_shield.png' },
  { name: 'Deltix Captain',   min: 251,  max: 500,      asset: '12_captain_shield.png' },
  { name: 'Deltix Major',     min: 501,  max: 1000,     asset: '13_major_shield.png' },
  { name: 'Deltix Commander', min: 1001, max: 2500,     asset: '14_commander_shield.png' },
  { name: 'Deltix Elite',     min: 2501, max: 4000,     asset: '15_elite_shield.png' },
  { name: 'Deltix Legend',    min: 4001, max: Infinity, asset: '16_legend_shield.png' },
];
function energyState() {
  const e = state.energy;
  return {
    energy: Number(e?.energy) || 0,
    streak: Number(e?.streak) || 0,
    last: e?.lastEarnedOn || '',
    remainingToday: e ? Number(e.remainingToday) || 0 : null,
  };
}
function rankForEnergy(e) {
  for (let i = ENERGY_RANKS.length - 1; i >= 0; i--) if (e >= ENERGY_RANKS[i].min) return { rank: ENERGY_RANKS[i], index: i };
  return { rank: ENERGY_RANKS[0], index: 0 };
}

// ---- Energy + cosmetic ownership live on the account, not the device ----
// Held server-side so a rank survives a reinstall or a new phone and cannot be
// edited locally. Energy is still non-monetary and is never $DLTX.
const LEGACY_ENERGY_KEYS = [
  'dltx_energy', 'dltx_energy_streak', 'dltx_energy_last',
  'dltx_games_unlocked', 'dltx_avatar_unlocked', 'dltx_theme_unlocked',
];
/** Reads the pre-migration device values so nobody loses what they earned. */
function legacyEnergyPayload() {
  const json = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
  const payload = {
    energy: parseInt(localStorage.getItem('dltx_energy') || '0', 10) || 0,
    streak: parseInt(localStorage.getItem('dltx_energy_streak') || '0', 10) || 0,
    games: json('dltx_games_unlocked'),
    avatars: json('dltx_avatar_unlocked'),
    themes: json('dltx_theme_unlocked'),
  };
  const hasSomething =
    payload.energy > 0 || payload.games.length || payload.avatars.length || payload.themes.length;
  return hasSomething ? payload : null;
}

// loadEnergy is triggered from several places (app entry, opening the Energy
// tab, pull-to-refresh) which can overlap. Sharing one in-flight request stops
// concurrent calls from double-running the one-time migration, which would
// otherwise double-credit or clobber the account's Energy on first login.
let _energyLoad = null;
async function loadEnergy(prefetched) {
  if (_energyLoad) return _energyLoad;
  _energyLoad = (async () => {
    try {
      let e = prefetched || await api('GET', '/energy');
      const legacy = legacyEnergyPayload();
      if (!e.migrated && legacy) {
        const r = await api('POST', '/energy/migrate', legacy).catch(() => null);
        // The server is authoritative: adopt its state whether it applied the
        // migration now or reported it was already migrated on another device.
        if (r && (r.migrationApplied || r.migrated)) {
          e = r;
          if (r.migrationApplied) toast('Your Energy is now saved to your account ⚡');
        }
      }
      // Once the account holds the truth, the device copies are just clutter.
      if (e.migrated) LEGACY_ENERGY_KEYS.forEach((k) => localStorage.removeItem(k));
      state.energy = e;
      renderEnergy();
      renderThemeGrid();
    } catch (err) {
      // Never let a transient failure blank out a known balance — keeping the
      // last good value stops Energy from briefly reading 0 after a reinstall.
      console.warn('loadEnergy:', err.message);
    } finally {
      _energyLoad = null;
    }
  })();
  return _energyLoad;
}

function unlockedGames() { return state.energy?.unlocked?.games || []; }
function unlockedAvatars() { return state.energy?.unlocked?.avatars || []; }
function unlockedThemes() { return state.energy?.unlocked?.themes || []; }
function isGameUnlocked(id) {
  return unlockedGames().includes(id);
}
/** Spends Energy on a bonus game. Server-authoritative. */
async function unlockGameWithEnergy(id) {
  if (isGameUnlocked(id)) return { ok: true, already: true };
  try {
    const r = await api('POST', '/energy/unlock', { kind: 'game', item: id });
    state.energy = r;
    renderEnergy();
    return { ok: true, already: Boolean(r.alreadyOwned) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
/** Records a rewarded-ad cosmetic unlock on the account (costs no Energy). */
async function unlockCosmetic(kind, item) {
  try {
    state.energy = await api('POST', '/energy/unlock', { kind, item });
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}
window.energyBalance = () => energyState().energy;
window.isGameUnlocked = isGameUnlocked;
window.unlockGameWithEnergy = unlockGameWithEnergy;
function renderEnergy() {
  const st = energyState();
  const { rank, index } = rankForEnergy(st.energy);
  const next = ENERGY_RANKS[index + 1] || null;
  const base = rank.min <= 1 ? 0 : rank.min;
  const shield = $('ercShield');
  if (shield) shield.src = `assets/energy/${rank.asset}`;
  const set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  set('ercRankName', rank.name.toUpperCase());
  set('ercEnergy', fmt(st.energy));
  set('eecMeta', `Energy: ${fmt(st.energy)}`);
  const fill = $('ercBarFill');
  if (next) {
    const pct = Math.max(0, Math.min(100, ((st.energy - base) / (next.min - base)) * 100));
    if (fill) fill.style.width = pct + '%';
    set('ercNext', `Next rank: ${next.name}`);
    set('ercRange', `${fmt(st.energy)} / ${fmt(next.min)}`);
    set('eecUntil', `${fmt(Math.max(0, next.min - st.energy))} Energy until ${next.name}`);
  } else {
    if (fill) fill.style.width = '100%';
    set('ercNext', 'Max rank reached');
    set('ercRange', `${fmt(st.energy)} Energy`);
    set('eecUntil', 'Max Energy rank reached');
  }
  const grid = $('energyRanksGrid');
  if (grid) grid.innerHTML = ENERGY_RANKS.map((rk, i) => `
    <div class="energy-rank ${i === index ? 'current' : ''}">
      <div class="er-name">${rk.name.replace(' ', '<br>')}</div>
      <img src="assets/energy/${rk.asset}" class="er-badge" alt="${rk.name}" />
      <div class="er-range">${rk.max === Infinity ? rk.min + '+' : rk.min + '\u2013' + rk.max}</div>
      <div class="er-rate">+1 Energy / Ad</div>
    </div>`).join('');
  set('efStreakSub', st.streak > 0 ? `${st.streak}-day streak 🔥` : 'Build streaks, earn bonus Energy');
  const opened = unlockedGames().length;
  set('efGamesSub', opened >= 5 ? 'All 5 bonus games unlocked ✅' : `${opened}/5 unlocked · spend Energy in the Arcade`);
  applyEnergyHour(state.energy?.happyHour);
}

// ---- Energy Happy Hour — one 2× Energy window per day (mirrors Deltix Hour) ----
let ehTimer = null;
let ehAnnouncedFor = null;
function updateEhCountdown(endsAt) {
  const sub = $('energyHourSub');
  if (!sub || !endsAt) return;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) { applyEnergyHour({ active: false }); loadEnergy().catch(() => {}); return; }
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  sub.textContent = `2× Energy on every ad · ends in ${m}:${String(s).padStart(2, '0')}`;
}
function applyEnergyHour(hh) {
  const banner = $('energyHourBanner');
  if (!banner) return;
  const title = $('energyHourTitle');
  if (!hh || !hh.active) {
    banner.classList.add('idle');
    if (title) title.textContent = 'Energy Happy Hour';
    const sub = $('energyHourSub');
    if (sub) sub.textContent = '2× Energy earning strikes at a surprise time each day';
    if (ehTimer) { clearInterval(ehTimer); ehTimer = null; }
    ehAnnouncedFor = null;
    return;
  }
  banner.classList.remove('idle');
  if (title) title.textContent = `⚡ ENERGY HAPPY HOUR — ${hh.multiplier}× LIVE`;
  updateEhCountdown(hh.endsAt);
  if (ehTimer) clearInterval(ehTimer);
  ehTimer = setInterval(() => updateEhCountdown(hh.endsAt), 1000);
  if (ehAnnouncedFor !== hh.endsAt) {
    ehAnnouncedFor = hh.endsAt;
    try { window.ArcadeSound?.reward?.(); } catch {}
    toast(`⚡ ENERGY HAPPY HOUR is live — ${hh.multiplier}× Energy for the next hour!`);
  }
}
// Rewarded ads may not be requested back-to-back — enforce a 30s gap between views.
const ENERGY_AD_COOLDOWN_MS = 30000;
let lastEnergyAdAt = 0;
async function earnEnergy(btn) {
  if (window.ADS_ENABLED === false) { toast('Ads are temporarily unavailable — please try again later.'); return; }
  const waitMs = ENERGY_AD_COOLDOWN_MS - (Date.now() - lastEnergyAdAt);
  if (waitMs > 0) { toast(`Please wait ${Math.ceil(waitMs / 1000)}s before the next ad.`); return; }
  if (btn) btn.disabled = true;
  try {
    const earned = await playRewardedAd();
    if (earned) lastEnergyAdAt = Date.now();
    if (!earned) { toast('Ad not completed — no Energy earned.'); return; }
    // The account is the source of truth — the server credits and returns it.
    const r = await api('POST', '/energy/earn');
    state.energy = r;
    renderEnergy();
    const gained = Number(r.earned) || 1;
    toast(r.happyHour?.active ? `+${gained} Energy ⚡ (Happy Hour ${r.happyHour.multiplier}×!)` : `+${gained} Energy ⚡`);
  } catch (e) {
    if (e.data) { state.energy = e.data; renderEnergy(); }
    toast(e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}
$('energyEarnBtn')?.addEventListener('click', (e) => earnEnergy(e.currentTarget));
$('energyWatchBtn')?.addEventListener('click', (e) => earnEnergy(e.currentTarget));
document.querySelectorAll('.energy-feat').forEach((c) =>
  c.addEventListener('click', () => {
    if (c.dataset.ef === 'streak') {
      const st = energyState();
      toast(st.streak > 0 ? `You're on a ${st.streak}-day streak 🔥` : 'Watch an ad today to start your streak!');
    } else if (c.dataset.ef === 'games') {
      showTab('tab-arcade');
      toast('Spend Energy to open bonus games 🎮');
    } else {
      toast('Coming soon 🚀');
    }
  })
);

// ==================== Deltix Rewards ====================
// Light, non-gaming daily loops: check-in, mystery box, fortune wheel (free +
// paid), and a daily chest. Every payout is settled server-side; the client
// only animates the result. Interstitial ads are shown around actions but are
// never required to receive a reward.
const rewardState = { data: null, spinning: false, wheelRot: 0, wheelSegs: [], wheelMode: 'free', readyAt: {} };
let rewardTimer = null;
let lastRewardInterstitial = 0;
const fmtInt = (n) => Number(n || 0).toLocaleString();

/** Frequency-capped interstitial for reward actions (native only). */
function showRewardInterstitial() {
  if (window.ADS_ENABLED === false) return;
  const cap = window.Capacitor;
  const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !AdMob) return;
  if (Date.now() - lastRewardInterstitial < 40000) return; // stay inside AdMob limits
  lastRewardInterstitial = Date.now();
  AdMob.prepareInterstitial({ adId: ADMOB_INTERSTITIAL_ID, isTesting: ADMOB_TESTING })
    .then(() => AdMob.showInterstitial())
    .catch(() => {});
}

async function loadRewards() {
  if (!state.token) return;
  try {
    const r = await api('GET', '/rewards');
    rewardState.data = r;
    const now = Date.now();
    rewardState.readyAt = {
      checkin: now + (r.checkin.nextInMs || 0),
      box: now + (r.mysteryBox.nextInMs || 0),
      spin: now + (r.spin.nextInMs || 0),
    };
    renderRewards();
    startRewardTimer();
  } catch { /* handled by api() */ }
  loadVault().catch(() => {});
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'ready';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}

function setText(id, txt) { const e = $(id); if (e) e.textContent = txt; }

function renderRewards({ redrawWheel = true } = {}) {
  const d = rewardState.data;
  if (!d) return;
  const now = Date.now();
  const rem = (k) => Math.max(0, (rewardState.readyAt[k] || 0) - now);

  setText('rewardCapNote', `Daily reward allowance: ${fmt(d.earnedToday)} / ${fmt(d.dailyCap)} $DLTX used today`);

  // Check-in
  const ci = d.checkin;
  const ciReady = rem('checkin') <= 0;
  setText('checkinSub', `Earn ${fmt(ci.reward)} $DLTX every day you check in.`);
  setText('checkinStreak', ci.streak > 0 ? `🔥 ${ci.streak}-day streak` : 'Start your streak today!');
  const cb = $('checkinBtn');
  if (cb) {
    cb.disabled = !ciReady;
    cb.textContent = ciReady ? `Check in · +${fmt(ci.reward)} $DLTX` : `Checked in ✓ · resets in ${fmtCountdown(rem('checkin'))}`;
  }

  // Mystery box
  const mb = d.mysteryBox;
  const boxReady = rem('box') <= 0;
  const bb = $('boxBtn');
  if (bb) { bb.disabled = !boxReady; bb.textContent = boxReady ? 'Open box' : `Next box in ${fmtCountdown(rem('box'))}`; }
  const beb = $('boxEnergyBtn');
  if (beb) { beb.textContent = `Extra box · ${mb.energyCostForExtra} ⚡`; beb.disabled = !mb.canUseEnergy; }

  // Spin wheel
  const sp = d.spin;
  const spinReady = rem('spin') <= 0;
  const fsb = $('freeSpinBtn');
  if (fsb) { fsb.disabled = !spinReady || rewardState.spinning; fsb.textContent = spinReady ? 'Free spin' : `Free spin in ${fmtCountdown(rem('spin'))}`; }
  const psb = $('paidSpinBtn');
  if (psb) { psb.disabled = !d.paidSpin.canAfford || rewardState.spinning; psb.textContent = `Spin for ${fmt(d.paidSpin.cost)} $DLTX`; }
  setText('spinPool', `Community pool: ${fmt(d.pool)} $DLTX · paid-spin prizes are funded by the pool (never burned).`);
  if (redrawWheel && rewardState.wheelMode !== 'paid' && !rewardState.spinning) {
    rewardState.wheelSegs = sp.segments;
    drawWheel();
  }

  // Daily chest
  const ch = d.chest;
  setText('chestSub', ch.ready
    ? 'Pick one chest — one holds $DLTX, one Energy, one is empty.'
    : 'You already opened today\u2019s chest. Come back tomorrow!');
  document.querySelectorAll('.chest-pick').forEach((b) => {
    b.disabled = !ch.ready;
    if (ch.ready) {
      b.classList.remove('picked', 'win', 'lose');
      const span = b.querySelector('span');
      if (span) span.textContent = '#' + (Number(b.dataset.pick) + 1);
    }
  });
  if (ch.ready) setText('chestResult', '');
}

function startRewardTimer() {
  if (rewardTimer) return;
  rewardTimer = setInterval(() => {
    if (!state.token || rewardState.spinning) return;
    if (!document.getElementById('tab-rewards')?.classList.contains('active')) return;
    renderRewards({ redrawWheel: false });
  }, 1000);
}

function resetRewardsUI() {
  rewardState.data = null;
  rewardState.spinning = false;
  rewardState.wheelMode = 'free';
  if (rewardTimer) { clearInterval(rewardTimer); rewardTimer = null; }
  setText('rewardCapNote', 'Daily reward allowance: — / — $DLTX');
  setText('chestResult', '');
}

// ---- Fortune wheel canvas ----
const WHEEL_PALETTE = ['#6366f1', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#0ea5e9'];

function segLabel(s) {
  if (s.kind === 'energy') return `⚡${s.amount}`;
  if (s.kind === 'dltx') {
    if (typeof s.mult === 'number') return s.mult === 0 ? '✕' : `×${s.mult}`;
    return `${s.amount}Δ`;
  }
  return '';
}

function drawWheel() {
  const canvas = $('spinWheel');
  const segs = rewardState.wheelSegs;
  if (!canvas || !segs || !segs.length) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, cx = W / 2, cy = W / 2, R = W / 2 - 6;
  const N = segs.length, seg = (Math.PI * 2) / N;
  ctx.clearRect(0, 0, W, W);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rewardState.wheelRot);
  for (let i = 0; i < N; i++) {
    const a0 = -Math.PI / 2 + i * seg, a1 = a0 + seg;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, a0, a1);
    ctx.closePath();
    ctx.fillStyle = WHEEL_PALETTE[i % WHEEL_PALETTE.length];
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.save();
    ctx.rotate(a0 + seg / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText(segLabel(segs[i]), R - 12, 0);
    ctx.restore();
  }
  ctx.restore();
}

function spinWheelTo(index) {
  return new Promise((resolve) => {
    const segs = rewardState.wheelSegs;
    const N = segs.length, seg = (Math.PI * 2) / N;
    const start = rewardState.wheelRot;
    const TWO_PI = Math.PI * 2;
    const finalMod = ((-(index + 0.5) * seg) % TWO_PI + TWO_PI) % TWO_PI;
    const delta = TWO_PI * 6 + ((finalMod - (start % TWO_PI) + TWO_PI) % TWO_PI);
    const target = start + delta;
    const dur = 4200, t0 = performance.now();
    function frame(t) {
      const p = Math.min(1, (t - t0) / dur);
      const ease = 1 - Math.pow(1 - p, 3);
      rewardState.wheelRot = start + delta * ease;
      drawWheel();
      if (p < 1) requestAnimationFrame(frame);
      else { rewardState.wheelRot = target % TWO_PI; drawWheel(); resolve(); }
    }
    requestAnimationFrame(frame);
  });
}

// ---- Reward action handlers ----
$('checkinBtn')?.addEventListener('click', async () => {
  const btn = $('checkinBtn');
  btn.disabled = true;
  try {
    const r = await api('POST', '/rewards/checkin');
    if (r.capped) toast(`Checked in! Daily $DLTX cap reached — ${r.streak}-day streak 🔥`);
    else celebrate({ amount: r.reward, title: 'Daily Check-in Complete!', subtitle: `You're on a ${r.streak}-day streak 🔥`, icon: '📅' });
    await Promise.allSettled([loadRewards(), loadWallet(), loadTx()]);
    showRewardInterstitial();
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
});

async function openMysteryBox(useEnergy) {
  const btn = useEnergy ? $('boxEnergyBtn') : $('boxBtn');
  if (btn) btn.disabled = true;
  const vis = $('boxVisual');
  if (vis) vis.classList.add('box-shake');
  try {
    const r = await api('POST', '/rewards/mystery-box', { useEnergy: !!useEnergy });
    if (vis) { vis.classList.remove('box-shake'); vis.textContent = '🎉'; }
    if (r.capped) toast('Box opened — daily $DLTX cap reached. Try again tomorrow!');
    else celebrate({ amount: r.reward, title: 'Mystery Box Opened!', subtitle: 'You found a $DLTX reward inside.', icon: '📦' });
    await Promise.allSettled([loadRewards(), loadWallet(), loadEnergy(), loadTx()]);
    showRewardInterstitial();
    setTimeout(() => { if (vis) vis.textContent = '📦'; }, 1600);
  } catch (e) {
    if (vis) vis.classList.remove('box-shake');
    toast(e.message);
    renderRewards();
  }
}
$('boxBtn')?.addEventListener('click', () => openMysteryBox(false));
$('boxEnergyBtn')?.addEventListener('click', () => openMysteryBox(true));

async function runSpin(paid) {
  if (rewardState.spinning || !rewardState.data) return;
  const d = rewardState.data;
  if (paid && !d.paidSpin.canAfford) { toast('You need transferable $DLTX to spin.'); return; }
  if (!paid && rewardState.readyAt.spin - Date.now() > 0) return;
  rewardState.spinning = true;
  rewardState.wheelMode = paid ? 'paid' : 'free';
  rewardState.wheelSegs = paid ? d.paidSpin.segments : d.spin.segments;
  drawWheel();
  if ($('freeSpinBtn')) $('freeSpinBtn').disabled = true;
  if ($('paidSpinBtn')) $('paidSpinBtn').disabled = true;
  try {
    const r = await api('POST', paid ? '/rewards/paid-spin' : '/rewards/spin');
    await spinWheelTo(r.index);
    if (paid) {
      if (r.segment.kind === 'dltx' && r.wonDltx > 0) celebrate({ amount: r.wonDltx, title: 'You Won the Spin!', subtitle: `Net ${r.net >= 0 ? '+' : ''}${fmt(r.net)} $DLTX after wager.`, icon: '🎰' });
      else if (r.segment.kind === 'energy') celebrate({ amount: r.energyAwarded, unit: '⚡ Energy', title: 'Energy Boost!', subtitle: `You now have ${fmt(r.energy)} ⚡ total.`, icon: '⚡' });
      else toast('No win this spin — the wager went to the community pool.');
    } else {
      if (r.segment.kind === 'dltx' && r.reward > 0) celebrate({ amount: r.reward, title: 'Free Spin Win!', subtitle: 'Straight to your wallet.', icon: '🎉' });
      else if (r.segment.kind === 'dltx') toast('Daily $DLTX cap reached — spin again tomorrow.');
      else celebrate({ amount: r.energyAwarded, unit: '⚡ Energy', title: 'Energy Won!', subtitle: `You now have ${fmt(r.energy)} ⚡ total.`, icon: '⚡' });
    }
    await Promise.allSettled([loadRewards(), loadWallet(), loadEnergy(), loadTx()]);
    showRewardInterstitial();
  } catch (e) {
    toast(e.message);
  } finally {
    rewardState.spinning = false;
    rewardState.wheelMode = 'free';
    renderRewards();
  }
}
$('freeSpinBtn')?.addEventListener('click', () => runSpin(false));
$('paidSpinBtn')?.addEventListener('click', () => runSpin(true));

document.querySelectorAll('.chest-pick').forEach((b) =>
  b.addEventListener('click', async () => {
    if (b.disabled || !rewardState.data) return;
    const pick = Number(b.dataset.pick);
    document.querySelectorAll('.chest-pick').forEach((x) => (x.disabled = true));
    b.classList.add('picked');
    try {
      const r = await api('POST', '/rewards/chest', { pick });
      const labels = {
        dltx: `+${fmt(rewardState.data.chest.dltx)} $DLTX`,
        energy: `+${rewardState.data.chest.energy} ⚡`,
        nothing: 'Empty',
      };
      document.querySelectorAll('.chest-pick').forEach((x) => {
        const outcome = r.outcomes[Number(x.dataset.pick)];
        x.classList.add(outcome === 'nothing' ? 'lose' : 'win');
        const span = x.querySelector('span');
        if (span) span.textContent = labels[outcome];
      });
      const msg = r.chosen === 'dltx'
        ? (r.capped ? 'You picked $DLTX, but the daily cap is reached!' : `🎉 You won +${fmt(r.reward)} $DLTX!`)
        : r.chosen === 'energy'
          ? `⚡ You won +${r.energyAwarded} Energy!`
          : 'Empty chest — try again tomorrow!';
      setText('chestResult', msg);
      if (r.chosen === 'dltx' && !r.capped && r.reward > 0) celebrate({ amount: r.reward, title: 'Mystery Chest Unlocked!', subtitle: 'A shiny $DLTX reward is yours.', icon: '🎁' });
      else if (r.chosen === 'energy' && r.energyAwarded > 0) celebrate({ amount: r.energyAwarded, unit: '⚡ Energy', title: 'Mystery Chest Unlocked!', subtitle: `You now have ${fmt(r.energy)} ⚡ total.`, icon: '🎁' });
      else toast(msg);
      await Promise.allSettled([loadRewards(), loadWallet(), loadEnergy(), loadTx()]);
      showRewardInterstitial();
    } catch (e) {
      toast(e.message);
      document.querySelectorAll('.chest-pick').forEach((x) => (x.disabled = false));
    }
  })
);

// ==================== Deltix Missions ====================
// A daily 6-step journey (City → Work → Build → Explore → Fly → Moon). A new
// mission unlocks every 4 hours (server-authoritative); each is completed after
// an opt-in rewarded ad and the full 6/6 unlocks one randomized daily reward.
const missionState = { data: null, busy: false };
let missionTimer = null;

async function loadMissions() {
  if (!state.token) return;
  try {
    missionState.data = await api('GET', '/missions');
    renderMissions();
    startMissionTimer();
  } catch { /* handled by api() */ }
}

function renderMissions() {
  const d = missionState.data;
  if (!d) return;
  const path = $('missionPath');
  if (path) {
    path.innerHTML = d.missions.map((m) => `
      <div class="mstep ${m.status}">
        <div class="mstep-emoji">${m.status === 'done' ? '✅' : (m.status === 'locked' ? '🔒' : m.emoji)}</div>
        <div class="mstep-name">${m.name.replace(' Mission', '').replace(' Landing', '')}</div>
      </div>`).join('<div class="mstep-link"></div>');
  }

  const cur = d.missions.find((m) => m.status === 'available')
    || d.missions[Math.min(d.completed, d.missions.length - 1)];
  setText('missionEmoji', d.allComplete ? '🌕' : (cur ? cur.emoji : '🏙️'));
  setText('missionTitle', d.allComplete ? 'Journey Complete!' : (cur ? cur.name : 'Missions'));
  setText('missionTagline', d.allComplete
    ? 'You reached the Moon. Claim your daily reward!'
    : (cur ? cur.tagline : ''));
  const fill = $('missionProgressFill');
  if (fill) fill.style.width = `${Math.round((d.completed / d.count) * 100)}%`;
  setText('missionProgressTxt', `${d.completed} / ${d.count} missions`);

  const actBtn = $('missionActionBtn');
  const claimBtn = $('missionClaimBtn');
  if (d.allComplete) {
    if (actBtn) actBtn.hidden = true;
    if (claimBtn) {
      claimBtn.hidden = false;
      claimBtn.disabled = !d.claimable || missionState.busy;
      claimBtn.textContent = d.claimedToday ? 'Reward claimed ✓ — back tomorrow' : 'Claim daily reward 🎁';
    }
  } else {
    if (claimBtn) claimBtn.hidden = true;
    if (actBtn) {
      actBtn.hidden = false;
      if (d.nextAvailable) {
        actBtn.disabled = missionState.busy;
        actBtn.textContent = `Start ${cur ? cur.name.replace(' Mission', '').replace(' Landing', '') : 'mission'} ▶`;
      } else {
        actBtn.disabled = true;
        actBtn.textContent = `Next mission in ${fmtCountdown(d.nextUnlockInMs)}`;
      }
    }
  }
}

function startMissionTimer() {
  if (missionTimer) return;
  missionTimer = setInterval(() => {
    if (!state.token || missionState.busy) return;
    if (!document.getElementById('tab-missions')?.classList.contains('active')) return;
    const d = missionState.data;
    if (!d) return;
    if (!d.allComplete && !d.nextAvailable && d.nextUnlockInMs > 0) {
      d.nextUnlockInMs = Math.max(0, d.nextUnlockInMs - 1000);
      if (d.nextUnlockInMs === 0) { loadMissions(); return; }
    }
    renderMissions();
  }, 1000);
}

async function completeMission() {
  const d = missionState.data;
  if (!d || missionState.busy || !d.nextAvailable) return;
  missionState.busy = true;
  const btn = $('missionActionBtn');
  if (btn) btn.disabled = true;
  try {
    const earned = await playRewardedAd();
    if (!earned) { toast('Ad not completed — mission not finished.'); return; }
    const r = await api('POST', '/missions/complete');
    missionState.data = r;
    renderMissions();
    if (r.allComplete) toast('🌕 Moon landing! All 6 missions complete — claim your reward!');
    else toast(`${r.completedMission?.name || 'Mission'} complete — ${r.progress} ✅`);
  } catch (e) {
    if (e.data) { missionState.data = e.data; renderMissions(); }
    toast(e.message);
  } finally {
    missionState.busy = false;
    renderMissions();
  }
}

async function claimMissionReward() {
  const d = missionState.data;
  if (!d || missionState.busy || !d.claimable) return;
  missionState.busy = true;
  const btn = $('missionClaimBtn');
  if (btn) btn.disabled = true;
  try {
    const earned = await playRewardedAd();
    if (!earned) { toast('Ad not completed — no reward claimed.'); return; }
    const r = await api('POST', '/missions/claim');
    missionState.data = r;
    const rw = r.reward || {};
    if (rw.kind === 'dltx' && rw.reward > 0) celebrate({ amount: rw.reward, title: 'Mission Reward!', subtitle: 'Straight to your wallet.', icon: '💎' });
    else if (rw.kind === 'energy' && rw.energyAwarded > 0) celebrate({ amount: rw.energyAwarded, unit: '⚡ Energy', title: 'Mission Reward!', subtitle: 'Non-monetary Energy added.', icon: '⚡' });
    else toast('Daily $DLTX cap reached — try again tomorrow.');
    await Promise.allSettled([loadWallet(), loadEnergy(), loadTx(), loadRewards()]);
    showRewardInterstitial();
    renderMissions();
  } catch (e) {
    if (e.data) { missionState.data = e.data; renderMissions(); }
    toast(e.message);
  } finally {
    missionState.busy = false;
    renderMissions();
  }
}

function resetMissionsUI() {
  missionState.data = null;
  missionState.busy = false;
  if (missionTimer) { clearInterval(missionTimer); missionTimer = null; }
}

$('missionActionBtn')?.addEventListener('click', completeMission);
$('missionClaimBtn')?.addEventListener('click', claimMissionReward);

// ==================== Deltix Vault (14 keys · 7 days) ====================
// A new key becomes available every 12 hours with a 1-hour collection window.
// Missed keys can be recovered (up to 2/cycle) with an extra rewarded ad.
// Collecting all 14 opens the Vault for one randomized mystery reward.
const vaultState = { data: null, busy: false };
let vaultTimer = null;
const VAULT_KEY_IMG = {
  collected: 'assets/vault/05_key_collected_gold.png',
  recovered: 'assets/vault/05_key_collected_gold.png',
  available: 'assets/vault/06_key_available_blue.png',
  locked: 'assets/vault/07_key_locked_dark.png',
  missed: 'assets/vault/08_key_missed_broken.png',
};

async function loadVault() {
  if (!state.token) return;
  try {
    vaultState.data = await api('GET', '/vault');
    renderVault();
    startVaultTimer();
  } catch { /* handled by api() */ }
}

function renderVault() {
  const d = vaultState.data;
  if (!d) return;
  const img = $('vaultImg');
  if (img && !img.classList.contains('vault-shake')) {
    img.src = (d.canOpen || d.opened) ? 'assets/vault/03_vault_open.png' : 'assets/vault/02_vault_closed.png';
  }
  setText('vaultProgress', `${d.collected} / ${d.totalKeys} keys`);

  const grid = $('vaultKeys');
  if (grid) {
    grid.innerHTML = d.keys.map((k) => `
      <div class="vkey ${k.status}" title="Day ${k.day} · ${k.status}" data-index="${k.index}">
        <img src="${VAULT_KEY_IMG[k.status] || VAULT_KEY_IMG.locked}" alt="${k.status} key" />
      </div>`).join('');
  }

  const collectBtn = $('vaultCollectBtn');
  const openBtn = $('vaultOpenBtn');
  const rec = $('vaultRecovery');

  if (d.canOpen) {
    if (collectBtn) collectBtn.hidden = true;
    if (openBtn) { openBtn.hidden = false; openBtn.disabled = vaultState.busy; }
    setText('vaultStatus', 'All 14 keys collected — open the Vault! 🔓');
  } else if (d.opened) {
    if (collectBtn) collectBtn.hidden = true;
    if (openBtn) openBtn.hidden = true;
    setText('vaultStatus', 'Vault opened! A fresh 7-day cycle has begun.');
  } else {
    if (openBtn) openBtn.hidden = true;
    if (collectBtn) {
      collectBtn.hidden = false;
      if (d.activeSlot >= 0) {
        collectBtn.disabled = vaultState.busy;
        collectBtn.textContent = 'Collect key 🔑';
        setText('vaultStatus', 'Your key is ready — collect it before the 1-hour window closes!');
      } else {
        collectBtn.disabled = true;
        collectBtn.textContent = `Next key in ${fmtCountdown(d.nextKeyInMs)}`;
        setText('vaultStatus', `${d.collected}/${d.totalKeys} collected · a new key every 12 hours.`);
      }
    }
  }

  if (rec) {
    if (d.canRecover) {
      rec.hidden = false;
      const missedKey = d.keys.find((k) => k.status === 'missed');
      rec.innerHTML = `You missed ${d.missed} key${d.missed > 1 ? 's' : ''}. <a href="#" id="vaultRecoverLink">Recover one</a> · ${d.recoveriesLeft} left this cycle.`;
      const link = $('vaultRecoverLink');
      if (link && missedKey) link.onclick = (e) => { e.preventDefault(); recoverKey(missedKey.index); };
    } else {
      rec.hidden = true;
    }
  }
}

function startVaultTimer() {
  if (vaultTimer) return;
  vaultTimer = setInterval(() => {
    if (!state.token || vaultState.busy) return;
    if (!document.getElementById('tab-rewards')?.classList.contains('active')) return;
    const d = vaultState.data;
    if (!d) return;
    if (d.activeSlot < 0 && !d.canOpen && !d.opened && d.nextKeyInMs > 0) {
      d.nextKeyInMs = Math.max(0, d.nextKeyInMs - 1000);
      if (d.nextKeyInMs === 0) { loadVault(); return; }
    }
    renderVault();
  }, 1000);
}

async function collectKey() {
  const d = vaultState.data;
  if (!d || vaultState.busy || d.activeSlot < 0) return;
  vaultState.busy = true;
  const btn = $('vaultCollectBtn');
  if (btn) btn.disabled = true;
  try {
    const earned = await playRewardedAd();
    if (!earned) { toast('Ad not completed — key not collected.'); return; }
    const r = await api('POST', '/vault/collect');
    vaultState.data = r;
    renderVault();
    try { window.ArcadeSound?.reward?.(); } catch {}
    if (r.canOpen) toast('🔓 14/14 keys collected — open the Vault!');
    else toast(`Key collected! ${r.collected}/${r.totalKeys} 🔑`);
  } catch (e) {
    if (e.data) { vaultState.data = e.data; renderVault(); }
    toast(e.message);
  } finally {
    vaultState.busy = false;
    renderVault();
  }
}

async function recoverKey(index) {
  const d = vaultState.data;
  if (!d || vaultState.busy || !d.canRecover) return;
  vaultState.busy = true;
  try {
    const earned = await playRewardedAd();
    if (!earned) { toast('Ad not completed — key not recovered.'); return; }
    const r = await api('POST', '/vault/recover', { index });
    vaultState.data = r;
    renderVault();
    toast(`Key recovered! ${r.collected}/${r.totalKeys} 🔑`);
  } catch (e) {
    if (e.data) { vaultState.data = e.data; renderVault(); }
    toast(e.message);
  } finally {
    vaultState.busy = false;
    renderVault();
  }
}

async function openVault() {
  const d = vaultState.data;
  if (!d || vaultState.busy || !d.canOpen) return;
  vaultState.busy = true;
  const btn = $('vaultOpenBtn');
  if (btn) btn.disabled = true;
  const img = $('vaultImg');
  if (img) img.classList.add('vault-shake');
  try {
    const earned = await playRewardedAd();
    if (!earned) { toast('Ad not completed — Vault not opened.'); if (img) img.classList.remove('vault-shake'); return; }
    const r = await api('POST', '/vault/open');
    vaultState.data = r;
    if (img) { img.classList.remove('vault-shake'); img.src = 'assets/vault/03_vault_open.png'; }
    const rw = r.reward || {};
    if (rw.kind === 'dltx' && rw.reward > 0) celebrate({ amount: rw.reward, title: 'Vault Opened! 🔓', subtitle: 'A $DLTX reward is yours.', icon: '💎' });
    else if (rw.kind === 'energy' && rw.energyAwarded > 0) celebrate({ amount: rw.energyAwarded, unit: '⚡ Energy', title: 'Vault Opened! 🔓', subtitle: 'Non-monetary Energy added.', icon: '⚡' });
    else toast('Vault opened — daily $DLTX cap reached, try the next cycle!');
    await Promise.allSettled([loadWallet(), loadEnergy(), loadTx()]);
    showRewardInterstitial();
    renderVault();
  } catch (e) {
    if (img) img.classList.remove('vault-shake');
    if (e.data) { vaultState.data = e.data; renderVault(); }
    toast(e.message);
  } finally {
    vaultState.busy = false;
    renderVault();
  }
}

function resetVaultUI() {
  vaultState.data = null;
  vaultState.busy = false;
  if (vaultTimer) { clearInterval(vaultTimer); vaultTimer = null; }
}

$('vaultCollectBtn')?.addEventListener('click', collectKey);
$('vaultOpenBtn')?.addEventListener('click', openVault);

// ==================== Global community globe ====================
const globeState = { data: null, rot: 0, raf: null };
// Approximate country centroids (lat, lon) for the globe markers. Country only.
const COUNTRY_POS = {
  US: [38, -97], CA: [56, -106], MX: [23, -102], BR: [-10, -55], AR: [-38, -63], CO: [4, -73], CL: [-35, -71], PE: [-9, -75],
  GB: [54, -2], IE: [53, -8], FR: [46, 2], ES: [40, -4], PT: [39, -8], DE: [51, 10], IT: [42, 12], NL: [52, 5], BE: [50, 4],
  CH: [47, 8], AT: [47, 14], SE: [62, 15], NO: [61, 8], FI: [64, 26], DK: [56, 9], PL: [52, 19], UA: [49, 32], RO: [46, 25],
  GR: [39, 22], TR: [39, 35], RU: [61, 90], NG: [9, 8], GH: [8, -1], KE: [0, 38], ZA: [-29, 24], EG: [26, 30], MA: [32, -6],
  DZ: [28, 2], ET: [9, 40], TZ: [-6, 35], UG: [1, 32], SA: [24, 45], AE: [24, 54], QA: [25, 51], IL: [31, 35], IR: [32, 53],
  IQ: [33, 44], PK: [30, 70], IN: [22, 79], BD: [24, 90], LK: [7, 81], NP: [28, 84], CN: [35, 105], JP: [36, 138],
  KR: [37, 128], TW: [24, 121], HK: [22, 114], PH: [13, 122], VN: [16, 108], TH: [15, 101], MY: [4, 102], SG: [1, 104],
  ID: [-2, 118], AU: [-25, 134], NZ: [-42, 172],
};
const COUNTRY_NAME = {
  US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', CO: 'Colombia', CL: 'Chile', PE: 'Peru',
  GB: 'United Kingdom', IE: 'Ireland', FR: 'France', ES: 'Spain', PT: 'Portugal', DE: 'Germany', IT: 'Italy', NL: 'Netherlands',
  BE: 'Belgium', CH: 'Switzerland', AT: 'Austria', SE: 'Sweden', NO: 'Norway', FI: 'Finland', DK: 'Denmark', PL: 'Poland',
  UA: 'Ukraine', RO: 'Romania', GR: 'Greece', TR: 'Türkiye', RU: 'Russia', NG: 'Nigeria', GH: 'Ghana', KE: 'Kenya',
  ZA: 'South Africa', EG: 'Egypt', MA: 'Morocco', DZ: 'Algeria', ET: 'Ethiopia', TZ: 'Tanzania', UG: 'Uganda', SA: 'Saudi Arabia',
  AE: 'UAE', QA: 'Qatar', IL: 'Israel', IR: 'Iran', IQ: 'Iraq', PK: 'Pakistan', IN: 'India', BD: 'Bangladesh', LK: 'Sri Lanka',
  NP: 'Nepal', CN: 'China', JP: 'Japan', KR: 'South Korea', TW: 'Taiwan', HK: 'Hong Kong', PH: 'Philippines', VN: 'Vietnam',
  TH: 'Thailand', MY: 'Malaysia', SG: 'Singapore', ID: 'Indonesia', AU: 'Australia', NZ: 'New Zealand',
};

function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '🌐';
  return cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// Coarse continent outlines ([lat, lon] polygons) so the globe reads as Earth.
// Rendered as filled land dots (point-in-polygon), which stays clean while the
// sphere rotates — no polygon-clipping artifacts at the horizon.
const LAND_POLYS = [
  // North America (+ Central America tail)
  [[66,-168],[71,-156],[71,-140],[70,-125],[58,-122],[55,-130],[48,-123],[40,-124],[33,-117],[24,-110],[18,-104],[16,-97],[15,-92],[10,-84],[9,-80],[14,-83],[18,-88],[22,-91],[26,-97],[29,-95],[29,-90],[30,-84],[25,-81],[28,-80],[35,-76],[40,-74],[45,-66],[47,-60],[51,-56],[60,-64],[62,-78],[60,-95],[66,-88],[70,-100],[72,-120],[72,-140],[71,-156],[66,-168]],
  // Greenland
  [[60,-45],[60,-25],[66,-18],[72,-20],[78,-30],[82,-45],[82,-58],[73,-55],[66,-48],[60,-45]],
  // South America
  [[11,-72],[10,-62],[5,-53],[0,-50],[-5,-38],[-8,-35],[-13,-38],[-20,-40],[-25,-48],[-34,-53],[-40,-62],[-45,-66],[-52,-71],[-54,-72],[-46,-73],[-38,-72],[-30,-71],[-23,-70],[-18,-71],[-14,-76],[-6,-81],[0,-80],[5,-77],[8,-77],[11,-72]],
  // Africa
  [[35,-6],[36,0],[37,10],[33,11],[31,19],[31,25],[30,32],[27,35],[16,40],[12,43],[11,48],[5,45],[-2,42],[-10,40],[-18,35],[-26,32],[-34,26],[-35,20],[-29,16],[-23,13],[-17,12],[-9,9],[-1,9],[4,6],[5,-4],[8,-8],[15,-16],[21,-16],[28,-12],[33,-9],[35,-6]],
  // Europe
  [[36,-10],[44,-9],[44,-2],[48,2],[51,-5],[52,0],[54,8],[58,10],[60,6],[64,10],[66,16],[70,22],[71,28],[66,30],[60,28],[58,32],[55,33],[50,38],[46,40],[45,30],[45,20],[46,16],[44,13],[40,16],[41,19],[38,16],[37,12],[44,8],[43,3],[43,-2],[40,-9],[36,-10]],
  // Asia (coarse; longitudes capped below 180)
  [[38,36],[42,40],[45,50],[42,55],[30,52],[25,57],[25,60],[37,58],[40,62],[38,68],[35,70],[30,66],[26,62],[25,66],[24,68],[22,70],[8,77],[7,80],[13,80],[15,74],[20,72],[22,89],[16,94],[10,98],[8,100],[10,104],[14,109],[18,108],[21,106],[22,113],[30,122],[35,126],[39,127],[43,132],[46,142],[52,141],[60,160],[62,178],[68,178],[73,140],[76,110],[78,75],[70,60],[66,55],[60,48],[52,50],[48,48],[45,40],[42,36],[38,36]],
  // India peninsula (fill)
  [[24,68],[26,72],[22,88],[16,80],[8,77],[15,73],[20,70],[24,68]],
  // Arabia
  [[30,35],[30,48],[24,60],[13,45],[13,43],[17,42],[22,39],[26,36],[30,35]],
  // Southeast Asia / Indonesia
  [[6,95],[7,100],[2,104],[-6,106],[-8,115],[-8,120],[-5,120],[-2,117],[2,110],[5,98],[6,95]],
  // Australia
  [[-11,131],[-12,142],[-19,147],[-28,153],[-38,146],[-38,140],[-32,133],[-35,124],[-33,116],[-22,114],[-15,124],[-11,131]],
  // Japan
  [[31,131],[35,140],[41,141],[38,138],[34,132],[31,131]],
  // United Kingdom
  [[50,-5],[54,-3],[58,-5],[57,-2],[52,1],[50,-5]],
  // Madagascar
  [[-12,49],[-16,50],[-25,47],[-22,44],[-15,44],[-12,49]],
  // New Zealand
  [[-35,173],[-41,175],[-46,168],[-44,169],[-38,174],[-35,173]],
];

function pointInPolys(lat, lon) {
  for (const poly of LAND_POLYS) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

// Precompute land points once (a dotted world map) for the rotating globe.
const LAND_DOTS = (() => {
  const dots = [];
  for (let lat = -56; lat <= 78; lat += 2.5) {
    for (let lon = -180; lon < 180; lon += 2.5) {
      if (pointInPolys(lat, lon)) dots.push([lat, lon]);
    }
  }
  return dots;
})();

function hashPos(cc) {
  let h = 0;
  for (const ch of String(cc)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [(h % 130) - 65, ((h >> 3) % 360) - 180];
}

async function loadGlobe() {
  if (!state.token) return;
  try {
    const r = await api('GET', '/network/globe');
    globeState.data = r;
    renderGlobe();
    startGlobe();
  } catch { /* handled by api() */ }
}

function renderGlobe() {
  const d = globeState.data;
  if (!d) return;
  setText('globeTotal', fmtInt(d.totalUsers));
  // Show the top countries, then roll everyone else (untruncated + not-yet-located)
  // into a single "Other regions" row so the breakdown always sums to the total.
  const rows = (d.countries || []).slice(0, 12).map((c) => ({
    flag: flagEmoji(c.country),
    name: COUNTRY_NAME[c.country] || c.country,
    users: Number(c.users) || 0,
  }));
  const el = $('globeCountries');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<p class="muted center">Be one of the first on the map — invite your country!</p>';
    return;
  }
  const other = Math.max(0, Number(d.totalUsers || 0) - rows.reduce((s, r) => s + r.users, 0));
  if (other > 0) rows.push({ flag: '🌐', name: 'Other regions', users: other });
  const max = rows.reduce((m, r) => Math.max(m, r.users), 1);
  el.innerHTML = rows.map((r) => `
      <div class="globe-country">
        <span class="gc-flag">${r.flag}</span>
        <span class="gc-name">${r.name}</span>
        <span class="gc-bar"><span style="width:${Math.max(6, Math.round((r.users / max) * 100))}%"></span></span>
        <span class="gc-count">${fmtInt(r.users)}</span>
      </div>`).join('');
}

function drawGlobe() {
  const canvas = $('communityGlobe');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, cx = W / 2, cy = W / 2, R = W / 2 - 10;
  const rot = globeState.rot;
  const project = (lat, lon) => {
    const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180 + rot;
    return { x: cx + Math.cos(phi) * Math.sin(lam) * R, y: cy - Math.sin(phi) * R, z: Math.cos(phi) * Math.cos(lam) };
  };
  ctx.clearRect(0, 0, W, W);
  const grad = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.2, cx, cy, R);
  grad.addColorStop(0, '#3b82f6');
  grad.addColorStop(1, '#0f2b6b');
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  // Land dots (continents) — front hemisphere only, with a subtle depth fade.
  for (let i = 0; i < LAND_DOTS.length; i++) {
    const p = project(LAND_DOTS[i][0], LAND_DOTS[i][1]);
    if (p.z <= 0.02) continue;
    const a = 0.35 + p.z * 0.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(134, 239, 172, ${a.toFixed(3)})`;
    ctx.fill();
  }
  // Country markers
  const d = globeState.data;
  if (d && d.countries) {
    d.countries.forEach((c) => {
      const pos = COUNTRY_POS[c.country] || hashPos(c.country);
      const p = project(pos[0], pos[1]);
      if (p.z <= 0) return;
      const rr = 3 + Math.min(9, Math.log2(c.users + 1) * 1.6);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(251,191,36,.92)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function startGlobe() {
  if (globeState.raf) return;
  const loop = () => {
    if (document.getElementById('tab-community')?.classList.contains('active')) {
      globeState.rot += 0.004;
      drawGlobe();
    }
    globeState.raf = requestAnimationFrame(loop);
  };
  globeState.raf = requestAnimationFrame(loop);
}

// ==================== Country Leaderboard + Deltix Passport ====================
const communityState = { lbScope: 'country', lbData: null, passport: null };
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

async function loadLeaderboard() {
  if (!state.token) return;
  try {
    const r = await api('GET', `/community/leaderboard?scope=${communityState.lbScope}`);
    communityState.lbData = r;
    renderLeaderboard();
  } catch { /* handled by api() */ }
}

function renderLeaderboard() {
  const d = communityState.lbData;
  document.querySelectorAll('[data-lbscope]').forEach((b) =>
    b.classList.toggle('active', b.dataset.lbscope === communityState.lbScope));
  if (!d) return;

  const you = $('lbYou');
  if (you) {
    if (d.you && d.you.scopeRank) {
      const where = communityState.lbScope === 'country'
        ? (d.country ? `${flagEmoji(d.country)} ${COUNTRY_NAME[d.country] || d.country}` : 'your country')
        : 'the world';
      you.innerHTML = `You're <b>${ordinal(d.you.scopeRank)}</b> of ${fmtInt(d.you.scopeSize)} in ${where} · <b>${fmtInt(d.you.xp)}</b> XP`;
    } else {
      you.textContent = 'Play games and check in daily to climb the ranks.';
    }
  }

  const list = $('lbList');
  if (list) {
    if (communityState.lbScope === 'country' && !d.country) {
      list.innerHTML = '<p class="muted center">Your country isn\u2019t on the map yet — it\u2019s detected on your next sign-in.</p>';
    } else if (!d.top || !d.top.length) {
      list.innerHTML = '<p class="muted center">No ranked players yet. Be the first!</p>';
    } else {
      list.innerHTML = d.top.map((p) => `
        <div class="lb-row${p.isYou ? ' me' : ''}">
          <span class="lb-rank lb-rank-${p.rank <= 3 ? p.rank : 'n'}">${p.rank <= 3 ? ['🥇', '🥈', '🥉'][p.rank - 1] : p.rank}</span>
          <span class="lb-flag">${p.country ? flagEmoji(p.country) : '🌐'}</span>
          <span class="lb-name">${p.handle}${p.isYou ? ' <span class="lb-badge-you">You</span>' : ''}</span>
          <span class="lb-xp">${fmtInt(p.xp)} XP</span>
        </div>`).join('');
    }
  }

  const cel = $('lbCountries');
  if (cel) {
    cel.innerHTML = (d.countries || []).slice(0, 10).map((c) => `
      <div class="lb-country">
        <span class="lbc-rank">${c.rank}</span>
        <span class="lb-flag">${flagEmoji(c.country)}</span>
        <span class="lb-name">${COUNTRY_NAME[c.country] || c.country}</span>
        <span class="lbc-meta">${fmtInt(c.members)} 👥 · ${fmtInt(c.xp)} XP</span>
      </div>`).join('') || '<p class="muted center">Countries appear as members join the map.</p>';
  }
}

async function loadPassport() {
  if (!state.token) return;
  try {
    const r = await api('GET', '/community/passport');
    communityState.passport = r;
    renderPassport();
  } catch { /* handled by api() */ }
}

function renderPassport() {
  const d = communityState.passport;
  if (!d) return;
  setText('ppStamps', `${d.stampsEarned}/${d.stampsTotal}`);
  setText('ppMedals', `${d.medalsEarned}/${d.medalsTotal}`);
  setText('ppStreak', fmtInt(d.longestStreak || 0));

  const mg = $('ppMedalsGrid');
  if (mg) {
    mg.innerHTML = (d.medals || []).map((m) => `
      <div class="pp-medal${m.earned ? ' earned' : ''}" title="${m.name} — ${m.tagline}">
        <span class="ppm-icon">${m.earned ? m.icon : '🔒'}</span>
        <span class="ppm-name">${m.name.replace('Deltix ', '')}</span>
        <span class="ppm-days">${m.earned ? 'Unlocked' : m.days + 'd'}</span>
      </div>`).join('');
  }

  const sg = $('ppStampsGrid');
  if (sg) {
    sg.innerHTML = (d.stamps || []).map((s) => `
      <div class="pp-stamp${s.earned ? ' earned' : ''}" title="${s.name} — ${s.desc}">
        <span class="pps-icon">${s.earned ? s.icon : '🔒'}</span>
        <span class="pps-name">${s.name}</span>
        ${!s.earned && s.target ? `<span class="pps-prog">${fmtInt(s.progress || 0)}/${fmtInt(s.target)}</span>` : `<span class="pps-prog">${s.earned ? 'Earned' : ''}</span>`}
      </div>`).join('');
  }
}

document.querySelectorAll('[data-lbscope]').forEach((b) =>
  b.addEventListener('click', () => {
    if (communityState.lbScope === b.dataset.lbscope) return;
    communityState.lbScope = b.dataset.lbscope;
    renderLeaderboard();
    loadLeaderboard();
  })
);

function resetCommunityUI() {
  communityState.lbScope = 'country';
  communityState.lbData = null;
  communityState.passport = null;
  const list = $('lbList'); if (list) list.innerHTML = '<p class="muted center">Loading rankings…</p>';
  const you = $('lbYou'); if (you) you.textContent = 'Play games and check in daily to climb the ranks.';
  setText('ppStamps', '0/0'); setText('ppMedals', '0/0'); setText('ppStreak', '0');
  const mg = $('ppMedalsGrid'); if (mg) mg.innerHTML = '';
  const sg = $('ppStampsGrid'); if (sg) sg.innerHTML = '';
}

/** Opt-in rewarded ad. Resolves true only on the SDK's own reward callback.
 *  Rewards must stay non-transferable in-app benefits (never $DLTX). */
function playRewardedAd() {
  return new Promise((resolve) => {
    if (!ADS_ENABLED) return resolve(false);
    const cap = window.Capacitor;
    const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
    if (cap && cap.isNativePlatform && cap.isNativePlatform() && AdMob) {
      let earned = false, settled = false;
      let handles = [];
      const cleanup = () => handles.forEach((h) => h?.remove?.());
      const finish = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };
      Promise.all([
        AdMob.addListener('onRewardedVideoAdReward', () => { earned = true; }),
        AdMob.addListener('onRewardedVideoAdDismissed', () => finish(earned)),
        AdMob.addListener('onRewardedVideoAdFailedToShow', () => finish(false)),
      ]).then((hs) => { handles = hs; });
      AdMob.prepareRewardVideoAd({ adId: ADMOB_REWARDED_ID, isTesting: ADMOB_TESTING })
        .then(() => AdMob.showRewardVideoAd())
        .then((item) => { if (item) earned = true; }) // showRewardVideoAd resolves with the reward item
        .catch(() => finish(false));
      return;
    }
    // Web / dev fallback — disclosed simulated ad so the flow is testable.
    if (!confirm('▶ Simulated rewarded ad (web preview)\n\nOn a real device this plays a full AdMob rewarded video. Continue?')) {
      return resolve(false);
    }
    setTimeout(() => resolve(true), 600);
  });
}

// ---------- Hardware / browser back button ----------
// A sentinel history entry absorbs the back press so we can close the topmost
// overlay (or return to the Wallet tab) instead of exiting the app.
const BACK_SENTINEL = { deltix: true };
let exitArmed = false;
function closeTopOverlay() {
  for (const id of ['swapModal', 'dappModal', 'stakeModal', 'sendModal', 'deleteModal']) {
    const el = document.getElementById(id);
    if (el && !el.hidden) { el.hidden = true; return true; }
  }
  const game = document.getElementById('gameModal');
  if (game && !game.hidden) { window.closeGame?.(); return true; }
  const instant = document.getElementById('instantModal');
  if (instant && !instant.hidden) { window.closeInstantGame?.(); return true; }
  if (!$('dappPage').hidden) { closeDappPage(); return true; }
  if (!$('explorer').hidden) {
    if (exp.stack.length > 1) { exp.stack.pop(); expRender(); } else closeExplorer();
    return true;
  }
  if (!$('dbrowser').hidden) {
    if (dbState.index > 0) goDbBack(); else closeDBrowser();
    return true;
  }
  return false;
}
history.replaceState(BACK_SENTINEL, '');
history.pushState(BACK_SENTINEL, '');
window.addEventListener('popstate', () => {
  if (closeTopOverlay()) { history.pushState(BACK_SENTINEL, ''); return; }
  const onMain = $('screen-main').classList.contains('active');
  const tab = document.querySelector('.tab.active')?.id;
  if (onMain && tab && tab !== 'tab-wallet') {
    showTab('tab-wallet');
    history.pushState(BACK_SENTINEL, '');
    return;
  }
  if (!exitArmed) {
    exitArmed = true;
    toast('Press back again to exit');
    setTimeout(() => {
      exitArmed = false;
      history.pushState(BACK_SENTINEL, ''); // re-arm the sentinel if the user stayed
    }, 2000);
  }
});

// ---------- Boot ----------
(async function boot() {
  // Run the version check in parallel instead of blocking launch on it: it
  // self-shows the forced-update gate if needed, and the server also rejects
  // outdated clients with 426 — so we save a full round-trip off the critical
  // path (a big deal on cold starts / slow mobile networks).
  checkAppVersion();
  initAds();
  initPullToRefresh();
  if (state.token) {
    try {
      await enterApp();
      return;
    } catch (err) {
      console.warn('Initial app boot load encountered an error:', err);
      // Only wipe the token if api() deemed it 401/expired and cleared state.token.
      // If state.token is still present (e.g. offline/network glitch on launch), keep
      // the user signed in on screen-main rather than logging them out.
      if (state.token) {
        showScreen('screen-main');
        showTab('tab-wallet', { refresh: false });
        renderProfile();
        toast('Offline mode — slide down to refresh when connected');
        return;
      }
    }
  }
  showScreen('screen-email');
})();
