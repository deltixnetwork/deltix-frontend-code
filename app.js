'use strict';

// In the native app shell (Capacitor) there is no same-origin backend —
// point at the production API instead.
const API = window.Capacitor ? 'https://app.deltixllc.com/api' : '/api';
const APP_VERSION = '1.19.1';
const $ = (id) => document.getElementById(id);

// Stable per-phone identifier sent with every request (X-Device-Id) — the
// server caps how many accounts one device can create. Prefers the native
// hardware-backed id when a Device plugin is available; otherwise a UUID
// persisted for the lifetime of the install.
function getDeviceId() {
  let id = localStorage.getItem('dltx_device_id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem('dltx_device_id', id);
  }
  return id;
}
try {
  // Upgrade to the hardware-backed identifier once, if the plugin exists.
  window.Capacitor?.Plugins?.Device?.getId?.().then((r) => {
    const nativeId = r && (r.identifier || r.uuid);
    if (nativeId) localStorage.setItem('dltx_device_id', String(nativeId).slice(0, 64));
  }).catch(() => {});
} catch { /* device id stays the local UUID */ }

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

// Global ChatRoom state — declared up here because showTab() (which stops chat
// polling) runs during boot, before the chat section further down is evaluated.
const globalChatState = {
  messages: [],   // server messages, ascending by id
  pending: [],    // optimistic sends not yet acknowledged
  pinned: null,
  muted: [],      // staff only: opaque ids (uid) of currently muted members
  presence: { online: 0, seen: {} },   // seen: uid -> 'o' online | 'h' hidden | epoch-ms last seen
  adBusy: false,
  fast: false,    // next sync is a quick one (after a (re)start) instead of a long-poll
  room: { type: 'global' },   // which conversation is open: { type: 'global' } or { type: 'group', id, title }
  group: null,    // the open group's details (title, about, role, memberCount, inviteCode…) from the server
  listOpen: false,// the chat list is showing instead of a conversation
  groups: [],     // my groups, for the chat list
  view: null,     // { top, stick } remembered while the chat tab is hidden
  me: null,       // { role, energy, cost, canChat, mute } as reported by the server
  epoch: '',
  rev: 0,
  gen: 0,         // sync-loop generation: bumping it cancels the running loop
  running: false,
  failures: 0,
  available: true,
  loaded: false,
  replyTo: null,
  unread: 0,
  stick: true,
};

// Predict screen state — declared up here for the same reason: showTab() (which stops the Predict
// timers) runs during boot, before the Predict section further down is evaluated.
const predictState = { markets: null, mine: null, board: null, coin: 'BTC', horizon: 60, filter: 'all', busy: false, claiming: false, poll: null, tick: null, loaded: false, lastChart: '', stake: 10 };
// Accounts saved on this phone so a member can switch without a new email code (declared early: showScreen() paints them).
const SAVED_ACCOUNTS_KEY = 'dltx_accounts';
const MAX_SAVED_ACCOUNTS = 4;   // the same cap as accounts per device

// ---------- API helper ----------
// Self-healing session: if the server ever reports the session/wallet as
// gone (stale token, or — in local dev — a server restart that wiped
// in-memory data), sign the user out and return to the sign-in screen
// instead of leaving stale cached numbers on screen.
//
// Mobile networks drop requests and hosts restart, so idempotent reads are
// retried briefly before the user ever sees an error.
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_BACKOFF_MS = 600;
// A single request must never hang the UI — a stalled server is retried, not waited on.
const REQUEST_TIMEOUT_MS = 20000;

// ── Centralized error classification ──
// The category decides the wording. "No internet" is ONLY claimed when the
// device reports itself offline; any HTTP status means the server was reached.
const ERROR_CATEGORY = {
  OFFLINE: 'offline', CONNECT: 'connect', TIMEOUT: 'timeout', AUTH: 'auth', FORBIDDEN: 'forbidden',
  RATE_LIMIT: 'rate_limit', NOT_FOUND: 'not_found', CLIENT: 'client', SERVER: 'server', UNAVAILABLE: 'unavailable',
};
function classifyHttp(status) {
  if (status === 401) return ERROR_CATEGORY.AUTH;
  if (status === 403 || status === 423) return ERROR_CATEGORY.FORBIDDEN;
  if (status === 429) return ERROR_CATEGORY.RATE_LIMIT;
  if (status === 404) return ERROR_CATEGORY.NOT_FOUND;
  if (status === 502 || status === 503 || status === 504) return ERROR_CATEGORY.UNAVAILABLE;
  if (status >= 500) return ERROR_CATEGORY.SERVER;
  return ERROR_CATEGORY.CLIENT;
}
const GENERIC_BY_CATEGORY = {
  [ERROR_CATEGORY.OFFLINE]: 'You\u2019re offline. Check your internet connection and try again.',
  [ERROR_CATEGORY.CONNECT]: 'Deltix couldn\u2019t connect to the server. Please try again.',
  [ERROR_CATEGORY.TIMEOUT]: 'Deltix is taking longer than expected. Please try again.',
  [ERROR_CATEGORY.AUTH]: 'Your session has expired — please sign in again.',
  [ERROR_CATEGORY.FORBIDDEN]: 'This action isn\u2019t available for this account.',
  [ERROR_CATEGORY.RATE_LIMIT]: 'Too many requests. Please wait a moment and try again.',
  [ERROR_CATEGORY.NOT_FOUND]: 'That is not available right now.',
  [ERROR_CATEGORY.CLIENT]: 'Something went wrong. Please try again.',
  [ERROR_CATEGORY.SERVER]: 'Something went wrong on our side. Please try again.',
  [ERROR_CATEGORY.UNAVAILABLE]: 'Deltix is temporarily unavailable. Please try again shortly.',
};
// Server messages are already user-facing (device limit, KYC, restrictions…)
// and take precedence; the `ref` lets support find the exact server log line.
function friendlyError(status, json) {
  const base = (json && json.error) || GENERIC_BY_CATEGORY[classifyHttp(status)];
  return json && json.ref ? `${base} (Ref: ${json.ref})` : base;
}
// Bounded backoff with jitter so a fleet of phones never retries in lockstep.
const backoffMs = (attempt) => RETRY_BACKOFF_MS * (attempt + 1) + Math.floor(Math.random() * 300);
const newRequestId = () => 'DLX-' + Math.random().toString(16).slice(2, 8).toUpperCase();

async function api(method, path, body, { retries = method === 'GET' ? 3 : 0 } = {}) {
  let res = null;
  let failure = null; // ERROR_CATEGORY when fetch itself rejected
  const requestId = newRequestId();
  for (let attempt = 0; ; attempt++) {
    failure = null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Deltix-Client': 'deltix-app',
          'X-App-Version': APP_VERSION,
          'X-Device-Id': getDeviceId(),
          'X-Request-Id': requestId,
          ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch (e) {
      const offlineNow = typeof navigator !== 'undefined' && navigator.onLine === false;
      failure = offlineNow ? ERROR_CATEGORY.OFFLINE
        : (e && e.name === 'AbortError') ? ERROR_CATEGORY.TIMEOUT
        : ERROR_CATEGORY.CONNECT; // DNS / TLS / reset — the server was NOT reached
    } finally {
      if (timer) clearTimeout(timer);
    }
    const transient = failure !== null || RETRY_STATUSES.has(res.status);
    if (!transient || attempt >= retries) break;
    await new Promise((r) => setTimeout(r, backoffMs(attempt)));
  }
  if (failure) {
    const err = new Error(`${GENERIC_BY_CATEGORY[failure]} (Ref: ${requestId})`);
    err.offline = failure === ERROR_CATEGORY.OFFLINE;
    err.category = failure;
    err.ref = requestId;
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
      const shopModal = $('shopModal');
      if (shopModal && !shopModal.hidden && typeof window.closeShop === 'function') window.closeShop();
      const puzzleModal = $('puzzleModal');
      if (puzzleModal && !puzzleModal.hidden && typeof window.closePuzzle === 'function') window.closePuzzle();
      if (state.token) {
        if (typeof forgetAccount === 'function') forgetAccount(state.email);   // that login is dead; it needs a new code
        clearAccountSession();
        showScreen('screen-email');
        toast('Your session has expired — please sign in again.');
      }
    }
    const err = new Error(friendlyError(res.status, json));
    err.status = res.status;
    err.category = classifyHttp(res.status);
    err.ref = (json && json.ref) || requestId;
    err.code = (json && json.code) || null;
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
  flushPendingCompletions();
  // Back from the background: make sure a fresh rewarded ad is ready (a stale or failed one is replaced).
  if (state.token && typeof preloadRewardedAd === 'function' && adsReady && !adState.playing) preloadRewardedAd();
  if (state.token && $('screen-main')?.classList.contains('active')) {
    refreshCurrentView({ silent: true });
    loadEarn();
    if (typeof checkMysteryHour === 'function') checkMysteryHour();
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) onAppResumed();
});
window.addEventListener('online', () => { if (state.token) loadEarn(); });

// Capacitor native app lifecycle resume
try {
  window.Capacitor?.Plugins?.App?.addListener('appStateChange', ({ isActive }) => {
    if (isActive) onAppResumed();
  });
} catch {}

// ---------- Resilient arcade-completion queue ----------
// A finished game's result can fail to save if the database blips or the
// device goes offline right at that moment. Rather than let that win vanish,
// it is queued here (localStorage survives even a full app close) and
// retried automatically the next time the app is online or comes back to the
// foreground — so a real game result is never simply lost to a transient
// outage. arcade.js calls queuePendingCompletion() only after its own
// in-modal retries are exhausted; dropPendingCompletion() removes an entry
// once it settles (manually or via a flush) so it is never resent forever.
const PENDING_COMPLETIONS_KEY = 'dltx_pending_completions';
function loadPendingCompletions() {
  try { return JSON.parse(localStorage.getItem(PENDING_COMPLETIONS_KEY) || '[]'); } catch { return []; }
}
function savePendingCompletions(list) {
  try { localStorage.setItem(PENDING_COMPLETIONS_KEY, JSON.stringify(list)); } catch {}
}
function queuePendingCompletion(sessionId, payload) {
  const list = loadPendingCompletions().filter((p) => p.sessionId !== sessionId);
  list.push({ sessionId, payload, queuedAt: Date.now() });
  savePendingCompletions(list);
}
function dropPendingCompletion(sessionId) {
  savePendingCompletions(loadPendingCompletions().filter((p) => p.sessionId !== sessionId));
}
let flushingCompletions = false;
async function flushPendingCompletions() {
  if (flushingCompletions || !state.token) return;
  const list = loadPendingCompletions();
  if (!list.length) return;
  flushingCompletions = true;
  const remaining = [];
  let recovered = 0;
  for (const item of list) {
    // A day-old queued result belongs to a session the server has long since
    // expired — stop retrying it rather than queue forever.
    if (Date.now() - item.queuedAt > 24 * 3600 * 1000) continue;
    try {
      const extra = item.payload.won ? await getIntegrityPayload() : {};
      const r = await api('POST', `/arcade/session/${item.sessionId}/complete`, { ...item.payload, ...extra }, { retries: 1 });
      if (r.won && r.reward > 0) recovered += r.reward;
    } catch (e) {
      // 400/404 = the session was already settled or no longer exists — safe
      // to drop. Anything else (still offline/5xx) stays queued for later.
      if (e.status !== 400 && e.status !== 404) remaining.push(item);
    }
  }
  savePendingCompletions(remaining);
  flushingCompletions = false;
  if (recovered > 0) {
    (window.celebrate || toast)({
      amount: recovered,
      title: 'Reward recovered! 🏆',
      subtitle: 'A game result that couldn\u2019t save earlier just went through.',
      icon: '🏆',
    });
    Promise.all([loadWallet(), loadTx()]).catch(() => {});
  }
}
window.addEventListener('online', flushPendingCompletions);
window.queuePendingCompletion = queuePendingCompletion;
window.dropPendingCompletion = dropPendingCompletion;
window.flushPendingCompletions = flushPendingCompletions;

// ---------- UI helpers ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  const authed = id === 'screen-main';
  $('topbar').hidden = !authed;
  document.body.classList.toggle('authed', authed);
  closeSidenav();
  if (id === 'screen-email' && typeof paintSavedLogin === 'function') paintSavedLogin();
  if (!authed) {
    document.body.classList.remove('has-ad-banner');
    const cap = window.Capacitor;
    if (cap?.Plugins?.AdMob) cap.Plugins.AdMob.hideBanner().catch(() => {});
  } else {
    updateTabAd();
    requestAnimationFrame(() => { if (typeof updateNavMetrics === 'function') updateNavMetrics(); });
  }
}

function showTab(id, { refresh = true } = {}) {
  if (typeof chatSaveView === 'function') chatSaveView();
  navSaveScroll();
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  $(id).classList.add('active');
  document.querySelectorAll('.tabbtn, .sidenav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === id)
  );
  updateTabAd(id);
  navRecord(id);
  syncNavSelection(id);
  if (id !== 'tab-chatroom') stopChatPolling();
  if (id !== 'tab-predict' && typeof stopPredictPolling === 'function') stopPredictPolling();
  if (id !== 'tab-p2p' && typeof stopP2pAdminsPoll === 'function') stopP2pAdminsPoll();
  if (id === 'tab-energy') {
    renderEnergy();
    if (state.token) loadEnergy();
  } else if (id === 'tab-faq') {
    if (typeof renderFaq === 'function') renderFaq();
  } else if (id === 'tab-missions') {
    renderMissions();
    if (state.token) loadMissions();
  } else if (id === 'tab-earn') {
    // Start timer when earn tab is opened
    if (typeof startNextEarnTimer === 'function') startNextEarnTimer();
    if (refresh && state.token) loadEarn();
  } else if (id === 'tab-chatroom') {
    if (typeof renderGlobalChatroom === 'function') renderGlobalChatroom();
  } else if (id === 'tab-predict') {
    if (typeof renderPredict === 'function') renderPredict();
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
    Promise.allSettled([loadGovernance(), loadReferrals(), loadGlobe(), loadLeaderboard(), loadSeason()]);
  } else if (id === 'tab-rewards') {
    loadRewards().catch(() => {});
    loadPuzzle().catch(() => {});
    loadDailyChallenge().catch(() => {});
  } else if (id === 'tab-network') {
    Promise.allSettled([loadChain(), loadStats()]);
  } else if (id === 'tab-energygames') {
    if (typeof renderInstantGames === 'function') renderInstantGames();
    loadEnergy().then(() => { if (typeof renderInstantGames === 'function') renderInstantGames(); }).catch(() => {});
  } else if (id === 'tab-games') {
    loadEnergy().catch(() => {});
  } else if (id === 'tab-game-wheel') {
    loadRewards().catch(() => {});
  } else if (id === 'tab-game-ladder') {
    renderDailyLadder();
    loadEnergy().catch(() => {});
  } else if (id === 'tab-shop') {
    loadShop().catch(() => {});
  } else if (id === 'tab-leaderboard') {
    loadLeaderboard().catch(() => {});
  } else if (id === 'tab-ranking') {
    loadPassport().catch(() => {});
  } else if (id === 'tab-earn') {
    loadEarn().catch(() => {});
  } else if (id === 'tab-energy-delegation') {
    loadEnergyDelegation();
  } else if (id === 'tab-p2p') {
    loadP2p().catch(() => {});
  } else if (id === 'tab-assistant') {
    ensureBotGreeting();
    loadKycStatus().catch(() => {});
  } else if (id === 'tab-chatroom') {
    if (typeof renderGlobalChatroom === 'function') renderGlobalChatroom();
  } else if (id === 'tab-social') {
    if (typeof loadFollowState === 'function') loadFollowState();
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
    tasks.push(loadGovernance(), loadReferrals(), loadGlobe(), loadLeaderboard(), loadSeason());
  } else if (activeTab === 'tab-leaderboard') {
    tasks.push(loadLeaderboard());
  } else if (activeTab === 'tab-ranking') {
    tasks.push(loadPassport());
  } else if (activeTab === 'tab-arcade') {
    if (typeof loadArcade === 'function') tasks.push(loadArcade());
  } else if (activeTab === 'tab-network') {
    tasks.push(loadChain());
  } else if (activeTab === 'tab-energy') {
    tasks.push(loadEnergy());
  } else if (activeTab === 'tab-rewards') {
    tasks.push(loadRewards(), loadDailyChallenge());
  } else if (activeTab === 'tab-game-wheel') {
    tasks.push(loadRewards());
  } else if (activeTab === 'tab-game-ladder' || activeTab === 'tab-games') {
    tasks.push(loadEnergy());
  } else if (activeTab === 'tab-missions') {
    tasks.push(loadMissions());
  } else if (activeTab === 'tab-earn') {
    tasks.push(loadEarn());
  } else if (activeTab === 'tab-p2p') {
    tasks.push(loadP2p());
  } else if (activeTab === 'tab-assistant') {
    tasks.push(loadKycStatus());
  } else if (activeTab === 'tab-chatroom') {
    if (typeof renderGlobalChatroom === 'function') {
      tasks.push(Promise.resolve().then(() => renderGlobalChatroom()));
    }
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
    const overlays = ['gameModal', 'instantModal', 'shopModal', 'puzzleModal', 'dbrowser', 'explorer', 'dappPage', 'stakeModal', 'edDelegateModal', 'edUndelegateModal', 'sendModal', 'deleteModal', 'swapModal', 'dappModal', 'p2pCreateModal', 'p2pOfferModal', 'p2pOrderModal', 'p2pTraderModal', 'p2pImgModal', 'p2pEditModal'];
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

// ---------- Professional notification toasts ----------
// Every quick notification renders as a branded card (icon badge + ◆ DELTIX
// label + message) instead of a plain text pill. The tone drives the badge:
// success (✓ green), error (⚠ red), warning (⚠ amber), info (◆ blue). When a
// call site doesn't pass a tone it is inferred from the message so the ~100
// existing toast() calls (including arcade.js) upgrade automatically.
const TOAST_TONE_ICONS = { success: '✓', error: '⚠', warning: '⚠', info: '◆' };
const TOAST_ERROR_RE = /fail|error|invalid|insufficient|not enough|unavailable|try again|wrong|cannot|can[’']?t\b|denied|blocked|locked|expired|too many|too fast|missing|unauthori[sz]|not found|no longer|paused|rejected|already|nothing to|\bneed(s|ed)?\b|unable|not permitted|not available|no connection|offline/i;
const TOAST_SUCCESS_RE = /copied|sent\b|saved|created|claimed|delegated|undelegated|unstaked|unlocked|recovered|success|complete|watered|redeemed|purchased|activated|updated|joined|submitted|confirmed|staked|applied|added|welcome|verified|granted|equipped|planted|deleted|restored|refreshed/i;
function toastTone(msg) {
  if (TOAST_ERROR_RE.test(msg)) return 'error';
  if (TOAST_SUCCESS_RE.test(msg)) return 'success';
  return 'info';
}
let toastTimer;
function toast(msg, opts = {}) {
  const t = $('toast');
  if (!t) return;
  let message = String(msg || '');
  // Every "Ad not completed — …" notice names the real reason (offline, no ad, timed out…)
  // unless the member simply closed the ad themselves.
  const last = window.lastAdResult;
  if (/^Ad not completed/i.test(message) && last && !last.earned && last.reason !== 'closed' && Date.now() - last.at < 4000) {
    message = adFailureText(last.reason);
  }
  const tone = opts.tone || toastTone(message);
  const icon = opts.icon || TOAST_TONE_ICONS[tone] || TOAST_TONE_ICONS.info;
  t.className = `toast t-${tone}`;
  t.setAttribute('role', 'status');
  t.setAttribute('aria-live', 'polite');
  t.innerHTML = `
    <div class="tn-icon">${icon}</div>
    <div class="tn-body">
      <div class="tn-app">◆ Deltix${opts.title ? ` · <span class="tn-title">${opts.title}</span>` : ''}</div>
      <div class="tn-msg"></div>
    </div>`;
  t.querySelector('.tn-msg').textContent = message;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  t.onclick = () => { clearTimeout(toastTimer); t.classList.remove('show'); setTimeout(() => (t.hidden = true), 200); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => (t.hidden = true), 200);
  }, opts.duration || (message.length > 70 ? 4200 : 3000));
}
const fmt = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });

// ---------- Branded confirmation dialog ----------
// Replaces native window.confirm() everywhere — same modal design language as
// the rest of the app, with an optional term-breakdown list. Resolves boolean.
function askConfirm({ title = 'Are you sure?', message = '', rows = [], confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    document.getElementById('confirmDialog')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.id = 'confirmDialog';
    const rowsHtml = rows.length
      ? `<div class="supply-list">${rows.map(([k, v]) => `<div class="supply-row"><span class="k"></span><span class="v"></span></div>`).join('')}</div>`
      : '';
    wrap.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true">
        <h3></h3>
        <p class="hint"${message ? '' : ' hidden'}></p>
        ${rowsHtml}
        <div class="modal-actions">
          <button class="btn ghost" type="button"></button>
          <button class="btn ${danger ? 'danger' : 'primary'}" type="button"></button>
        </div>
      </div>`;
    wrap.querySelector('h3').textContent = title;
    if (message) wrap.querySelector('p.hint').textContent = message;
    wrap.querySelectorAll('.supply-row').forEach((rowEl, i) => {
      rowEl.querySelector('.k').textContent = rows[i][0];
      rowEl.querySelector('.v').textContent = rows[i][1];
    });
    const [cancelBtn, okBtn] = wrap.querySelectorAll('.modal-actions .btn');
    cancelBtn.textContent = cancelText;
    okBtn.textContent = confirmText;
    const done = (val) => { wrap.remove(); resolve(val); };
    cancelBtn.addEventListener('click', () => done(false));
    okBtn.addEventListener('click', () => done(true));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    document.body.appendChild(wrap);
    okBtn.focus();
  });
}

// Confirmation that also collects a REASON (5+ chars) and, optionally, a typed
// safety word (e.g. "BAN") before the destructive button enables. Resolves the
// reason string, or null when cancelled.
function askReason({ title = 'Confirm', message = '', rows = [], placeholder = 'Reason', confirmText = 'Confirm', cancelText = 'Cancel', typed = null } = {}) {
  return new Promise((resolve) => {
    document.getElementById('confirmDialog')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.id = 'confirmDialog';
    wrap.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true">
        <h3></h3>
        <p class="hint"${message ? '' : ' hidden'}></p>
        ${rows.length ? `<div class="supply-list">${rows.map(() => '<div class="supply-row"><span class="k"></span><span class="v"></span></div>').join('')}</div>` : ''}
        <input type="text" class="ar-reason" maxlength="200" autocomplete="off" />
        ${typed ? `<input type="text" class="ar-typed" maxlength="20" autocomplete="off" />` : ''}
        <div class="modal-actions">
          <button class="btn ghost" type="button"></button>
          <button class="btn danger" type="button" disabled></button>
        </div>
      </div>`;
    wrap.querySelector('h3').textContent = title;
    if (message) wrap.querySelector('p.hint').textContent = message;
    wrap.querySelectorAll('.supply-row').forEach((rowEl, i) => { rowEl.querySelector('.k').textContent = rows[i][0]; rowEl.querySelector('.v').textContent = rows[i][1]; });
    const reasonEl = wrap.querySelector('.ar-reason');
    reasonEl.placeholder = placeholder;
    const typedEl = wrap.querySelector('.ar-typed');
    if (typedEl) typedEl.placeholder = `Type ${typed} to confirm`;
    const [cancelBtn, okBtn] = wrap.querySelectorAll('.modal-actions .btn');
    cancelBtn.textContent = cancelText;
    okBtn.textContent = confirmText;
    const check = () => { okBtn.disabled = reasonEl.value.trim().length < 5 || (typedEl && typedEl.value.trim() !== typed); };
    reasonEl.addEventListener('input', check);
    typedEl?.addEventListener('input', check);
    const done = (val) => { wrap.remove(); resolve(val); };
    cancelBtn.addEventListener('click', () => done(null));
    okBtn.addEventListener('click', () => { if (!okBtn.disabled) done(reasonEl.value.trim()); });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    document.body.appendChild(wrap);
    reasonEl.focus();
  });
}

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
  // A milestone (e.g. a rank-up) still pops the full card, just without a number.
  const value = Number(amount) || 0;
  const milestone = opts.milestone === true;
  if (value <= 0 && !milestone) {
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
      ${milestone ? '' : `<div class="rp-amount"><span class="rp-plus">+</span><span class="rp-num">0</span> <small>${unit}</small></div>`}
      <div class="rp-sub"${subtitle ? '' : ' hidden'}>${subtitle}</div>
      <button class="rp-close" type="button">Awesome</button>
    </div>`;
  document.body.appendChild(pop);
  requestAnimationFrame(() => pop.classList.add('show'));

  // Count-up animation on the amount for a rewarding reveal.
  const numEl = pop.querySelector('.rp-num');
  if (numEl) {
    const start = performance.now();
    const runUp = 700;
    (function tick(now) {
      const p = Math.min(1, (now - start) / runUp);
      const eased = 1 - Math.pow(1 - p, 3);
      numEl.textContent = fmt(value * eased);
      if (p < 1) requestAnimationFrame(tick);
      else numEl.textContent = fmt(value);
    })(start);
  }

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

// ---- Sound on/off toggle (topbar) — remembered per device ----
function updateSoundBtn() {
  const b = document.getElementById('soundBtn');
  if (!b || !window.ArcadeSound?.isMuted) return;
  const m = window.ArcadeSound.isMuted();
  b.textContent = m ? '🔇' : '🔊';
  b.classList.toggle('muted', m);
  b.title = m ? 'Sound off — tap to unmute' : 'Sound on — tap to mute';
}
document.getElementById('soundBtn')?.addEventListener('click', () => {
  if (!window.ArcadeSound?.setMuted) return;
  const willMute = !window.ArcadeSound.isMuted();
  window.ArcadeSound.setMuted(willMute);
  if (!willMute) { window.ArcadeSound.unlock?.(); window.ArcadeSound.coin?.(); } // confirmation blip on unmute
  updateSoundBtn();
  toast(willMute ? 'Sound off 🔇' : 'Sound on 🔊');
});
updateSoundBtn();

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
    ? 'Enter your Gmail, Yahoo or Hotmail/Outlook email — we’ll send a one-time code and create your wallet instantly.'
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
  // Retries can take a while on a slow link — tell the user we're still working instead of freezing.
  const slowHint = setTimeout(() => {
    hint.className = 'hint';
    hint.textContent = 'Still connecting… this can take a few seconds on a slow connection.';
  }, 7000);
  try {
    const referralCode = isSignup ? $('refCodeInput').value.trim().toUpperCase() : '';
    const integrityPayload = await getIntegrityPayload();
    // Safe to retry: the server de-duplicates OTP sends per email (30s cooldown).
    const r = await api('POST', '/auth/register', {
      email,
      mode: authMode,
      ...(referralCode ? { referralCode } : {}),
      ...integrityPayload,
    }, { retries: 3 });
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
    clearTimeout(slowHint);
    if (hint.textContent.startsWith('Still connecting')) hint.textContent = '';
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
  lastRankIndex = null;
  clearTimeout(rankUpTimer);

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
  if (typeof resetEarnUI === 'function') resetEarnUI();
  if (typeof chatReset === 'function') chatReset();
  // An ad preloaded for one account must never be used for the next one.
  adState.session = null;
  if (adState.preparedWithSsv) { rewardedLoaded = false; adState.nonce = null; adState.preparedWithSsv = false; }
  treeState = null;
  const treeScene = $('treeScene'); if (treeScene) treeScene.textContent = '🌱';
  setText('treeSub', 'Water it once a day to grow it and collect a small reward.');
  const treeFill = $('treeProgressFill'); if (treeFill) treeFill.style.width = '0%';
  const ladderFill = $('ladderProgressFill'); if (ladderFill) ladderFill.style.width = '0%';
  const botMessages = $('botMessages'); if (botMessages) botMessages.innerHTML = '';
  setText('kycTitle', 'Identity Verification');
  setText('kycSub', 'Not available yet — check back soon.');
  const kycBtn = $('kycActionBtn'); if (kycBtn) kycBtn.hidden = true;
  setVerifiedBadge(false);
}

/** Full sign-out: drops the session as well as the rendered account data. */
function clearAccountSession() {
  state.token = null;
  state.email = null;
  localStorage.removeItem('dltx_token');
  localStorage.removeItem('dltx_email');
  localStorage.removeItem('dltx_chat_draft');
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
    // Safe to retry: a code is consumed exactly once; a repeat just gets "invalid".
    const r = await api('POST', '/auth/verify', { email: state.email, code }, { retries: 3 });
    state.token = r.token;
    localStorage.setItem('dltx_token', r.token);
    if (r.user && r.user.email) state.email = r.user.email;
    if (state.email) localStorage.setItem('dltx_email', state.email);
    rememberAccount(state.email, r.token);
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
  forgetAccount(state.email);          // signing out forgets this account on this phone; the others stay saved
  closeAcctSheet();
  clearAccountSession();
  showScreen('screen-email');
  setAuthMode('signin');
});

// ---------- Saved accounts: switch without an email code ----------
// Each account's login token is kept on this phone only (the same place the active session already lives).
// Switching checks the token with the server first; a dead one is dropped and that account needs a new code.
function savedAccounts() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || '[]');
    return (Array.isArray(list) ? list : []).filter((a) => a && typeof a.email === 'string' && typeof a.token === 'string').slice(0, MAX_SAVED_ACCOUNTS);
  } catch { return []; }
}
function writeSavedAccounts(list) {
  try { localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(list.slice(0, MAX_SAVED_ACCOUNTS))); } catch { /* private mode */ }
}
const sameEmail = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
function rememberAccount(email, token) {
  if (!email || !token) return;
  const list = savedAccounts();
  const i = list.findIndex((a) => sameEmail(a.email, email));
  if (i >= 0) list[i] = { ...list[i], token };                          // same spot, fresh token
  else {
    if (list.length >= MAX_SAVED_ACCOUNTS) list.pop();                  // full: make room for the account just signed in
    list.push({ email: String(email).trim().toLowerCase(), token, at: Date.now() });
  }
  writeSavedAccounts(list);
}
function forgetAccount(email) {
  if (!email) return;
  writeSavedAccounts(savedAccounts().filter((a) => !sameEmail(a.email, email)));
}

function acctRowHtml(a, { current = false, removable = false } = {}) {
  const initial = escapeHtml((a.email || '?').trim().charAt(0).toUpperCase());
  return `<div class="acct-row ${current ? 'current' : ''}">
    <button type="button" class="acct-pick" data-email="${escapeHtml(a.email)}" ${current ? 'aria-current="true"' : ''}>
      <span class="acct-av" aria-hidden="true">${initial}</span>
      <span class="acct-meta"><b>${escapeHtml(a.email)}</b><small>${current ? '✓ Signed in now' : 'Tap to switch'}</small></span>
    </button>
    ${removable ? `<button type="button" class="acct-remove" data-remove="${escapeHtml(a.email)}" aria-label="Remove ${escapeHtml(a.email)} from this phone" title="Remove from this phone">✕</button>` : ''}
  </div>`;
}

function paintAcctSheet() {
  const list = savedAccounts();
  const box = $('acctList');
  if (!box) return;
  box.innerHTML = list.length
    ? list.map((a) => { const cur = state.token && a.token === state.token; return acctRowHtml(a, { current: cur, removable: !cur }); }).join('')
    : '<p class="chat-hint">No other accounts saved on this phone yet.</p>';
  const add = $('acctAdd');
  if (add) {
    const full = list.length >= MAX_SAVED_ACCOUNTS;
    add.disabled = full;
    $('acctHint').textContent = full ? `This phone holds up to ${MAX_SAVED_ACCOUNTS} accounts. Remove one to add another.` : '';
  }
}
function openAcctSheet() {
  if (state.token && state.email) rememberAccount(state.email, state.token);   // make sure the active account is in the list
  paintAcctSheet();
  $('acctModal').hidden = false;
}
function closeAcctSheet() { const m = $('acctModal'); if (m) m.hidden = true; }

// The sign-in screen lists saved accounts too, so signing back in is one tap.
function paintSavedLogin() {
  const box = $('savedAccts');
  if (!box) return;
  const list = savedAccounts();
  box.hidden = list.length === 0;
  $('savedAcctList').innerHTML = list.map((a) => acctRowHtml(a)).join('');
}

let switchingAccount = false;
async function switchAccount(email) {
  if (switchingAccount) return;
  const target = savedAccounts().find((a) => sameEmail(a.email, email));
  if (!target) return;
  if (state.token && target.token === state.token) { closeAcctSheet(); return; }
  switchingAccount = true;
  const hint = $('acctHint');
  const say = (msg) => { if (hint) hint.textContent = msg; };
  say('Switching…');
  try {
    // Check the saved token directly (not through api(), whose 401 handling would sign the CURRENT account out).
    let status = 0;
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
      const res = await fetch(API + '/energy', {
        headers: { 'Content-Type': 'application/json', 'X-Deltix-Client': 'deltix-app', 'X-App-Version': APP_VERSION, 'X-Device-Id': getDeviceId(), Authorization: 'Bearer ' + target.token },
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      if (timer) clearTimeout(timer);
      status = res.status;
    } catch { status = -1; }
    if (status === -1 || status >= 500 || status === 429) { say('Could not reach Deltix. Check your connection and try again — you are still signed in.'); return; }
    if (status === 401 || status === 403 || status === 404 || status === 423) {
      forgetAccount(target.email);
      paintAcctSheet(); paintSavedLogin();
      say(`${target.email} needs a new email code. Use “Add another account” to sign in again.`);
      toast('That account’s saved login has expired. Sign in with a code to add it back.', { tone: 'error' });
      return;
    }
    if (state.token && state.email) rememberAccount(state.email, state.token);
    clearAccountSession();                                   // wipes every on-screen trace of the previous account
    state.token = target.token;
    state.email = target.email;
    localStorage.setItem('dltx_token', target.token);
    localStorage.setItem('dltx_email', target.email);
    closeAcctSheet();
    say('');
    toast(`Switched to ${target.email}`, { tone: 'success' });
    await enterApp();
  } finally {
    switchingAccount = false;
  }
}

function addAnotherAccount() {
  if (savedAccounts().length >= MAX_SAVED_ACCOUNTS && !(state.token && savedAccounts().some((a) => a.token === state.token))) return;
  if (state.token && state.email) rememberAccount(state.email, state.token);
  closeAcctSheet();
  clearAccountSession();            // saved accounts stay; only the active session is released
  showScreen('screen-email');
  setAuthMode('signin');
  toast('Enter the email of the account you want to add.', { tone: 'info' });
}

$('switchBtn')?.addEventListener('click', openAcctSheet);
$('acctClose')?.addEventListener('click', closeAcctSheet);
$('acctAdd')?.addEventListener('click', addAnotherAccount);
$('acctModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeAcctSheet(); });
$('acctList')?.addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    const email = rm.dataset.remove;
    const okGo = await askConfirm({ title: 'Remove from this phone?', message: `${email} will be signed out here. You will need a new email code to sign in to it again.`, confirmText: 'Remove' });
    if (okGo) { forgetAccount(email); paintAcctSheet(); }
    return;
  }
  const pick = e.target.closest('[data-email]');
  if (pick) switchAccount(pick.dataset.email);
});
$('savedAcctList')?.addEventListener('click', (e) => { const pick = e.target.closest('[data-email]'); if (pick) switchAccount(pick.dataset.email); });

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
    forgetAccount(state.email);
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

// Bottom navigation bar (two-row tab bar).
document.querySelectorAll('.tabbtn').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab))
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
  navReset();
  showTab('tab-wallet', { refresh: false });
  // Recover the email from the JWT for sessions that signed in before we
  // started persisting it (so the profile never shows a blank email).
  if (!state.email && state.token) {
    state.email = emailFromToken(state.token);
    if (state.email) localStorage.setItem('dltx_email', state.email);
  }
  // Sessions from before account switching existed join the saved list the first time they open.
  if (state.token && state.email) rememberAccount(state.email, state.token);
  renderProfile();
  // Start the shared earn clock; the server session is fetched right after
  // login so the Wallet card and the Earn page show the same remaining time.
  startEarnTicker();
  loadEarn();
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
  flushPendingCompletions();
  if (typeof checkMysteryHour === 'function') checkMysteryHour();
  if (adsReady) preloadRewardedAd();   // now that we are signed in, load the next ad with this account's proof id
  // Non-blocking: powers the Deltix Bot's one-shot daily nudge (checked
  // against data already needed elsewhere, no dedicated notification backend).
  Promise.allSettled([loadRewards(), loadTree()]).then(() => setTimeout(checkBotNudge, 1500));
  loadKycStatus();
  loadP2pStatus().catch(() => {});
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
const PREMIUM_AVATARS = ['🐉','🦅','🧙','🥷','👑','🛸','🦸','🧛','🧜','🧚','🤴','👸','🦹','🧞','🐲','⚔️','🗿','💫','🧌','🦂','🐊'];
// These are also sold in the Deltix Shop for Energy/$DLTX — showing them as a
// free one-ad unlock here too undercut the Shop price entirely (e.g. the
// Dragon Avatar cost 60 Energy in the Shop but was unlockable free with one
// ad here). Already-owned copies (from either path) still display normally;
// only the still-locked state is redirected to the Shop instead of an ad.
const SHOP_ONLY_AVATARS = ['🐉', '🥷', '👑', '🧌', '🦂', '🐊'];

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
  { id: 'crimson',  name: 'Crimson',  free: false, dark: true },
  { id: 'arctic',   name: 'Arctic',   free: false },
  { id: 'volt',     name: 'Volt',     free: false, dark: true },
];
// Also sold in the Deltix Shop for Energy/$DLTX — see SHOP_ONLY_AVATARS above.
const SHOP_ONLY_THEMES = ['emerald', 'royal', 'aurora', 'crimson', 'arctic', 'volt'];
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
  grid.innerHTML = THEMES.filter((t) => t.free || unlocked.includes(t.id) || SHOP_ONLY_THEMES.includes(t.id) || ADS_ENABLED).map((t) => {
    const locked = !t.free && !unlocked.includes(t.id);
    return `<button class="theme-opt ${t.id === current ? 'active' : ''} ${locked ? 'locked' : ''}" data-theme-id="${t.id}"><span class="sw sw-${t.id}"></span>${t.name}</button>`;
  }).join('');
  grid.querySelectorAll('.theme-opt').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.themeId;
      if (b.classList.contains('locked')) {
        if (SHOP_ONLY_THEMES.includes(id)) {
          toast('Get this theme in the Deltix Shop ⚡');
          if (typeof openShop === 'function') openShop();
          return;
        }
        // Clear opt-in disclosure before the rewarded ad (AdMob requirement).
        if (!(await askConfirm({ title: 'Unlock with an ad', message: 'Watch a short rewarded ad to unlock this theme — free, no Energy spent.', confirmText: '▶ Watch ad' }))) return;
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
    // Ad-free builds hide still-locked premiums (no way to unlock them); shop-only
    // ones always show since the Shop purchase path doesn't depend on ads.
    ...PREMIUM_AVATARS.filter((e) => SHOP_ONLY_AVATARS.includes(e) || ADS_ENABLED || unlocked.includes(e))
      .map((e) => ({ e, locked: !unlocked.includes(e) })),
  ];
  grid.innerHTML = all
    .map(({ e, locked }) => `<button class="avatar-opt ${e === state.avatar ? 'active' : ''} ${locked ? 'locked' : ''}" data-emoji="${e}">${e}</button>`)
    .join('');
  grid.querySelectorAll('.avatar-opt').forEach((b) =>
    b.addEventListener('click', async () => {
      const emoji = b.dataset.emoji;
      if (b.classList.contains('locked')) {
        if (SHOP_ONLY_AVATARS.includes(emoji)) {
          toast('Get this avatar in the Deltix Shop ⚡');
          if (typeof openShop === 'function') openShop();
          return;
        }
        // Clear opt-in disclosure before the rewarded ad (AdMob requirement).
        if (!(await askConfirm({ title: 'Unlock with an ad', message: 'Watch a short rewarded ad to unlock this premium avatar — free, no Energy spent.', confirmText: '▶ Watch ad' }))) return;
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
  // Display parity with the backend: if part of "Liquid" is not transferable
  // (welcome bonus / time-locked rewards still on the liquid slice, P2P
  // escrow), say so right under the number so the tile never over-promises.
  const lockedNote = $('liquidLockedNote');
  if (lockedNote) {
    const transferable = w.availableTransferableBalance != null ? w.availableTransferableBalance : w.balance;
    const locked = w.liquidLocked != null ? w.liquidLocked : Math.max(0, (w.balance || 0) - transferable);
    if (!hide && locked > 0.000000005) {
      lockedNote.textContent = `${fmt(transferable)} transferable · ${fmt(locked)} locked`;
      lockedNote.hidden = false;
    } else {
      lockedNote.hidden = true;
    }
  }
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
    const negatives = ['stake', 'send', 'treasury_burn', 'paid_spin_wager', 'shop_purchase'];
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
    const promoNote = r.promo && r.promo.active ? ` · 🎁 Monthly promo: ${fmt(r.promo.amount)} $DLTX per activation until day ${r.promo.dayStart + r.promo.durationDays - 1} (normally ${fmt(r.baseReward)})` : '';
    if (r.unlimited) {
      $('refSlots').innerHTML = `<div class="slot used">✓</div><div class="slot-count">${r.slotsUsed} joined · unlimited invites</div>`;
      $('refInfo').textContent =
        `Unlimited invites · +${fmt(r.rewardPerActivation)} $DLTX when a referral keeps a stake of ${fmt(r.minStakeToActivate)}+ $DLTX · Earned so far: ${fmt(r.totalReferralRewards)} $DLTX${promoNote}`;
    } else {
      $('refSlots').innerHTML = Array.from({ length: r.maxDirect }, (_, i) =>
        `<div class="slot ${i < r.slotsUsed ? 'used' : ''}">${i < r.slotsUsed ? '✓' : i + 1}</div>`
      ).join('');
      $('refInfo').textContent =
        `${r.slotsLeft} of ${r.maxDirect} invites left · +${fmt(r.rewardPerActivation)} $DLTX when a referral keeps a stake of ${fmt(r.minStakeToActivate)}+ $DLTX · Earned so far: ${fmt(r.totalReferralRewards)} $DLTX${promoNote}`;
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

function currentSendable() {
  const s = state.balances || {};
  if (s.availableTransferableBalance != null) return Number(s.availableTransferableBalance) || 0;
  if (s.sendableBalance != null) return Number(s.sendableBalance) || 0;
  return Number(s.balance) || 0;
}
/** Largest amount such that amount + fee(amount) <= sendable, floored to 8dp. */
function maxSendable(sendable) {
  if (!(sendable > MIN_BASE_FEE)) return 0;
  let amt = sendable / (1 + BASE_FEE_RATE);
  if (amt * BASE_FEE_RATE < MIN_BASE_FEE) amt = sendable - MIN_BASE_FEE;
  amt = Math.floor(amt * 1e8) / 1e8;
  // guard float dust: step down one satoshi until it fits
  while (amt > 0 && Math.round((amt + Math.max(MIN_BASE_FEE, amt * BASE_FEE_RATE)) * 1e8) / 1e8 > sendable) amt = Math.round((amt - 1e-8) * 1e8) / 1e8;
  return Math.max(0, amt);
}

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
  const sendable = currentSendable();
  const u = s.transferUnlock || {};
  const gated = u.active && !u.unlocked;
  $('sendHint').textContent = gated
    ? `Transfers unlock after claiming ${fmt(u.required)} Energy from delegation (${fmt(u.claimed || 0)} / ${fmt(u.required)} so far).`
    : `Transferable: ${fmt(sendable)} $DLTX`
      + (s.bonusLocked > 0 && s.liquidLocked > 0 ? ` · ${fmt(Math.min(s.bonusLocked, s.liquidLocked))} welcome bonus locked (stake/use only)` : '')
      + (s.timeLocked > 0 ? ` · ${fmt(s.timeLocked)} referral rewards locked for 6 months (use in-app only)` : '')
      + (s.p2pLocked > 0 ? ` · ${fmt(s.p2pLocked)} reserved in P2P escrow` : '');
  $('sendModal').hidden = false;
});
$('sendMaxBtn')?.addEventListener('click', () => {
  const amt = maxSendable(currentSendable());
  $('sendAmount').value = amt > 0 ? String(amt) : '';
  updateSendPreview();
});
$('receiveBtn').addEventListener('click', () => {
  if (!state.address) return;
  openReceiveModal();
});

// ---------- Wallet QR codes: show mine, scan someone else's ----------
// The code holds only the plain 0x address, so any wallet app can read it too. The two small libraries
// (vendor/) load on first use so they cost nothing at startup.
const loadedScripts = {};
function loadScriptOnce(src) {
  if (!loadedScripts[src]) {
    loadedScripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete loadedScripts[src]; s.remove(); reject(new Error(`Could not load ${src}`)); };
      document.head.appendChild(s);
    });
  }
  return loadedScripts[src];
}

/**
 * Pulls ONE wallet address out of scanned text. Accepts a bare address or a payment link such as
 * "deltix:0x…" or "ethereum:0x…@56". A longer hex string (a transaction hash or a private key) must never be
 * mistaken for an address, and two different addresses in one code are refused as ambiguous.
 */
function addressFromQr(text) {
  const found = new Map();   // lower-case form -> as written, so the same address twice counts once
  const re = /(?:^|[^0-9a-zA-Z])(0x[a-fA-F0-9]{40})(?![0-9a-zA-Z])/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) found.set(m[1].toLowerCase(), m[1]);
  return found.size === 1 ? [...found.values()][0] : null;
}

async function openReceiveModal() {
  const addr = state.address;
  if (!addr) return;
  $('receiveAddr').textContent = addr;
  const box = $('receiveQr');
  box.innerHTML = '<p class="chat-hint">Preparing your code…</p>';
  $('receiveModal').hidden = false;
  $('receiveShare').hidden = typeof navigator.share !== 'function';
  try {
    await loadScriptOnce('vendor/qrcode.js');
    const qr = qrcode(0, 'M');
    qr.addData(addr);
    qr.make();
    // Dark modules on a white card with a quiet border, whatever the theme, so every scanner can read it.
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
    const svg = box.querySelector('svg');
    if (svg) { svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('shape-rendering', 'crispEdges'); }
  } catch {
    box.innerHTML = '<p class="chat-hint">The code could not be drawn. You can still copy your address.</p>';
  }
}
$('receiveClose')?.addEventListener('click', () => { $('receiveModal').hidden = true; });
/** Copies text even where the browser blocks the clipboard API (falls back to a hidden field). Returns true on success. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* try the older way */ }
  try {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:-100px;opacity:0';
    document.body.appendChild(t); t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  } catch { return false; }
}
$('receiveCopy')?.addEventListener('click', async () => {
  if (!state.address) return;
  const ok = await copyText(state.address);
  toast(ok ? 'Your address was copied — share it to receive $DLTX' : 'Could not copy automatically. Press and hold the address to copy it.', { tone: ok ? 'success' : 'error' });
});
$('receiveShare')?.addEventListener('click', async () => {
  if (!state.address || typeof navigator.share !== 'function') return;
  try { await navigator.share({ title: 'My Deltix wallet', text: state.address }); } catch { /* cancelled */ }
});

const scanState = { stream: null, timer: 0, onAddress: null, lastText: '', lastAt: 0, canvas: null };
function setScanHint(msg, error = false) {
  const h = $('scanHint');
  if (!h) return;
  h.textContent = msg;
  h.className = error ? 'hint error' : 'hint';
}
function stopScanner() {
  clearTimeout(scanState.timer); scanState.timer = 0;
  if (scanState.stream) { scanState.stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } }); scanState.stream = null; }
  const v = $('scanVideo');
  if (v) { try { v.pause(); } catch { /* none */ } v.srcObject = null; }
}
/** Closes the scanner if it is open (used by Back too). Returns true when it was open. */
function closeScanner() {
  const m = $('scanModal');
  if (!m || m.hidden) return false;
  stopScanner();
  m.hidden = true;
  return true;
}
function finishScan(address) {
  const cb = scanState.onAddress;
  closeScanner();
  if (cb) cb(address);
}
function handleScannedText(text) {
  const now = Date.now();
  if (text === scanState.lastText && now - scanState.lastAt < 1800) return false;   // the same frame again: don't flash the message
  scanState.lastText = text; scanState.lastAt = now;
  const addr = addressFromQr(text);
  if (!addr) { setScanHint('That QR code does not hold a wallet address. Try another one.', true); return false; }
  if (state.address && addr.toLowerCase() === state.address.toLowerCase()) { setScanHint('That is your own wallet address. Scan someone else’s code.', true); return false; }
  finishScan(addr);
  return true;
}
function decodeFrame(source, w, h, tries = 'dontInvert') {
  if (!scanState.canvas) scanState.canvas = document.createElement('canvas');
  const c = scanState.canvas;
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const hit = window.jsQR ? window.jsQR(img.data, w, h, { inversionAttempts: tries }) : null;
  return hit ? hit.data : null;
}
function scanTick() {
  const v = $('scanVideo');
  if (!scanState.stream || !v || $('scanModal').hidden) return;
  if (v.readyState >= 2 && v.videoWidth) {
    const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));   // small frames keep low-end phones smooth
    const text = decodeFrame(v, Math.round(v.videoWidth * scale), Math.round(v.videoHeight * scale));
    if (text && handleScannedText(text)) return;
  }
  scanState.timer = setTimeout(scanTick, 120);
}
async function openScanner(onAddress) {
  scanState.onAddress = onAddress;
  scanState.lastText = '';
  $('scanModal').hidden = false;
  setScanHint('Point the camera at a Deltix wallet QR code.');
  $('scanView').hidden = false;
  try { await loadScriptOnce('vendor/jsQR.js'); } catch { $('scanView').hidden = true; setScanHint('The scanner could not load. Check your connection, or paste the address instead.', true); return; }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    $('scanView').hidden = true;
    setScanHint('The camera is not available here. Use “Pick image”, or paste the address.', true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if ($('scanModal').hidden) { stream.getTracks().forEach((t) => t.stop()); return; }   // closed while asking for permission
    scanState.stream = stream;
    const v = $('scanVideo');
    v.srcObject = stream;
    await v.play().catch(() => {});
    scanTick();
  } catch (e) {
    $('scanView').hidden = true;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    setScanHint(denied
      ? 'Camera access is off. Allow the camera for Deltix in your phone settings, or use “Pick image”.'
      : e && e.name === 'NotFoundError' ? 'No camera was found. Use “Pick image”, or paste the address.' : 'The camera could not start. Use “Pick image”, or paste the address.', true);
  }
}
$('scanClose')?.addEventListener('click', closeScanner);
$('scanModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeScanner(); });
$('scanFile')?.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await loadScriptOnce('vendor/jsQR.js');
    const url = URL.createObjectURL(file);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    URL.revokeObjectURL(url);
    const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
    const text = decodeFrame(img, Math.max(1, Math.round(img.naturalWidth * scale)), Math.max(1, Math.round(img.naturalHeight * scale)), 'attemptBoth');
    if (!text) { setScanHint('No QR code was found in that picture. Try a clearer one.', true); return; }
    scanState.lastText = '';
    handleScannedText(text);
  } catch { setScanHint('That picture could not be read.', true); }
});
// The camera must never stay on in the background.
document.addEventListener('visibilitychange', () => { if (document.hidden && scanState.stream) closeScanner(); });

function openSendWithAddress(addr) {
  $('sendBtn').click();
  $('sendTo').value = addr;
  $('sendHint').className = 'hint';
  toast('Address scanned — enter the amount to send.', { tone: 'success' });
  setTimeout(() => $('sendAmount')?.focus(), 150);
}
$('scanBtn')?.addEventListener('click', () => openScanner(openSendWithAddress));
$('sendScanBtn')?.addEventListener('click', () => openScanner((addr) => {
  $('sendTo').value = addr;
  $('sendHint').className = 'hint';
  toast('Address scanned.', { tone: 'success' });
  $('sendAmount')?.focus();
}));
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
    // One key per confirmed send — the server refuses accidental duplicates
    // (double taps, network retries) carrying the same key.
    const idempotencyKey = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const r = await api('POST', '/wallet/send', { toAddress, amount, idempotencyKey });
    $('sendModal').hidden = true;
    toast(`Sent ${fmt(r.amount)} $DLTX · ${fmt(r.feeBurned)} burned`);
    await Promise.all([loadWallet(), loadTx(), loadStats()]);
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
    // A refused/duplicate/failed transfer never moved funds — refresh so the
    // shown balance is the server's truth and the Max button is accurate.
    loadWallet().catch(() => {});
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

// ---------- Deltix Energy Delegation ----------
// All numbers are server-authoritative: this UI only renders the status the
// backend returns (rate, claimable, burn schedule, transfer-unlock progress).
let edState = null;
let edPendingValidator = null;
let edPendingUndelegate = null;

function renderEnergyDelegation(d) {
  edState = d || edState;
  if (!edState) return;
  const s = edState;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('edAvailable', `${fmt(s.available)} ⚡`);
  set('edDelegated', `${fmt(s.delegated)} ⚡`);
  set('edClaimable', `${fmt(s.claimable)} ⚡`);
  set('edRate', `${Math.round(s.annualRate * 100)}% / year`);
  const claimBtn = $('edClaimBtn');
  if (claimBtn) {
    claimBtn.disabled = !(s.claimable > 0);
    claimBtn.textContent = s.claimable > 0 ? `Claim ${fmt(s.claimable)} ⚡ Energy` : 'Claim Energy';
  }

  // Transfer unlock progress (hidden for grandfathered accounts).
  const unlockCard = $('edUnlockCard');
  if (unlockCard) {
    const u = s.transferUnlock || {};
    unlockCard.hidden = Boolean(u.grandfathered);
    if (!unlockCard.hidden) {
      const pct = Math.min(100, (Number(u.claimed) / Math.max(1, Number(u.required))) * 100);
      const fill = $('edUnlockFill');
      if (fill) fill.style.width = pct + '%';
      set('edUnlockText', u.claimed >= u.required
        ? `${fmt(u.claimed)} / ${fmt(u.required)} — UNLOCKED ✅`
        : `${fmt(u.claimed)} / ${fmt(u.required)} Claimed Energy`);
      const hintEl = $('edUnlockHint');
      if (hintEl) {
        hintEl.textContent = u.claimed >= u.required
          ? 'Transfers are unlocked on this account.'
          : (u.active
            ? 'Claim Energy from delegation to unlock $DLTX transfers on this account.'
            : 'Preview — the transfer requirement is not enforced on this server yet.');
      }
    }
  }

  const vList = $('edValidatorList');
  if (vList) {
    vList.innerHTML = (s.validators || [])
      .map((v, i) => {
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
              <div class="meta">Energy Validator · generation ${Math.round(s.annualRate * 100)}% / year</div>
            </div>
          </div>
          <div class="val-actions-col">
            <span class="apy-badge-red">⚡ ${Math.round(s.annualRate * 100)}%</span>
            <button class="delegate-btn-red" data-ed-validator="${v.id}" data-name="${v.name}">Delegate</button>
          </div>
        </div>`;
      })
      .join('') || '<p class="muted center">No Energy Validators available.</p>';
    vList.querySelectorAll('[data-ed-validator]').forEach((btn) =>
      btn.addEventListener('click', () => openEdDelegateModal(btn.dataset.edValidator, btn.dataset.name))
    );
  }

  const mine = $('edMyDelegations');
  if (mine) {
    const rows = s.delegations || [];
    if (!rows.length) {
      mine.innerHTML = '<p class="muted center">You have no active Energy delegations.</p>';
    } else {
      mine.innerHTML = rows
        .map((dg, i) => {
          const shield = getValidatorShield(dg.validator, i);
          const burnTxt = dg.burnRate > 0
            ? `Current burn ${Math.round(dg.burnRate * 100)}% · drops in ${dg.nextBurnDropInDays}d`
            : 'No undelegation burn (30+ days)';
          return `
        <div class="stake-card-3d">
          <div class="stake-card-top">
            <img src="${shield}" class="stake-3d-shield" alt="Shield"/>
            <div class="stake-info">
              <div class="stake-title-row">
                <span class="stake-val-name">${dg.validator}</span>
                <span class="timer-badge">Day ${dg.ageDays}</span>
              </div>
              <div class="meta">${fmt(dg.amount)} ⚡ delegated · ${Math.round(dg.rate * 100)}% / year</div>
              <div class="stake-rewards-txt">Generated: ${fmt(dg.claimable)} ⚡</div>
              <div class="meta">${burnTxt}</div>
            </div>
          </div>
          <div class="stake-actions-row">
            <button class="stake-action-btn primary" data-ed-undelegate="${dg.id}">Undelegate</button>
          </div>
        </div>`;
        })
        .join('');
      mine.querySelectorAll('[data-ed-undelegate]').forEach((b) =>
        b.addEventListener('click', () => openEdUndelegateModal(b.dataset.edUndelegate))
      );
    }
  }
}

async function loadEnergyDelegation() {
  try {
    const d = await api('GET', '/energy-delegation');
    renderEnergyDelegation(d);
  } catch (e) {
    /* non-critical; ignore */
  }
}

function openEdDelegateModal(id, name) {
  edPendingValidator = id;
  $('edDelegateTitle').textContent = `Delegate Energy to ${name}`;
  const rate = edState ? Math.round(edState.annualRate * 100) : 50;
  const terms = [
    ['Available Energy', edState ? `${fmt(edState.available)} ⚡` : '–'],
    ['Generation rate', `${rate}% / year`],
    ['Rewards', 'Go to Claimable Energy — claim manually'],
    ['Early undelegation burn', '40% → 25% → 10% → 0% (day 30+)'],
  ];
  $('edDelegateTerms').innerHTML = terms
    .map(([k, v]) => `<div class="supply-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join('');
  $('edDelegateAmount').value = '';
  $('edDelegateHint').textContent = '';
  $('edDelegateModal').hidden = false;
}
$('edCancelDelegate').addEventListener('click', () => ($('edDelegateModal').hidden = true));
$('edConfirmDelegate').addEventListener('click', async () => {
  const amount = Number($('edDelegateAmount').value);
  const hint = $('edDelegateHint');
  hint.className = 'hint';
  if (!Number.isFinite(amount) || amount <= 0) {
    hint.textContent = 'Enter a positive amount.';
    hint.classList.add('error');
    return;
  }
  $('edConfirmDelegate').disabled = true;
  try {
    const r = await api('POST', '/energy-delegation/delegate', { validatorId: edPendingValidator, amount });
    $('edDelegateModal').hidden = true;
    renderEnergyDelegation(r.status);
    toast(r.message || 'Energy delegated');
    loadEnergy().catch(() => {});
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('edConfirmDelegate').disabled = false;
  }
});

let edClaiming = false;
$('edClaimBtn').addEventListener('click', async () => {
  if (edClaiming) return; // double-tap guard (server is idempotent anyway)
  edClaiming = true;
  $('edClaimBtn').disabled = true;
  try {
    const r = await api('POST', '/energy-delegation/claim');
    renderEnergyDelegation(r.status);
    celebrate({ amount: r.claimed, unit: '⚡ Energy', title: 'Energy Claimed!', message: `You now have ${fmt(r.energy)} ⚡ available.` });
    loadEnergy().catch(() => {});
  } catch (e) {
    toast(e.message || 'Nothing to claim yet');
  } finally {
    edClaiming = false;
    $('edClaimBtn').disabled = false;
  }
});

function edRenderUndelegatePreview() {
  const dg = edPendingUndelegate;
  if (!dg) return;
  const amount = Math.min(Number($('edUndelegateAmount').value) || dg.amount, dg.amount);
  // Display-only estimate from the server-reported burn rate; the server
  // recomputes everything at confirmation time.
  const burned = Math.round(amount * dg.burnRate * 1e8) / 1e8;
  const rows = [
    ['Undelegating', `${fmt(amount)} ⚡`],
    ['Delegation age', `Day ${dg.ageDays}`],
    ['Burn rate', `${Math.round(dg.burnRate * 100)}%`],
    ['Energy burned', `${fmt(burned)} ⚡`],
    ['Energy returned', `${fmt(Math.round((amount - burned) * 1e8) / 1e8)} ⚡`],
  ];
  if (dg.burnRate > 0) rows.push(['Burn drops', `in ${dg.nextBurnDropInDays} day(s)`]);
  $('edUndelegatePreview').innerHTML = rows
    .map(([k, v]) => `<div class="supply-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join('');
}
function openEdUndelegateModal(id) {
  const dg = (edState?.delegations || []).find((x) => String(x.id) === String(id));
  if (!dg) return;
  edPendingUndelegate = dg;
  $('edUndelegateAmount').value = dg.amount;
  $('edUndelegateAmount').max = dg.amount;
  $('edUndelegateHint').textContent = '';
  edRenderUndelegatePreview();
  $('edUndelegateModal').hidden = false;
}
$('edUndelegateAmount').addEventListener('input', edRenderUndelegatePreview);
$('edCancelUndelegate').addEventListener('click', () => ($('edUndelegateModal').hidden = true));
$('edConfirmUndelegate').addEventListener('click', async () => {
  const dg = edPendingUndelegate;
  if (!dg) return;
  const amount = Number($('edUndelegateAmount').value);
  const hint = $('edUndelegateHint');
  hint.className = 'hint';
  if (!Number.isFinite(amount) || amount <= 0 || amount > dg.amount) {
    hint.textContent = `Enter an amount between 0 and ${dg.amount}.`;
    hint.classList.add('error');
    return;
  }
  $('edConfirmUndelegate').disabled = true;
  try {
    const r = await api('POST', `/energy-delegation/${dg.id}/undelegate`, { amount });
    $('edUndelegateModal').hidden = true;
    renderEnergyDelegation(r.status);
    toast(r.message);
    loadEnergy().catch(() => {});
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('edConfirmUndelegate').disabled = false;
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
      const okd = await askConfirm({
        title: `Unstake ${fmt(stake.amount)} $DLTX?`,
        message: 'The 1% unstake fee is burned from principal before funds return to your liquid balance.',
        rows: [
          ['Unstaking', `${fmt(stake.amount)} $DLTX`],
          ['Burn fee (1%)', `${fmt(fee)} $DLTX`],
          ['Pending rewards', `${fmt(stake.pendingRewards)} $DLTX`],
          ['You receive', `${fmt(returned + Number(stake.pendingRewards))} $DLTX`],
        ],
        confirmText: 'Unstake',
        danger: true,
      });
      if (!okd) return;
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

// ---------- AdMob (native app only) ----------
// Production ad units from the Deltix Network AdMob account.
//   App id (AndroidManifest): ca-app-pub-6703659529197503~2016406742
const ADMOB_LIVE = {
  banner: 'ca-app-pub-6703659529197503/5133524678',
  interstitial: 'ca-app-pub-6703659529197503/1357931192',
  // Rewarded unit: grants only non-transferable in-app benefits (Energy, cosmetics) —
  // never $DLTX, which is P2P-transferable (AdMob rewarded-ad policy).
  rewarded: 'ca-app-pub-6703659529197503/5850926156',
};
// Google's official demo units: always safe, they never count as real impressions or clicks.
const ADMOB_DEMO = {
  banner: 'ca-app-pub-3940256099942544/6300978111',
  interstitial: 'ca-app-pub-3940256099942544/1033173712',
  rewarded: 'ca-app-pub-3940256099942544/5224354917',
};
// UX decision: banner placements stay off; interstitial + rewarded formats are active.
const BANNER_ADS_ENABLED = false;
const ADS_ENABLED = true;
const ADMOB_FORCE_TESTING = false; // true only for a dedicated test build
// Emulators, automated browsers and an explicit opt-in flag always get DEMO ads, so
// simulations and tests can never send live ad requests (invalid-traffic risk).
function adsTestMode() {
  try { if (localStorage.getItem('dltx_ads_test') === '1') return true; } catch {}
  if (window.DELTIX_ADS_TEST === true) return true;
  return /sdk_gphone|google_sdk|Android SDK built|Emulator|generic_x86|Cuttlefish/i.test(navigator.userAgent || '') || navigator.webdriver === true;
}
const ADMOB_TESTING = ADMOB_FORCE_TESTING || adsTestMode();
const adUnit = (kind) => (ADMOB_TESTING ? ADMOB_DEMO : ADMOB_LIVE)[kind];
window.ADS_ENABLED = ADS_ENABLED;
let adsReady = false;
let gamesSinceInterstitial = 0;
let lastInterstitialAt = 0;
// Interstitial/rewarded ads are PRELOADED ahead of time so the moment a game
// ends (or a reward action fires) the ad is already cached and shows instantly.
let interstitialLoading = false;
let interstitialLoaded = false;
let rewardedLoaded = false;
let rewardedLoadPromise = null;

const AD_LOAD_TIMEOUT_MS = 15000;   // an ad that has not loaded by now is treated as unavailable
const AD_SHOW_TIMEOUT_MS = 12000;   // …and one that has not appeared after show() is treated as failed
const AD_HARD_TIMEOUT_MS = 5 * 60000; // nothing may keep the UI waiting longer than this
const adState = { status: 'idle', failures: 0, retryTimer: null, nonce: null, session: null, preparedWithSsv: false, playing: false, showing: false, preparedAt: 0, lastError: '' };
const AD_STALE_MS = 50 * 60000;     // a loaded rewarded ad expires after about an hour; reload before then
const AD_REWARD_GRACE_MS = 3000;    // the reward event can trail the "closed" event on slow phones
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(label)), ms);
  Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const newAdNonce = () => (window.crypto?.randomUUID?.() || `${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, '').slice(0, 40);

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
      const info = await withTimeout(AdMob.requestConsentInfo(), 8000, 'consent-timeout');
      if (info && info.isConsentFormAvailable && info.status === 'REQUIRED') {
        await AdMob.showConsentForm();
      }
    } catch {
      /* consent flow unavailable — continue; SDK serves non-personalized ads */
    }
    await withTimeout(AdMob.initialize({ initializeForTesting: ADMOB_TESTING }), 10000, 'init-timeout');
    adsReady = true;
    preloadInterstitial();
    preloadRewardedAd();
  } catch (err) {
    /* ads are never allowed to break the app */
    adState.status = 'failed';
    adState.lastError = String(err?.message || err);
    scheduleAdRetry(true);
  }
}

/** Fetches the next interstitial in the background so it's cached before it's needed. */
function preloadInterstitial() {
  if (!ADS_ENABLED || interstitialLoading || interstitialLoaded) return;
  const cap = window.Capacitor;
  const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !AdMob) return;
  interstitialLoading = true;
  withTimeout(AdMob.prepareInterstitial({ adId: adUnit('interstitial'), isTesting: ADMOB_TESTING }), AD_LOAD_TIMEOUT_MS, 'load-timeout')
    .then(() => { interstitialLoading = false; interstitialLoaded = true; })
    .catch(() => { interstitialLoading = false; interstitialLoaded = false; });
}

/** Shows the already-preloaded interstitial instantly. If the preload hasn't
 *  landed yet, this impression is skipped rather than making the user wait. */
function showPreloadedInterstitial() {
  const cap = window.Capacitor;
  const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !AdMob) return;
  if (!interstitialLoaded) { preloadInterstitial(); return; }
  interstitialLoaded = false;
  AdMob.showInterstitial().catch(() => {});
  preloadInterstitial(); // start fetching the next one right away
}
window.showPreloadedInterstitial = showPreloadedInterstitial;

/** Retries a failed ad setup/load with growing delays, so ads recover on their own. */
function scheduleAdRetry(reinit = false) {
  clearTimeout(adState.retryTimer);
  const delay = Math.min(300000, 20000 * 2 ** Math.min(Math.max(adState.failures - 1, 0), 4));
  adState.retryTimer = setTimeout(() => {
    if (document.hidden) return scheduleAdRetry(reinit);
    if (reinit && !adsReady) initAds(); else preloadRewardedAd();
  }, delay);
}

/** The server tells the app whether it will ask for proof of an ad, and which opaque id to attach. */
async function ensureAdSession() {
  if (!state.token) return { mode: 'off' };
  if (adState.session) return adState.session;
  try {
    adState.session = await api('GET', '/admob/session', null, { retries: 0 });
  } catch {
    // An older backend has no such endpoint — behave exactly as before.
    adState.session = { mode: 'off' };
  }
  return adState.session;
}

/** Fetches the next rewarded ad in the background; opt-in taps fall back to
 *  a fresh load only when the preload hasn't landed yet. */
function preloadRewardedAd() {
  if (!ADS_ENABLED) return Promise.resolve(rewardedLoaded);
  // A loaded ad that has been sitting for too long would fail to show; throw it away and fetch a fresh one.
  if (rewardedLoaded && Date.now() - adState.preparedAt > AD_STALE_MS) { rewardedLoaded = false; adState.nonce = null; }
  if (rewardedLoaded) return Promise.resolve(true);
  // Never start a second load while an ad is on screen: it can replace the ad being shown and lose its reward.
  if (adState.showing) return Promise.resolve(false);
  if (rewardedLoadPromise) return rewardedLoadPromise;
  const cap = window.Capacitor;
  const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !AdMob) return Promise.resolve(false);
  adState.status = 'loading';
  rewardedLoadPromise = (async () => {
    const session = await ensureAdSession();
    const nonce = newAdNonce();
    const options = { adId: adUnit('rewarded'), isTesting: ADMOB_TESTING };
    const withSsv = session.mode && session.mode !== 'off' && session.userId;
    if (withSsv) options.ssv = { userId: session.userId, customData: nonce };
    await withTimeout(AdMob.prepareRewardVideoAd(options), AD_LOAD_TIMEOUT_MS, 'load-timeout');
    adState.nonce = nonce;
    adState.preparedWithSsv = Boolean(withSsv);
    adState.preparedAt = Date.now();
    adState.status = 'ready';
    adState.failures = 0;
    rewardedLoaded = true;
    return true;
  })()
    .catch((error) => {
      rewardedLoaded = false;
      adState.status = 'failed';
      adState.failures += 1;
      adState.lastError = String(error?.message || error);
      console.warn('[ads] rewarded ad failed to load', error);
      scheduleAdRetry();
      return false;
    })
    .finally(() => { rewardedLoadPromise = null; });
  return rewardedLoadPromise;
}

/** Can the UI honestly offer "Watch ad" right now? */
function adsOfferable() {
  if (!ADS_ENABLED || window.ADS_ENABLED === false) return false;
  const native = !!(window.Capacitor?.isNativePlatform?.() && window.Capacitor?.Plugins?.AdMob);
  if (!native) return true;                       // web preview uses the disclosed simulated ad
  return adState.status !== 'failed' || adState.failures < 3;
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
    adId: adUnit('banner'),
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
// Server-authoritative ladder/calendar/rain amounts (module `state` is
// shadowed by locals inside the render functions, hence this accessor).
function serverBonusValues() { return state.energy?.bonus || null; }
function adoptEnergy(e) { if (e && typeof e.energy === 'number') state.energy = e; }
function rankForEnergy(e) {
  for (let i = ENERGY_RANKS.length - 1; i >= 0; i--) if (e >= ENERGY_RANKS[i].min) return { rank: ENERGY_RANKS[i], index: i };
  return { rank: ENERGY_RANKS[0], index: 0 };
}
// Tracks the last Energy rank we've shown so a rank-up pops a celebration once.
let lastRankIndex = null;
let rankUpTimer = null;

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
async function loadEnergy(prefetched, { force = false } = {}) {
  if (_energyLoad) {
    if (!force) return _energyLoad;
    // A reward just landed — wait out the in-flight read, then re-read so the
    // UI never settles on a pre-mutation balance (stale-read race fix).
    try { await _energyLoad; } catch {}
  }
  const p = (async () => {
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
    }
  })();
  _energyLoad = p;
  // Identity-guarded clear — a newer load must never be nulled by an older one.
  const clear = () => { if (_energyLoad === p) _energyLoad = null; };
  p.then(clear, clear);
  return p;
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
    // The ad's nonce lets the server tie the unlock to that one completed ad.
    const adNonce = window.lastAdResult?.earned ? window.lastAdResult.nonce : null;
    state.energy = await postAdReward('/energy/unlock', { kind, item, ...(adNonce ? { adNonce } : {}) }, {
      onConfirming: () => toast('Confirming your ad…', { tone: 'info' }),
    });
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
  if (typeof chatOnEnergyChanged === 'function') chatOnEnergyChanged();
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
  renderDailyLadder();
  renderWeekCalendar();
  renderRainScene();
  loadTree();
  applyEnergyHour(state.energy?.happyHour);

  // Celebrate reaching a new Energy rank — non-monetary status recognition.
  // First render sets the baseline; later increases pop a rank-up card.
  if (state.energy) {
    if (lastRankIndex !== null && index > lastRankIndex) {
      const rk = ENERGY_RANKS[index];
      clearTimeout(rankUpTimer);
      rankUpTimer = setTimeout(() => celebrate({
        milestone: true,
        title: 'Rank Up! 🎖️',
        subtitle: `You reached ${rk.name}`,
        icon: '⚡',
        duration: 3400,
      }), 900);
    }
    lastRankIndex = index;
  }
}

// ---- 2x Energy Hour — ad-activated personal 2× window, 2 uses per day ----
let ehTimer = null;
let ehAnnouncedFor = null;
let ehEndedFor = null;
function updateEhCountdown(endsAt) {
  const sub = $('energyHourSub');
  if (!sub || !endsAt) return;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) {
    applyEnergyHour({ active: false });
    // Close the window with the same branded popup used for reward claims,
    // refreshed from the server so the remaining-uses count is authoritative.
    const announceEnd = ehEndedFor !== endsAt;
    if (announceEnd) ehEndedFor = endsAt;
    loadEnergy().then(() => {
      if (!announceEnd) return;
      const left = Math.max(0, Number(state.energy?.happyHour?.usesRemaining) || 0);
      celebrate({
        milestone: true,
        title: '2x Energy Hour Complete ⏳',
        subtitle: left > 0
          ? `Nice work! ${left === 1 ? '1 activation' : `${left} activations`} remaining today — watch an ad to double up again.`
          : 'Both 2x Energy Hours are used for today — fresh boosts arrive tomorrow.',
        icon: '⚡',
        duration: 3600,
      });
    }).catch(() => {});
    return;
  }
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  sub.textContent = `2× Energy on every ad · ends in ${m}:${String(s).padStart(2, '0')}`;
}
function applyEnergyHour(hh) {
  const banner = $('energyHourBanner');
  if (!banner) return;
  const title = $('energyHourTitle');
  const sub = $('energyHourSub');
  const btn = $('energyHourBtn');
  if (!hh || !hh.active) {
    banner.classList.add('idle');
    if (ehTimer) { clearInterval(ehTimer); ehTimer = null; }
    ehAnnouncedFor = null;
    if (title) title.textContent = '2x Energy Hour';
    // The server is the source of truth for remaining uses; until it has
    // answered, show the default availability copy.
    const left = hh && hh.usesRemaining != null ? Math.max(0, Number(hh.usesRemaining) || 0) : null;
    if (left === 0) {
      if (sub) sub.textContent = 'All 2x Energy Hours used today · Available again tomorrow';
      if (btn) btn.hidden = true;
    } else {
      const usesTxt = left === null ? '' : left === 1 ? ' · 1 use remaining today' : ` · ${left} uses available today`;
      if (sub) sub.textContent = `Watch an ad to activate 2× Energy${usesTxt}`;
      if (btn) { btn.hidden = false; btn.disabled = false; }
    }
    return;
  }
  banner.classList.remove('idle');
  if (btn) btn.hidden = true;
  if (title) title.textContent = `⚡ 2x ENERGY HOUR — ${hh.multiplier}× LIVE`;
  updateEhCountdown(hh.endsAt);
  if (ehTimer) clearInterval(ehTimer);
  ehTimer = setInterval(() => updateEhCountdown(hh.endsAt), 1000);
  if (ehAnnouncedFor !== hh.endsAt) {
    ehAnnouncedFor = hh.endsAt;
    // Same branded popup as reward claims — celebrate() handles sound/haptics.
    const minsLeft = Math.max(1, Math.round((new Date(hh.endsAt).getTime() - Date.now()) / 60000));
    celebrate({
      milestone: true,
      title: `2x Energy Hour — ${hh.multiplier}× LIVE ⚡`,
      subtitle: `Every ad pays ${hh.multiplier}× Energy for the next ${minsLeft} min.`,
      icon: '⚡',
      duration: 3200,
    });
  }
}
// Human-friendly window length for popups: 60 → "1 hour", 90 → "90 minutes".
function fmtHourDuration(mins) {
  const m = Math.max(1, Math.round(Number(mins) || 60));
  if (m === 60) return '1 hour';
  return m % 60 === 0 ? `${m / 60} hours` : `${m} minute${m === 1 ? '' : 's'}`;
}
// Watch an ad, then ask the server to start one of today's 2x Energy Hours.
// The server enforces the daily limit — a cancelled/failed ad never reaches
// the API, so it can't consume one of the day's uses.
async function activateEnergyHour(btn) {
  if (window.ADS_ENABLED === false) { toast('Ads are temporarily unavailable — please try again later.'); return; }
  const hh = state.energy?.happyHour;
  if (hh?.active) { toast('A 2x Energy Hour is already running!'); return; }
  if (hh && Number(hh.usesRemaining) <= 0) { toast('All 2x Energy Hours used today — available again tomorrow.'); return; }
  const waitMs = ENERGY_AD_COOLDOWN_MS - (Date.now() - lastEnergyAdAt);
  if (waitMs > 0) { toast(`Please wait ${Math.ceil(waitMs / 1000)}s before the next ad.`); return; }
  if (btn) btn.disabled = true;
  try {
    const ad = await playRewardedAdDetailed();
    if (!ad.earned) { toast(ad.reason === 'closed' ? 'Ad not completed — 2x Energy Hour not activated.' : adFailureText(ad.reason)); return; }
    lastEnergyAdAt = Date.now();
    // One nonce per completed ad — the server refuses duplicate activations
    // (double SDK callbacks, network retries, replays) without consuming a use.
    const r = await postAdReward('/energy/hour/activate', { adNonce: ad.nonce || newAdNonce() }, {
      onConfirming: () => toast('Confirming your ad…', { tone: 'info' }),
    });
    state.energy = r;
    // The detailed popup below covers the announcement — don't double-notify.
    ehAnnouncedFor = r.happyHour?.endsAt || null;
    renderEnergy();
    const left = Math.max(0, Number(r.happyHour?.usesRemaining) || 0);
    celebrate({
      milestone: true,
      title: '2x Energy Hour Activated! ⚡',
      subtitle: `${r.happyHour?.multiplier || 2}× Energy on every ad for the next ${fmtHourDuration(r.happyHour?.durationMinutes)} · ${left === 1 ? '1 use remaining today' : left === 0 ? 'no uses left today' : `${left} uses remaining today`}.`,
      icon: '⚡',
      duration: 3200,
    });
  } catch (e) {
    if (e.data) { state.energy = e.data; renderEnergy(); }
    toast(e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}
// Rewarded ads may not be requested back-to-back — enforce a 30s gap between views.
const ENERGY_AD_COOLDOWN_MS = 30000;
let lastEnergyAdAt = 0;
/** Watch a rewarded ad and bank its Energy. Resolves true when Energy was credited. */
async function earnEnergy(btn) {
  if (window.ADS_ENABLED === false) { toast('Ads are temporarily unavailable — please try again later.'); return false; }
  const waitMs = ENERGY_AD_COOLDOWN_MS - (Date.now() - lastEnergyAdAt);
  if (waitMs > 0) { toast(`Please wait ${Math.ceil(waitMs / 1000)}s before the next ad.`); return false; }
  if (btn) btn.disabled = true;
  try {
    const ad = await playRewardedAdDetailed();
    if (!ad.earned) { toast(ad.reason === 'closed' ? 'Ad not completed — no Energy earned.' : adFailureText(ad.reason)); return false; }
    lastEnergyAdAt = Date.now();
    // The account is the source of truth — the server credits and returns it. One nonce
    // per completed ad lets the server refuse duplicate credits (double SDK callbacks,
    // network retries, replays) and tie the credit to AdMob's own confirmation.
    const r = await postAdReward('/energy/earn', { adNonce: ad.nonce || newAdNonce() }, {
      onConfirming: () => toast('Confirming your ad…', { tone: 'info' }),
    });
    state.energy = r;
    renderEnergy();
    const gained = Number(r.earned) || 1;
    celebrate({
      amount: gained,
      unit: 'Energy',
      icon: '⚡',
      title: r.happyHour?.active ? `2x Energy Hour — ${r.happyHour.multiplier}× Energy!` : 'Energy earned!',
      subtitle: `You now have ${fmt(r.energy)} ⚡ total.`,
      duration: 2600,
    });
    return true;
  } catch (e) {
    if (e.alreadyCredited) {
      // The first request went through even though its reply was lost — just refresh.
      await loadEnergy(undefined, { force: true }).catch(() => {});
      toast('Energy credited ⚡', { tone: 'success' });
      return true;
    }
    if (e.data && typeof e.data.energy === 'number') { state.energy = e.data; renderEnergy(); }
    toast(e.message);
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

const DAILY_LADDER_STEPS = [
  { label: '1', reward: 1, free: true },
  { label: '2', reward: 1, requiresAd: true },
  { label: '3', reward: 1, requiresAd: true },
  { label: '4', reward: 1, requiresAd: true },
  { label: '5', reward: 1, requiresAd: true },
  { label: '6', reward: 1, requiresAd: true },
  { label: '7', reward: 1, requiresAd: true },
  { label: '8', reward: 1, requiresAd: true },
  { label: '9', reward: 1, requiresAd: true },
  { label: '10', reward: 5, requiresAd: true, bonus: true },
  { label: '11', reward: 1, requiresAd: true },
  { label: '12', reward: 1, requiresAd: true },
  { label: '13', reward: 1, requiresAd: true },
  { label: '14', reward: 1, requiresAd: true },
  { label: '15', reward: 5, requiresAd: true, bonus: true }
];

function dailyLadderState() {
  const key = 'dltx_daily_ladder';
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    const today = new Date().toISOString().slice(0, 10);
    if (!raw.day || raw.day !== today) {
      return { day: today, claimed: Array(DAILY_LADDER_STEPS.length).fill(false) };
    }
    return { day: raw.day, claimed: Array.isArray(raw.claimed) ? raw.claimed.slice(0, DAILY_LADDER_STEPS.length) : Array(DAILY_LADDER_STEPS.length).fill(false) };
  } catch {
    return { day: new Date().toISOString().slice(0, 10), claimed: Array(DAILY_LADDER_STEPS.length).fill(false) };
  }
}

function saveDailyLadderState(data) {
  localStorage.setItem('dltx_daily_ladder', JSON.stringify(data));
}

function renderDailyLadder() {
  const host = $('dailyLadder');
  if (!host) return;
  const state = dailyLadderState();
  // Server-provided amounts win over the bundled fallbacks — rebalances
  // reach installed apps without a new build.
  const serverRewards = serverBonusValues()?.ladderRewards;
  const rewards = Array.isArray(serverRewards) && serverRewards.length === DAILY_LADDER_STEPS.length
    ? serverRewards : DAILY_LADDER_STEPS.map((s) => s.reward);
  host.innerHTML = DAILY_LADDER_STEPS.map((step, index) => {
    const reward = rewards[index];
    const claimed = state.claimed[index];
    const canUnlock = index === 0 || (index > 0 && state.claimed[index - 1]);
    const badge = claimed ? 'Claimed ✓' : canUnlock ? `+${reward} ⚡` : 'Locked';
    const bonus = reward > Math.min(...rewards);
    const cls = ['ladder-step', claimed ? 'claimed' : (canUnlock ? 'ready' : 'locked'), bonus ? 'bonus' : ''].filter(Boolean).join(' ');
    return `<button class="${cls}" data-ladder-step="${index}" ${claimed || !canUnlock ? 'disabled' : ''}>
      <span>${step.label}</span>
      <small>${badge}</small>
    </button>`;
  }).join('');
  host.querySelectorAll('[data-ladder-step]').forEach((btn) => {
    btn.addEventListener('click', () => claimLadderStep(Number(btn.dataset.ladderStep)));
  });
  const fill = $('ladderProgressFill');
  if (fill) fill.style.width = `${Math.round((state.claimed.filter(Boolean).length / DAILY_LADDER_STEPS.length) * 100)}%`;
}

async function claimLadderStep(stepIndex) {
  const step = DAILY_LADDER_STEPS[stepIndex];
  if (!step) return;
  const state = dailyLadderState();
  if (state.claimed[stepIndex]) return;
  if (stepIndex > 0 && !state.claimed[stepIndex - 1]) {
    toast('Complete the previous ladder step first.');
    return;
  }

  try {
    if (step.requiresAd) {
      const earned = await playRewardedAd();
      if (!earned) {
        toast('Ad not completed — the ladder step stays locked.');
        return;
      }
    }

    const r = await api('POST', '/energy/bonus', { reason: `daily_ladder_${stepIndex + 1}` });
    state.claimed[stepIndex] = true;
    saveDailyLadderState(state);
    adoptEnergy(r); // local `state` shadows the module state here
    renderEnergy();
    renderDailyLadder();
    const awarded = Number(r.awarded ?? step.reward);
    celebrate({
      amount: awarded,
      unit: 'Energy',
      icon: '⚡',
      title: `Ladder step ${step.label}!`,
      subtitle: r.capped && awarded === 0
        ? 'Daily free-Energy allowance reached — step saved for your streak.'
        : `+${awarded} ⚡ added to your Energy total.`,
      duration: 2600,
    });
  } catch (e) {
    toast(e.message || 'Unable to claim ladder reward.');
  }
}

const WEEKLY_CHECKIN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weeklyCalendarState() {
  const key = 'dltx_week_calendar';
  const weekKey = (() => {
    const d = new Date();
    const sunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
    return sunday.toISOString().slice(0, 10);
  })();
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    if (!raw.weekKey || raw.weekKey !== weekKey) {
      return { weekKey, claimed: Array(7).fill(false) };
    }
    return { weekKey: raw.weekKey, claimed: Array.isArray(raw.claimed) ? raw.claimed.slice(0, 7) : Array(7).fill(false) };
  } catch {
    return { weekKey, claimed: Array(7).fill(false) };
  }
}

function saveWeeklyCalendarState(data) {
  localStorage.setItem('dltx_week_calendar', JSON.stringify(data));
}

function renderWeekCalendar() {
  const host = $('weekCalendar');
  if (!host) return;
  const state = weeklyCalendarState();
  const day = new Date().getDay();
  const wd = Number(serverBonusValues()?.calendarWeekdayReward) || 1;
  const we = Number(serverBonusValues()?.calendarWeekendReward) || 2;
  host.innerHTML = WEEKLY_CHECKIN_DAYS.map((label, index) => {
    const claimed = state.claimed[index];
    const isToday = index === day;
    return `<button class="calendar-day ${claimed ? 'claimed' : ''} ${isToday ? 'today' : ''}" data-calendar-day="${index}" ${claimed ? 'disabled' : ''}>
      <span>${label}</span>
      <small>${claimed ? '✓' : isToday ? 'Today' : '+' + (index < 5 ? wd : we) + ' ⚡'}</small>
    </button>`;
  }).join('');
  host.querySelectorAll('[data-calendar-day]').forEach((btn) => {
    btn.addEventListener('click', () => claimWeeklyDay(Number(btn.dataset.calendarDay)));
  });
}

async function claimWeeklyDay(dayIndex) {
  const state = weeklyCalendarState();
  if (state.claimed[dayIndex]) return;
  const today = new Date().getDay();
  if (dayIndex > today) {
    toast('You can only claim the current day and earlier days in this week.');
    return;
  }

  try {
    const earned = await playRewardedAd();
    if (!earned) {
      toast('Ad not completed — no daily calendar reward was added.');
      return;
    }
    const r = await api('POST', '/energy/bonus', { reason: `weekly_calendar_${dayIndex}` });
    state.claimed[dayIndex] = true;
    saveWeeklyCalendarState(state);
    adoptEnergy(r); // local `state` shadows the module state here
    renderEnergy();
    renderWeekCalendar();
    const awarded = Number(r.awarded ?? 1);
    celebrate({ amount: awarded, unit: 'Energy', icon: '📅', title: 'Daily check-in claimed!', subtitle: `+${awarded} ⚡ added for ${WEEKLY_CHECKIN_DAYS[dayIndex]}.`, duration: 2200 });
  } catch (e) {
    toast(e.message || 'Calendar reward failed.');
  }
}

function rainKey() {
  const d = new Date();
  return `dltx_rain_${d.toISOString().slice(0, 10)}`;
}

function renderRainScene() {
  const host = $('rainScene');
  if (!host) return;
  const key = rainKey();
  const raw = localStorage.getItem(key);
  const collected = raw ? JSON.parse(raw) : [];
  const positions = [
    { x: 18, y: 40 },
    { x: 28, y: 56 },
    { x: 42, y: 50 },
    { x: 58, y: 46 },
    { x: 70, y: 62 },
    { x: 82, y: 44 },
  ];
  const serverValues = serverBonusValues()?.rainValues;
  const values = Array.isArray(serverValues) && serverValues.length === positions.length
    ? serverValues : [1, 1, 2, 2, 2, 2];
  const drops = positions.map((p, i) => ({ ...p, value: values[i] }));
  host.innerHTML = `
    <div class="rain-cloud">☁️</div>
    ${drops.map((drop, idx) => {
      const used = collected.includes(idx);
      return `<button class="rain-drop ${used ? 'collected' : ''}" data-rain-index="${idx}" style="left:${drop.x}%; top:${drop.y}%;" ${used ? 'disabled' : ''}>${drop.value}</button>`;
    }).join('')}
  `;
  host.querySelectorAll('.rain-drop').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.rainIndex);
      if (!Number.isFinite(idx)) return;
      try {
        const earned = await playRewardedAd();
        if (!earned) {
          toast('Ad not completed — the rain drop stays in the sky.');
          return;
        }
        const value = Number(btn.textContent) || 1;
        const r = await api('POST', '/energy/rain', { index: idx });
        const collectedList = JSON.parse(localStorage.getItem(rainKey()) || '[]');
        collectedList.push(idx);
        localStorage.setItem(rainKey(), JSON.stringify(collectedList));
        renderRainScene();
        state.energy = r;
        renderEnergy();
        celebrate({ amount: r.awarded ?? value, unit: 'Energy', icon: '🌧️', title: 'Rain collected!', subtitle: `+${r.awarded ?? value} ⚡ Energy landed in your account.`, duration: 2200 });
      } catch (e) {
        toast(e.message || 'Rain reward failed.');
      }
    });
  });
}

const TREE_STAGES = ['🌱', '🌿', '🪴', '🌳', '🌴'];
let treeState = null;

async function loadTree() {
  if (!state.token) return;
  try {
    treeState = await api('GET', '/energy/tree');
    renderTree();
  } catch {
    // Non-critical — the tree card just stays in its last known state.
  }
}

function renderTree() {
  const scene = $('treeScene');
  const sub = $('treeSub');
  const btn = $('treeWaterBtn');
  if (!scene || !treeState) return;
  const pct = Math.min(1, treeState.level / treeState.maxLevel);
  const stage = TREE_STAGES[Math.min(TREE_STAGES.length - 1, Math.floor(pct * (TREE_STAGES.length - 1)))];
  scene.textContent = stage;
  if (sub) sub.textContent = treeState.wateredToday
    ? `Level ${treeState.level}/${treeState.maxLevel} · watered today — come back tomorrow 🌤️`
    : `Level ${treeState.level}/${treeState.maxLevel} · costs ⚡ ${treeState.waterCost} Energy to water`;
  if (btn) {
    btn.disabled = treeState.wateredToday || treeState.energy < treeState.waterCost;
    btn.textContent = treeState.wateredToday ? '✓ Watered today' : `💧 Water the tree · ⚡${treeState.waterCost}`;
  }
  const fill = $('treeProgressFill');
  if (fill) fill.style.width = `${Math.round(pct * 100)}%`;
}

async function waterTree() {
  if (!treeState || treeState.wateredToday) return;
  const btn = $('treeWaterBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/energy/tree/water', { ...await getIntegrityPayload() });
    treeState = { ...treeState, level: r.level, wateredToday: true, energy: r.energy };
    renderTree();
    const rw = r.reward || {};
    if (rw.dltx > 0) {
      celebrate({ amount: rw.dltx, title: 'Tree watered! 🌴', subtitle: `Grew to level ${r.level}.`, icon: '💧' });
    } else if (rw.energy > 0) {
      celebrate({ amount: rw.energy, unit: 'Energy', title: 'Tree watered! 🌴', subtitle: `Grew to level ${r.level}.`, icon: '💧' });
    } else {
      toast(`Tree grew to level ${r.level} 🌴`);
    }
    Promise.allSettled([loadWallet(), loadEnergy(undefined, { force: true })]);
  } catch (e) {
    toast(e.message || 'Unable to water the tree.');
    renderTree();
  } finally {
    if (btn) btn.disabled = treeState?.wateredToday || false;
  }
}

$('treeWaterBtn')?.addEventListener('click', waterTree);

// ==================== Deltix Bot (canned companion, no LLM) ====================
function addBotMessage(role, text) {
  const list = $('botMessages');
  if (!list) return;
  const div = document.createElement('div');
  div.className = `bot-msg ${role}`;
  div.textContent = text;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function ensureBotGreeting() {
  const list = $('botMessages');
  if (list && !list.children.length) {
    addBotMessage('bot', 'Hey! I\u2019m the Deltix Bot 🤖 — ask me about Energy, staking, referrals, missions, the Vault, Puzzle, Tree, Ladder, Rain, Season, or the Shop.');
  }
}

async function sendBotMessage() {
  const input = $('botInput');
  const text = input?.value.trim();
  if (!text || !state.token) return;
  input.value = '';
  addBotMessage('user', text);
  try {
    const r = await api('POST', '/bot/ask', { message: text });
    addBotMessage('bot', r.reply);
  } catch (e) {
    addBotMessage('bot', e.message || 'Sorry, I couldn\u2019t reach the server just now.');
  }
}

$('botSend')?.addEventListener('click', sendBotMessage);
$('botInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendBotMessage(); });

/**
 * In-app notification card — a push-notification-style banner used for
 * reminders/nudges. Branded and tappable (opens the relevant tab), with its
 * own dismiss control; a step up in polish from the plain toast pill.
 */
let appNoticeTimer;
function notify({ icon = '◆', title = 'Deltix', message = '', tab = null, duration = 6500, tone = 'info' } = {}) {
  document.getElementById('appNotice')?.remove();
  clearTimeout(appNoticeTimer);
  const el = document.createElement('div');
  el.className = `app-notice an-${tone}`;
  el.id = 'appNotice';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="an-icon">${icon}</div>
    <div class="an-body">
      <div class="an-app">◆ Deltix</div>
      <div class="an-title">${title}</div>
      <div class="an-msg">${message}</div>
    </div>
    <button class="an-close" type="button" aria-label="Dismiss">✕</button>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => {
    clearTimeout(appNoticeTimer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 280);
  };
  el.querySelector('.an-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
  if (tab) {
    el.classList.add('tappable');
    el.addEventListener('click', () => { close(); try { showTab(tab); } catch {} });
  }
  appNoticeTimer = setTimeout(close, duration);
}

/**
 * Bot "notification" — a one-shot nudge toward the single highest-value
 * unclaimed daily action, computed entirely from state already in memory
 * (no extra network calls, no push infrastructure required).
 */
function checkBotNudge() {
  if (!state.token) return;
  const nudges = [];
  if (rewardState?.data?.checkin?.ready) {
    nudges.push({
      icon: '📅',
      title: 'Daily Check-in Ready',
      message: 'Your daily reward is waiting in Rewards — tap to claim it.',
      tab: 'tab-rewards',
    });
  }
  if (treeState && !treeState.wateredToday && treeState.energy >= treeState.waterCost) {
    nudges.push({
      icon: '🌴',
      title: 'Deltix Tree Reminder',
      message: 'Your tree hasn\u2019t been watered today — water it to grow a level and collect a reward.',
      tab: 'tab-energy',
    });
  }
  const hh = state.energy?.happyHour;
  if (hh && !hh.active && Number(hh.usesRemaining) > 0) {
    nudges.push({
      icon: '⚡',
      title: '2x Energy Hour Available',
      message: `Watch an ad to double your Energy earnings for a full hour · ${hh.usesRemaining} of ${hh.maxPerDay || 2} left today.`,
      tab: 'tab-energy',
    });
  }
  const ladder = (() => { try { return JSON.parse(localStorage.getItem('dltx_daily_ladder') || '{}'); } catch { return {}; } })();
  if (Array.isArray(ladder.claimed) && !ladder.claimed[0]) {
    nudges.push({
      icon: '🪜',
      title: 'Free Ladder Step Available',
      message: 'Step 1 of today\u2019s Daily Ladder is free — tap to claim it.',
      tab: 'tab-game-ladder',
    });
  }
  if (!nudges.length) return;
  notify(nudges[Math.floor(Math.random() * nudges.length)]);
}

// ==================== Deltix KYC (Persona, opt-in, off unless enabled) ====================
function setVerifiedBadge(on) {
  const wrap = document.querySelector('.avatar-wrap');
  const badge = $('verifiedBadge');
  if (wrap) wrap.classList.toggle('verified', Boolean(on));
  if (badge) badge.hidden = !on;
}

async function loadKycStatus() {
  if (!state.token) return;
  const title = $('kycTitle');
  const sub = $('kycSub');
  const btn = $('kycActionBtn');
  try {
    const r = await api('GET', '/kyc/status');
    // Status is reported truthfully even while new verifications are paused —
    // an already-earned badge must never disappear just because `enabled`
    // is currently false.
    if (r.status === 'approved') {
      if (title) title.textContent = 'Identity Verified ✅';
      if (sub) sub.textContent = 'Verified badge added to your profile and Deltix Passport.';
      if (btn) btn.hidden = true;
      setVerifiedBadge(true);
    } else if (r.status === 'pending') {
      if (title) title.textContent = 'Verification Pending ⏳';
      if (sub) sub.textContent = 'We\u2019re reviewing your submission.';
      if (btn) btn.hidden = true;
      setVerifiedBadge(false);
    } else if (!r.enabled) {
      if (title) title.textContent = 'Identity Verification';
      if (sub) sub.textContent = 'Not available yet — check back soon.';
      if (btn) btn.hidden = true;
      setVerifiedBadge(false);
    } else {
      if (title) title.textContent = 'Verify Identity';
      if (sub) sub.textContent = 'Unlock extra features with a quick identity check.';
      if (btn) {
        btn.hidden = false;
        btn.textContent = 'Verify Identity';
        btn.onclick = () => { if (r.hostedFlowUrl) window.open(r.hostedFlowUrl, '_blank', 'noopener'); };
      }
      setVerifiedBadge(false);
    }
  } catch {
    // Non-critical — leave the card in its last known state if the check fails.
  }
}

$('energyEarnBtn')?.addEventListener('click', (e) => earnEnergy(e.currentTarget));
$('energyHourBtn')?.addEventListener('click', (e) => activateEnergyHour(e.currentTarget));
$('homeEarnBtn')?.addEventListener('click', () => {
  showTab('tab-earn');
  if (state.token) loadEarn().catch(() => {});
});

// ==================== Deltix P2P Marketplace (server-gated) ====================
// Everything here only MIRRORS backend state — every rule (KYC, escrow,
// moderator release, fees) is enforced server-side. The tab stays hidden
// until /p2p/status reports the marketplace enabled.
const p2p = {
  status: null,
  kyc: 'none',
  view: 'buy',
  isModerator: false,
  offer: null,
  order: null,
  createSide: 'sell',
  chatTimer: null,
  payTimer: null,
  lastAdAt: 0,
  admins: [],
  adminsTimer: null,
  heartbeatTimer: null,
  me: null,
};

// ── Live admin directory (referral code + derived state only; server decides ONLINE/BUSY/OFFLINE) ──
function p2pAdminChip(status) {
  const map = { ONLINE: ['● Online', 'ok'], BUSY: ['● Busy', 'warn'], OFFLINE: ['○ Offline', 'muted'] };
  const [label, tone] = map[status] || ['—', 'muted'];
  return `<span class="p2p-chip p2p-chip-${tone}">${label}</span>`;
}
async function loadP2pAdmins({ silent = false } = {}) {
  const card = $('p2pAdminsCard');
  if (!card || !state.token || !p2p.status?.enabled) return;
  try {
    const r = await api('GET', '/p2p/admins');
    p2p.admins = r.admins || [];
    card.hidden = !p2p.admins.length;
    $('p2pAdminsCount').textContent = `${r.onlineCount} online · ${p2p.admins.length} total`;
    $('p2pAdminsList').innerHTML = p2p.admins.slice(0, 12).map((a) => `
      <div class="p2p-admin-line ${a.status.toLowerCase()}">
        <span class="p2p-admin-id">🛡 <b>${escapeHtml(a.code || '#' + a.id)}</b>${a.senior ? ' <span class="pill">SENIOR</span>' : ''}</span>
        <span class="p2p-admin-load muted small-note">${a.activeTrades}/${a.capacity} trades</span>
        ${p2pAdminChip(a.status)}
      </div>`).join('');
    // Keep an open offer modal's selector in sync.
    if (!$('p2pOfferModal').hidden) p2pFillAdminSelect();
  } catch (e) { if (!silent) card.hidden = true; }
}
function startP2pAdminsPoll() {
  stopP2pAdminsPoll();
  loadP2pAdmins({ silent: true });
  p2p.adminsTimer = setInterval(() => loadP2pAdmins({ silent: true }), 30000);
}
function stopP2pAdminsPoll() {
  if (p2p.adminsTimer) { clearInterval(p2p.adminsTimer); p2p.adminsTimer = null; }
}
// Offer modal: choose which ONLINE admin handles the trade (default = least loaded).
function p2pFillAdminSelect() {
  const sel = $('p2pAdminSelect');
  if (!sel) return;
  const prev = sel.value;
  const online = p2p.admins.filter((a) => a.status === 'ONLINE');
  sel.innerHTML = `<option value="">Auto — least busy online admin${online.length ? ` (${online.length} online)` : ''}</option>` +
    p2p.admins.map((a) => `<option value="${a.id}" ${a.status !== 'ONLINE' ? 'disabled' : ''}>${escapeHtml(a.code || '#' + a.id)} · ${a.status.toLowerCase()} · ${a.activeTrades}/${a.capacity}${a.senior ? ' · senior' : ''}</option>`).join('');
  if ([...sel.options].some((o) => o.value === prev && !o.disabled)) sel.value = prev;
  $('p2pAdminSelectHint').textContent = online.length
    ? 'Only online admins can be chosen. Your admin verifies the USDT payment and approves the release — they never hold your coins.'
    : 'No admin is online right now — the trade will still be created and assigned; you can request another admin from the order if needed.';
}

// ── Moderator presence: explicit availability + 60s heartbeat while the app is open ──
async function p2pSetAvailability(on) {
  const r = await api('POST', '/p2p/moderation/presence', { available: on });
  p2p.me = r.me;
  if (on) startP2pHeartbeat(); else stopP2pHeartbeat();
  return r.me;
}
function startP2pHeartbeat() {
  stopP2pHeartbeat();
  p2p.heartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    api('POST', '/p2p/moderation/heartbeat', {}).then((r) => { p2p.me = r.me; p2pRenderPresence(); }).catch(() => {});
  }, 60000);
}
function stopP2pHeartbeat() {
  if (p2p.heartbeatTimer) { clearInterval(p2p.heartbeatTimer); p2p.heartbeatTimer = null; }
}
function p2pRenderPresence() {
  const el = $('p2pPresenceState');
  if (!el || !p2p.me) return;
  el.innerHTML = `${p2pAdminChip(p2p.me.status)} <span class="muted small-note">${p2p.me.activeTrades}/${p2p.me.capacity} active trades · ${escapeHtml(p2p.me.code || '')}</span>`;
  const tg = $('p2pPresenceToggle');
  if (tg) tg.checked = Boolean(p2p.me.availabilityEnabled);
}

// The JWT `sub` claim is this account's immutable user id (no verification
// needed client-side — only used to render "mine" states).
function myUserId() {
  try {
    const part = state.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return String(JSON.parse(atob(part)).sub || '');
  } catch { return ''; }
}

// Interstitial at natural P2P transition points, capped to one per 2 minutes.
function p2pMaybeAd() {
  if (Date.now() - p2p.lastAdAt < 120000) return;
  p2p.lastAdAt = Date.now();
  if (typeof showPreloadedInterstitial === 'function') showPreloadedInterstitial();
}

async function loadP2pStatus() {
  if (!state.token) return null;
  try {
    p2p.status = await api('GET', '/p2p/status');
    const nav = $('navP2p');
    if (nav) nav.hidden = !p2p.status.enabled;
    return p2p.status;
  } catch {
    return null;
  }
}

async function loadP2p() {
  if (!state.token) return;
  if (!p2p.status) await loadP2pStatus();
  const simPill = $('p2pSimPill');
  if (simPill) simPill.hidden = !p2p.status?.simulationMode;
  // KYC gate mirrors the server rule (the server enforces it regardless).
  try {
    const k = await api('GET', '/kyc/status');
    p2p.kyc = k.status || 'none';
    const gate = Boolean(p2p.status?.kycRequired) && p2p.kyc !== 'approved';
    $('p2pKycCard').hidden = !gate;
    $('p2pMain').hidden = gate;
    const kycBtn = $('p2pKycBtn');
    if (kycBtn) {
      kycBtn.onclick = () => {
        if (k.enabled && k.hostedFlowUrl) window.open(k.hostedFlowUrl, '_blank', 'noopener');
        else toast('Identity verification opens here soon — not available yet.', { tone: 'info' });
      };
    }
    if (gate) return;
  } catch { /* keep last state */ }
  const ref = $('p2pRefRate');
  if (ref) {
    ref.hidden = !p2p.status?.referenceRateUsdt;
    if (p2p.status?.referenceRateUsdt) ref.textContent = `Official reference rate: ${p2p.status.referenceRateUsdt} USDT/DLTX (guidance — you set your own price)`;
  }
  const myC = $('p2pMyContact');
  if (myC && !myC.matches(':focus')) myC.value = p2p.status?.myContact || '';
  loadP2pWalletSettings();
  // Moderator probe: the queue answers 200 only for moderator roles.
  try {
    const q = await api('GET', '/p2p/moderation/queue');
    p2p.isModerator = true;
    p2p.modQueue = q.queue || [];
  } catch {
    p2p.isModerator = false;
    p2p.modQueue = [];
  }
  $('p2pModTab').hidden = !p2p.isModerator;
  if (p2p.isModerator) {
    try {
      const pr = await api('GET', '/p2p/moderation/presence');
      p2p.me = pr.me;
      if (pr.me?.availabilityEnabled) startP2pHeartbeat();
    } catch { /* presence optional */ }
  }
  startP2pAdminsPoll();
  renderP2pView();
}

function p2pStatusChip(s) {
  const map = {
    awaiting_usdt: ['Pay now', 'warn'],
    dltx_locked: ['Reserved', 'warn'],
    usdt_submitted: ['Verifying', 'warn'],
    usdt_verifying: ['Verifying', 'warn'],
    usdt_verified: ['Verified', 'ok'],
    awaiting_moderator_approval: ['Moderator review', 'warn'],
    completed: ['Completed', 'ok'],
    cancelled: ['Cancelled', 'muted'],
    refunded: ['Refunded', 'muted'],
    under_review: ['Dispute review', 'bad'],
    disputed: ['Disputed', 'bad'],
    escalated: ['Escalated', 'bad'],
    security_hold: ['Security hold', 'bad'],
    // Ad lifecycle
    active: ['Active', 'ok'],
    paused: ['Paused', 'warn'],
    filled: ['Completed', 'ok'],
    expired: ['Expired', 'muted'],
  };
  const [label, tone] = map[s] || [s.replace(/_/g, ' '), 'muted'];
  return `<span class="p2p-chip p2p-chip-${tone}">${label}</span>`;
}

// Public P2P identifier chip ("Seller: DLTX-XXXXXX") — never email/IP.
function p2pCodeChip(code, label) {
  if (!code) return '';
  return `<span class="p2p-code" title="Deltix ID">${label ? escapeHtml(label) + ': ' : ''}<b>${escapeHtml(code)}</b></span>`;
}
function p2pWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ── P2P settings: USDT payout wallet (address only; trades keep their snapshot) ──
async function loadP2pWalletSettings() {
  const cur = $('p2pMyWalletCurrent');
  if (!cur) return;
  try {
    const r = await api('GET', '/p2p/wallets');
    const net = (r.networks || [])[0] || { id: 'bep20', label: 'USDT — BNB Chain (BEP-20)' };
    p2p.walletNetwork = net.id;
    $('p2pMyWalletNet').textContent = net.label.replace(/^USDT\s*[—-]\s*/, '');
    const w = (r.wallets || []).find((x) => x.network === net.id);
    p2p.myWallet = w ? w.address : null;
    cur.innerHTML = w
      ? `Current: <code class="p2p-addr-inline">${escapeHtml(w.address)}</code> <span class="muted">· updated ${p2pWhen(w.updatedAt)}</span>`
      : 'No payout address saved yet — required before you can post a SELL ad.';
    const codeEl = $('p2pMyCode');
    if (codeEl && state.refCode) codeEl.innerHTML = `🆔 Your public trader ID: <b>${escapeHtml(state.refCode)}</b> — shown on your ads so partners and moderators can identify you.`;
  } catch { /* keep last state */ }
  loadP2pEscrow();
  const dltx = $('p2pDltxOfficial');
  if (dltx) dltx.textContent = p2p.status?.platformDltxAddress || '';
}

// Escrow position: what is locked vs what open trades need; the difference is
// releasable (server decides — coins backing a live trade are never freed).
async function loadP2pEscrow() {
  const row = $('p2pEscrowRow');
  if (!row) return;
  try {
    const e = await api('GET', '/p2p/escrow');
    p2p.escrow = e;
    row.innerHTML = `<span>Locked <b>${fmt(e.locked)} DLTX</b></span><span>Backing <b>${e.openOrders} open trade${e.openOrders === 1 ? '' : 's'} (${fmt(e.obligations)})</b></span><span class="${e.releasable > 0 ? 'p2p-green-t' : ''}">Releasable <b>${fmt(e.releasable)} DLTX</b></span>`;
    const btn = $('p2pEscrowRelease');
    btn.hidden = !(e.locked > 0);
    btn.disabled = !(e.releasable > 0);
    btn.textContent = e.releasable > 0 ? `Release ${fmt(e.releasable)} DLTX to transferable` : 'Nothing to release';
  } catch (err) { row.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`; }
}
$('p2pEscrowRelease')?.addEventListener('click', async () => {
  const e = p2p.escrow;
  if (!e || !(e.releasable > 0)) return;
  const okGo = await askConfirm({ title: 'Release locked coins?', message: 'Returns DLTX left over from finished trades to your transferable balance. Coins backing open trades stay locked.', rows: [['Release', `${fmt(e.releasable)} DLTX`], ['Stays locked', `${fmt(e.obligations)} DLTX`]], confirmText: 'Release' });
  if (!okGo) return;
  try {
    const r = await api('POST', '/p2p/escrow/release', {});
    toast(r.message, { tone: r.released > 0 ? 'success' : 'info', title: r.released > 0 ? 'Released' : undefined });
    loadP2pEscrow();
    loadWallet();
  } catch (err) { toast(err.message, { tone: 'error' }); }
});
$('p2pDltxCopy')?.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('p2pDltxOfficial').textContent); toast('Official DLTX wallet address copied', { tone: 'success' }); }
  catch { toast('Copy failed — long-press the address instead', { tone: 'error' }); }
});
$('p2pDltxSend')?.addEventListener('click', () => {
  const addr = $('p2pDltxOfficial').textContent.trim();
  if (!addr) return;
  $('sendBtn').click();
  $('sendTo').value = addr;
  $('sendHint').textContent = `Sending to the OFFICIAL Deltix P2P wallet · ${$('sendHint').textContent}`;
});

$('p2pMyWalletSave')?.addEventListener('click', async () => {
  const input = $('p2pMyWallet');
  const address = input.value.trim();
  if (!address) { toast('Enter your public USDT receiving address', { tone: 'error' }); return; }
  const net = p2p.walletNetwork || 'bep20';
  const label = $('p2pMyWalletNet').textContent;
  const okGo = await askConfirm({
    title: p2p.myWallet ? 'Change USDT payout address?' : 'Save USDT payout address?',
    message: p2p.myWallet ? 'Open trades keep the address they started with. New trades will pay to the new address.' : 'The platform pays your USDT here after each release.',
    rows: [['Network', label], ['Address', address.length > 20 ? address.slice(0, 10) + '…' + address.slice(-8) : address]],
    confirmText: 'Confirm network & save',
  });
  if (!okGo) return;
  try {
    const r = await api('POST', '/p2p/wallets', { network: net, address, confirmNetwork: net });
    input.value = '';
    toast(r.unchanged ? 'That is already your payout address' : (r.previousAddress ? 'Payout address updated' : 'Payout address saved'), { tone: 'success' });
    loadP2pWalletSettings();
  } catch (e) { toast(e.message, { tone: 'error' }); }
});

async function renderP2pView() {
  const list = $('p2pList');
  if (!list) return;
  document.querySelectorAll('#tab-p2p .p2p-bs').forEach((b) => b.classList.toggle('active', b.dataset.view === p2p.view));
  document.querySelectorAll('#tab-p2p .p2p-tool[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === p2p.view));
  $('p2pCreateBtn').hidden = p2p.view === 'orders' || p2p.view === 'mod' || !p2p.status?.newOrdersEnabled;
  list.innerHTML = '<p class="muted center">Loading…</p>';
  try {
    if (p2p.view === 'buy' || p2p.view === 'sell') {
      // BUY tab shows people SELLING (you buy from them) and vice versa.
      const side = p2p.view === 'buy' ? 'sell' : 'buy';
      const r = await api('GET', `/p2p/offers?side=${side}`);
      const offers = r.offers || [];
      const cta = p2p.view === 'buy' ? 'Buy' : 'Sell';
      if (!offers.length) {
        list.innerHTML = `<p class="muted center">No ${side === 'sell' ? 'sellers' : 'buyers'} right now. Post the first ad!</p>`;
        return;
      }
      list.innerHTML = `<div class="p2p-listhead"><span>${offers.length} advertiser${offers.length > 1 ? 's' : ''} ${side === 'sell' ? 'selling' : 'buying'} DLTX</span><span>Price</span></div>` +
        offers.map((o) => {
          const t = o.trader;
          return `
        <div class="p2p-adv" data-offer="${o.id}">
          <div class="p2p-adv-head">
            <button class="p2p-trader" data-trader="${t ? t.userId : ''}">
              <span class="p2p-avatar" style="--h:${t ? (Number(t.userId) * 47) % 360 : 200}">T</span>
              <span class="p2p-trader-name">${t ? escapeHtml(t.displayName) : 'Trader'}${t?.kycVerified ? ' <span class="p2p-verif">✓</span>' : ''}${t?.merchant ? ' <span class="p2p-merch">★</span>' : ''}</span>
            </button>
            ${o.mine ? '<span class="pill">YOUR AD</span>' : ''}${o.simulation ? '<span class="pill">SIM</span>' : ''}
          </div>
          <div class="p2p-adv-substats">${t ? `${t.completedTrades} trades · ${t.completionRate}% completion` : ''}${t?.referralCode ? ` · ${p2pCodeChip(t.referralCode, side === 'sell' ? 'Seller' : 'Buyer')}` : ''}</div>
          <div class="p2p-adv-mid">
            <div class="p2p-adv-price">${o.priceUsdt} <small>USDT</small></div>
            ${o.mine ? `<button class="p2p-cta mine" data-manage="${o.id}">Manage</button>` : `<button class="p2p-cta ${p2p.view}" data-offer-open="${o.id}">${cta} DLTX</button>`}
          </div>
          <div class="p2p-adv-meta">
            <span>Available <b>${fmt(o.remainingDltx)} DLTX</b></span>
            <span>Limit <b>${fmt(o.minDltx)}–${fmt(o.maxDltx)}</b></span>
          </div>
          <div class="p2p-chips-row">
            <span class="p2p-paychip">USDT · BEP-20</span>
            <span class="p2p-paychip escrow">🛡 Escrow</span>
            ${o.terms ? `<span class="p2p-paychip">${escapeHtml(o.terms.slice(0, 42))}</span>` : ''}
          </div>
        </div>`;
        }).join('');
      list.querySelectorAll('[data-offer-open]').forEach((el) =>
        el.addEventListener('click', (e) => { e.stopPropagation(); openP2pOffer(el.dataset.offerOpen); }));
      list.querySelectorAll('[data-manage]').forEach((el) =>
        el.addEventListener('click', (e) => { e.stopPropagation(); p2p.view = 'mine'; renderP2pView(); }));
      list.querySelectorAll('.p2p-adv').forEach((el) =>
        el.addEventListener('click', () => openP2pOffer(el.dataset.offer)));
      list.querySelectorAll('[data-trader]').forEach((el) =>
        el.addEventListener('click', (e) => { e.stopPropagation(); if (el.dataset.trader) openP2pTrader(el.dataset.trader); }));
    } else if (p2p.view === 'orders') {
      const r = await api('GET', '/p2p/orders?limit=50');
      const orders = r.orders || [];
      if (!orders.length) { list.innerHTML = '<p class="muted center">No P2P orders yet.</p>'; return; }
      const orderCard = (o) => `
        <div class="card p2p-offer-card" data-order="${o.id}">
          <div class="p2p-offer-top">
            <b>#${o.id} · ${o.role === 'buyer' ? 'Buying' : 'Selling'} ${fmt(o.amountDltx)} DLTX</b>
            ${p2pStatusChip(o.status)}
          </div>
          <div class="muted small-note">${o.priceUsdt} USDT/DLTX · total ${fmt(o.totalUsdt)} USDT${o.simulation ? ' · SIMULATION' : ''}</div>
          <div class="muted small-note">${p2pCodeChip(o.role === 'buyer' ? o.sellerCode : o.buyerCode, o.role === 'buyer' ? 'Seller' : 'Buyer')} · ${p2pWhen(o.createdAt)}</div>
        </div>`;
      list.innerHTML = `<div class="p2p-listhead"><span>${r.total ?? orders.length} order${(r.total ?? orders.length) === 1 ? '' : 's'} · full history kept</span><span></span></div>` +
        `<div id="p2pOrderList">${orders.map(orderCard).join('')}</div>` +
        (r.hasMore ? `<button class="btn ghost p2p-more" id="p2pOrdersMore" data-before="${r.nextBefore}">Load older orders</button>` : '');
      const bind = (root) => root.querySelectorAll('[data-order]').forEach((el) =>
        el.addEventListener('click', () => openP2pOrder(el.dataset.order)));
      bind(list);
      $('p2pOrdersMore')?.addEventListener('click', async () => {
        const btn = $('p2pOrdersMore');
        btn.disabled = true;
        try {
          const more = await api('GET', `/p2p/orders?limit=50&before=${btn.dataset.before}`);
          const frag = document.createElement('div');
          frag.innerHTML = (more.orders || []).map(orderCard).join('');
          bind(frag);
          $('p2pOrderList').append(...frag.childNodes);
          if (more.hasMore) { btn.dataset.before = more.nextBefore; btn.disabled = false; } else btn.remove();
        } catch (e) { btn.disabled = false; toast(e.message, { tone: 'error' }); }
      });
    } else if (p2p.view === 'mine') {
      await renderP2pMyAds(list);
    } else if (p2p.view === 'mod') {
      const [r, mine, comm] = await Promise.all([
        api('GET', '/p2p/moderation/queue'),
        api('GET', '/p2p/moderation/trades').catch(() => ({ trades: [], me: p2p.me })),
        api('GET', '/p2p/moderation/commissions').catch(() => null),
      ]);
      const queue = r.queue || [];
      p2p.me = mine.me || p2p.me;
      const SECTIONS = [['NEW', '🆕 New'], ['ACTIVE', '▶️ Active'], ['PAYMENT_PENDING', '⏳ Payment pending'], ['PAYMENT_MARKED', '🧾 Payment marked'], ['DISPUTED', '⚠️ Disputed'], ['COMPLETED', '✅ Completed'], ['CANCELLED', '↩️ Cancelled'], ['EXPIRED', '⏰ Expired']];
      const trades = mine.trades || [];
      const remain = (s) => (s == null ? '' : ` · ⏱ ${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} left`);
      const tradeCard = (o) => `
        <div class="card p2p-offer-card" data-mod="${o.id}">
          <div class="p2p-offer-top"><b>#${o.id} · ${fmt(o.amountDltx)} DLTX @ ${o.priceUsdt} ↔ ${fmt(o.totalUsdt)} USDT</b> ${p2pStatusChip(o.status)}</div>
          <div class="muted small-note">${p2pCodeChip(o.buyerCode || ('#' + o.buyerId), 'Buyer')} · ${p2pCodeChip(o.sellerCode || ('#' + o.sellerId), 'Seller')}${o.adId ? ` · Ad #${o.adId}` : ''}${o.simulation ? ' · SIMULATION' : ''}</div>
          <div class="muted small-note">Escrow ${fmt(o.escrowAmountDltx)} · payment ${escapeHtml(o.paymentStatus)}${o.disputeStatus ? ` · dispute ${escapeHtml(o.disputeStatus)}` : ''}${remain(o.remainingSeconds)} · ${p2pWhen(o.createdAt)}${o.moderatorReassigned ? ' · reassigned to you' : ''}</div>
        </div>`;
      const period = (p, label) => `<div class="p2p-comm-cell"><span class="muted small-note">${label}</span><b>${fmt(p.commissionDltx)} DLTX</b><span class="muted small-note">${p.completedTrades} trade${p.completedTrades === 1 ? '' : 's'}</span></div>`;
      const commCard = comm ? `
        <div class="card p2p-commissions">
          <div class="p2p-offer-top"><b>💰 My Commissions</b><span class="muted small-note">${comm.policy.sellerFeePercent}% seller · ${comm.policy.buyerFeePercent}% buyer · ${comm.policy.moderatorSharePercent}% share</span></div>
          <div class="p2p-comm-grid">${period(comm.periods.today, 'Today')}${period(comm.periods.days7, '7 days')}${period(comm.periods.days30, '30 days')}${period(comm.periods.allTime, 'All time')}</div>
          <div class="muted small-note">All time: ${comm.periods.allTime.completedTrades} completed · volume ${fmt(comm.periods.allTime.volumeDltx)} DLTX / ${fmt(comm.periods.allTime.volumeUsdt)} USDT · seller fees ${fmt(comm.periods.allTime.sellerFeesUsdt)} USDT · buyer fees ${fmt(comm.periods.allTime.buyerFeesDltx)} DLTX</div>
          <div class="muted small-note">Pending: ${comm.pending.trades} open trade${comm.pending.trades === 1 ? '' : 's'} (≈ ${fmt(comm.pending.commissionDltx)} DLTX if settled) · Failed settlements: ${comm.failedSettlements}</div>
          ${comm.entries.length ? `<details class="p2p-mytrades-sec"><summary>Recent entries <span class="muted small-note">(${comm.entries.length})</span></summary>${comm.entries.slice(0, 30).map((e) => `
            <div class="p2p-comm-row"><span>#${e.tradeId} · ${p2pCodeChip(e.buyerCode, 'B')} ${p2pCodeChip(e.sellerCode, 'S')}</span><span>${fmt(e.amountDltx)} DLTX · fees ${fmt(e.sellerFee.amount)} ${escapeHtml(e.sellerFee.asset.replace(':bep20', ''))} + ${fmt(e.buyerFee.amount)} ${escapeHtml(e.buyerFee.asset)}</span><b class="p2p-green-t">+${fmt(e.commission.amount)} DLTX</b><span class="muted small-note">${escapeHtml(e.status)} · ${p2pWhen(e.at)}</span></div>`).join('')}</details>` : '<p class="hint">No settled commissions yet — commission is earned only when a trade you moderate completes.</p>'}
        </div>` : '';
      list.innerHTML = `
        <div class="p2p-mod-head">
          <div><div class="p2p-mod-title">🛡 Moderation Console</div><div class="muted small-note">${p2p.me?.code ? `Signed in as <b>${escapeHtml(p2p.me.code)}</b> · ` : ''}${(p2p.me?.senior || mine.me?.senior) ? 'Senior moderator · can view every trade, reassign admins, remove ads, ban/unban' : 'Moderator · can review assigned trades, remove ads, ban/unban'}</div></div>
        </div>
        <div class="card p2p-presence">
          <div class="p2p-offer-top">
            <label class="p2p-presence-toggle"><input type="checkbox" id="p2pPresenceToggle" /> <b>Available for P2P trades</b></label>
            <span id="p2pPresenceState"></span>
          </div>
          <p class="hint">While available, traders can select you for new trades (up to ${p2p.me?.capacity ?? '—'} at once). You stay online while the app is open and drop to offline automatically when it is closed. Availability never changes escrow — release still needs a verified payment and your approval.</p>
        </div>
        <div class="card p2p-stats" id="p2pStatsCard">
          <div class="p2p-offer-top"><b>📊 P2P Dashboard</b><span class="muted small-note" id="p2pStatsScope"></span></div>
          <div class="p2p-stats-filters">
            <div class="p2p-chiprow" id="p2pStatsRange">${[['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time'], ['custom', 'Custom']].map(([v, l]) => `<button class="p2p-chipbtn ${v === (p2p.statsRange || 'today') ? 'on' : ''}" data-range="${v}">${l}</button>`).join('')}</div>
            <div class="p2p-bid-row p2p-stats-custom" id="p2pStatsCustom" hidden><input type="date" id="p2pStatsFrom" /><input type="date" id="p2pStatsTo" /><button class="btn ghost" id="p2pStatsApply">Apply</button></div>
            <select id="p2pStatsMod" class="p2p-select"><option value="">All moderators</option></select>
          </div>
          <div id="p2pStatsBody"><p class="muted">Loading statistics…</p></div>
        </div>
        ${commCard}
        <div class="card p2p-modsearch">
          <label for="p2pModSearch">🔍 Trader lookup &amp; enforcement</label>
          <p class="hint">Search by Deltix ID (DLTX-XXXXXX) or user #. Review trades, ads, holdings and enforcement history; remove ads or ban accounts from here.</p>
          <div class="p2p-bid-row"><input id="p2pModSearch" type="text" maxlength="20" placeholder="DLTX-ABC123" autocomplete="off" /><button class="btn ghost" id="p2pModSearchBtn">Search</button></div>
          <div id="p2pModSearchOut"></div>
        </div>
        <h3 class="section-title">Awaiting your review</h3>` +
        (!queue.length ? '<p class="muted center">Nothing awaiting your review. 🎉</p>' : queue.map((o) => `
        <div class="card p2p-offer-card" data-mod="${o.id}">
          <div class="p2p-offer-top"><b>#${o.id} · ${fmt(o.amountDltx)} DLTX ↔ ${fmt(o.totalUsdt)} USDT</b> ${p2pStatusChip(o.status)}</div>
          <div class="muted small-note">${p2pCodeChip(o.buyerCode || ('#' + o.buyerId), 'Buyer')} · ${p2pCodeChip(o.sellerCode || ('#' + o.sellerId), 'Seller')}${o.simulation ? ' · SIMULATION' : ''}</div>
          <div class="muted small-note">Created ${p2pWhen(o.createdAt)}${o.usdtSubmittedAt ? ` · paid ${p2pWhen(o.usdtSubmittedAt)}` : ''}</div>
        </div>`).join('')) +
        `<h3 class="section-title">My P2P Trades <span class="muted small-note">(${trades.length})</span></h3>` +
        (!trades.length ? '<p class="muted center">No trades assigned to you yet.</p>' : SECTIONS.map(([key, label]) => {
          const rows = trades.filter((t) => t.section === key);
          if (!rows.length) return '';
          const collapsed = key === 'COMPLETED' || key === 'CANCELLED' || key === 'EXPIRED';
          return `<details class="p2p-mytrades-sec" ${collapsed ? '' : 'open'}><summary>${label} <span class="muted small-note">(${rows.length})</span></summary>${rows.map(tradeCard).join('')}</details>`;
        }).join(''));
      p2pRenderPresence();
      p2pLoadStats();
      list.querySelectorAll('#p2pStatsRange [data-range]').forEach((b) => b.addEventListener('click', () => {
        p2p.statsRange = b.dataset.range;
        list.querySelectorAll('#p2pStatsRange [data-range]').forEach((x) => x.classList.toggle('on', x === b));
        $('p2pStatsCustom').hidden = p2p.statsRange !== 'custom';
        if (p2p.statsRange !== 'custom') p2pLoadStats();
      }));
      $('p2pStatsApply')?.addEventListener('click', () => p2pLoadStats());
      $('p2pStatsMod')?.addEventListener('change', (e) => { p2p.statsMod = e.target.value; p2pLoadStats(); });
      $('p2pPresenceToggle').addEventListener('change', async (e) => {
        const on = e.target.checked;
        e.target.disabled = true;
        try {
          const me = await p2pSetAvailability(on);
          p2pRenderPresence();
          toast(on ? `You are ${me.status.toLowerCase()} for P2P trades` : 'You are offline for new P2P trades', { tone: on ? 'success' : 'info' });
          loadP2pAdmins({ silent: true });
        } catch (err) { e.target.checked = !on; toast(err.message, { tone: 'error' }); }
        e.target.disabled = false;
      });
      list.querySelectorAll('[data-mod]').forEach((el) =>
        el.addEventListener('click', () => openP2pOrder(el.dataset.mod, { moderator: true })));
      const doSearch = async () => {
        const q = $('p2pModSearch').value.trim();
        const out = $('p2pModSearchOut');
        if (q.length < 3) { out.innerHTML = '<p class="hint">Enter at least 3 characters.</p>'; return; }
        out.innerHTML = '<p class="muted">Searching…</p>';
        try {
          const s = await api('GET', `/p2p/moderation/search?q=${encodeURIComponent(q)}`);
          const u = s.user;
          const ctl = s.controls || {};
          const h = s.holdings;
          const hist = s.enforcementHistory || [];
          const statusChip = u.accountStatus === 'blocked' ? '<span class="p2p-chip p2p-chip-bad">BANNED</span>' : (u.riskState && u.riskState !== 'normal' ? `<span class="p2p-chip p2p-chip-warn">UNDER REVIEW · ${escapeHtml(u.riskState)}</span>` : '<span class="p2p-chip p2p-chip-ok">ACTIVE</span>');
          const stat = (label, v, cls = '') => `<div class="p2p-stat ${cls}"><span class="muted small-note">${label}</span><b>${v}</b></div>`;
          const histLabel = (e) => e.action === 'account_banned_by_moderator' ? `🚫 Banned${e.burned ? ` · ${fmt(e.burned)} DLTX burned` : ''}` : e.action === 'account_unbanned_by_moderator' ? '✅ Unbanned' : `⚠️ Risk ${escapeHtml(e.from || 'normal')} → ${escapeHtml(e.to || '')}`;
          out.innerHTML = `
            <div class="p2p-lookup">
              <div class="p2p-lookup-head">
                <span class="p2p-avatar" style="--h:${(Number(u.userId) * 47) % 360}">${escapeHtml((u.referralCode || 'T').slice(-2))}</span>
                <div class="p2p-lookup-id">
                  <b>${escapeHtml(u.referralCode || u.displayName)}</b>
                  <div class="p2p-lookup-chips">${statusChip} ${u.kycVerified ? '<span class="p2p-chip p2p-chip-ok">KYC ✓</span>' : '<span class="p2p-chip p2p-chip-muted">No KYC</span>'} ${u.p2pRole !== 'user' ? `<span class="p2p-chip p2p-chip-muted">${escapeHtml(u.p2pRole.replace(/_/g, ' '))}</span>` : ''}</div>
                </div>
              </div>
              <div class="p2p-stat-grid p2p-lookup-grid">
                ${stat('Completed', u.completedTrades)}${stat('Cancelled', u.cancelledTrades)}${stat('Disputes', u.disputesOpened)}${stat('Open trades', u.openTrades ?? 0)}${stat('Account age', `${u.accountAgeDays}d`)}
                ${h ? stat('Liquid', `${fmt(h.balance)}`) + stat('Staked', `${fmt(h.staked)}`) + stat('In escrow', `${fmt(h.p2pLocked)}`) : ''}
              </div>
              ${ctl.canBan || ctl.canUnban || ctl.protectedTarget ? `
              <div class="p2p-enforce">
                <div class="p2p-enforce-title">🛡 Enforcement</div>
                ${ctl.protectedTarget ? '<p class="hint">🔒 Protected account (moderator, support or your own) — enforcement is disabled.</p>' : `
                <p class="hint">Every action requires a written reason and is recorded in the permanent audit log under your moderator ID. Bans take effect immediately; burns are irreversible.</p>
                <div class="p2p-myad-actions p2p-enforce-row">
                  ${ctl.canBan ? '<button class="btn ghost p2p-danger-t" id="p2pModBanBtn">Ban account</button>' : ''}
                  ${ctl.canBan && ctl.canBurn ? `<button class="btn danger" id="p2pModBanBurnBtn">Ban + burn ${fmt((h?.balance || 0) + (h?.staked || 0))} DLTX</button>` : ''}
                  ${ctl.canUnban ? '<button class="btn primary" id="p2pModUnbanBtn">Unban account</button>' : ''}
                </div>
                ${ctl.canBan && !ctl.canBurn ? '<p class="hint">Burn is unavailable while this account has open P2P trades — cancel or complete them first.</p>' : ''}`}
                ${hist.length ? `<div class="p2p-enforce-hist">${hist.slice(0, 6).map((e) => `<div class="p2p-comm-row"><span>${histLabel(e)}</span><span class="muted small-note">${escapeHtml(e.by || '')} · ${p2pWhen(e.at)}</span>${e.reason ? `<span class="muted small-note p2p-enforce-reason">“${escapeHtml(e.reason.slice(0, 120))}”</span>` : ''}</div>`).join('')}</div>` : ''}
              </div>` : ''}
            </div>
            <h4 class="p2p-modsearch-h">Trades (${s.orders.length})</h4>` +
            (s.orders.slice(0, 30).map((o) => `
              <div class="card p2p-offer-card ${o.canOpen ? '' : 'p2p-dim'}" ${o.canOpen ? `data-mod-open="${o.id}"` : ''}>
                <div class="p2p-offer-top"><b>#${o.id} · ${fmt(o.amountDltx)} DLTX @ ${o.priceUsdt}</b> ${p2pStatusChip(o.status)}</div>
                <div class="muted small-note">${p2pCodeChip(o.buyerCode, 'Buyer')} · ${p2pCodeChip(o.sellerCode, 'Seller')} · ${p2pWhen(o.createdAt)}${o.canOpen ? '' : ' · assigned to another moderator'}</div>
              </div>`).join('') || '<p class="muted small-note">No trades.</p>') +
            `<h4 class="p2p-modsearch-h">Ads (${s.offers.length})</h4>` +
            (s.offers.slice(0, 30).map((a) => `
              <div class="card p2p-offer-card">
                <div class="p2p-offer-top"><b>#${a.id} · <span class="${a.side === 'sell' ? 'p2p-red-t' : 'p2p-green-t'}">${a.side.toUpperCase()}</span> ${fmt(a.amountDltx)} DLTX @ ${a.priceUsdt}</b> ${a.deleted ? '<span class="p2p-chip p2p-chip-muted">Deleted</span>' : p2pStatusChip(a.status)}</div>
                <div class="muted small-note">remaining ${fmt(a.remainingDltx)} · ${a.activeTrades} active · ${a.completedTrades} completed · ${p2pWhen(a.createdAt)}</div>
                ${ctl.canRemoveAds && ['active', 'paused'].includes(a.status) ? `<div class="p2p-myad-actions"><button class="btn ghost p2p-danger-t" data-mod-remove-ad="${a.id}" data-ad-label="#${a.id} · ${a.side.toUpperCase()} ${fmt(a.amountDltx)} DLTX @ ${a.priceUsdt}" data-ad-active="${a.activeTrades}">Remove from market</button></div>` : ''}
              </div>`).join('') || '<p class="muted small-note">No ads.</p>');
          out.querySelectorAll('[data-mod-open]').forEach((el) => el.addEventListener('click', () => openP2pOrder(el.dataset.modOpen, { moderator: true })));
          // Remove another user's ad (soft; open trades untouched).
          out.querySelectorAll('[data-mod-remove-ad]').forEach((btn) => btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const reason = await askReason({ title: 'Remove this ad from the market?', message: `Ad ${btn.dataset.adLabel}. ${Number(btn.dataset.adActive) ? `${btn.dataset.adActive} open trade(s) on it continue normally — escrow is untouched.` : 'No open trades on it.'} The owner is notified with your reason.`, placeholder: 'Reason (shown to the owner, kept in the audit log)', confirmText: 'Remove ad' });
            if (!reason) return;
            try {
              await api('POST', `/p2p/moderation/offers/${btn.dataset.modRemoveAd}/cancel`, { reason });
              toast('Ad removed from the market', { tone: 'success' });
              doSearch();
            } catch (err) { toast(err.message, { tone: 'error' }); }
          }));
          const banFlow = async (burn) => {
            const reason = await askReason({
              title: burn ? `BAN ${u.referralCode} and BURN ${fmt((h?.balance || 0) + (h?.staked || 0))} DLTX?` : `BAN ${u.referralCode}?`,
              message: burn
                ? 'The account is blocked everywhere, every live ad is removed, all active stakes end and the ENTIRE wallet (liquid + staked, including the welcome bonus) is burned back to the protocol. Burned coins cannot be restored. Only do this for confirmed fraud.'
                : 'The account is blocked everywhere and every live ad is removed. Coins are NOT touched (you can burn later after review). Reversible with Unban.',
              rows: [['Account', u.referralCode || '#' + u.userId], ['Holdings', h ? `${fmt(h.balance)} liquid · ${fmt(h.staked)} staked` : '—'], ['Open trades', String(u.openTrades ?? 0)]],
              placeholder: 'Reason (kept in the immutable audit log)',
              confirmText: burn ? 'BAN + BURN' : 'BAN',
              typed: 'BAN',
            });
            if (!reason) return;
            try {
              const r = await api('POST', `/p2p/moderation/users/${u.userId}/ban`, { reason, confirm: 'BAN', burn });
              toast(r.code === 'ALREADY_BANNED' ? 'Account was already banned' : `Account banned${burn ? ` · ${fmt(r.burned)} DLTX burned` : ''} · ${r.adsRemoved || 0} ad(s) removed`, { tone: 'success', title: 'Enforcement recorded' });
              doSearch();
            } catch (err) { toast(err.message, { tone: 'error' }); }
          };
          $('p2pModBanBtn')?.addEventListener('click', () => banFlow(false));
          $('p2pModBanBurnBtn')?.addEventListener('click', () => banFlow(true));
          $('p2pModUnbanBtn')?.addEventListener('click', async () => {
            const reason = await askReason({ title: `Unban ${u.referralCode}?`, message: 'The account can sign in and trade again. Burned coins are not restored automatically.', placeholder: 'Reason (audit log)', confirmText: 'Unban' });
            if (!reason) return;
            try {
              await api('POST', `/p2p/moderation/users/${u.userId}/unban`, { reason });
              toast('Account unbanned', { tone: 'success' });
              doSearch();
            } catch (err) { toast(err.message, { tone: 'error' }); }
          });
        } catch (e) { out.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`; }
      };
      $('p2pModSearchBtn').addEventListener('click', doSearch);
      $('p2pModSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    }
  } catch (e) {
    list.innerHTML = `<p class="muted center">${e.message}</p>`;
  }
}

// ── Admin P2P dashboard statistics (ACCEPTED ≠ COMPLETED; range + moderator filters) ──
async function p2pLoadStats() {
  const body = $('p2pStatsBody');
  if (!body) return;
  const range = p2p.statsRange || 'today';
  const qs = new URLSearchParams();
  if (range === 'custom') {
    const from = $('p2pStatsFrom')?.value; const to = $('p2pStatsTo')?.value;
    if (!from) { body.innerHTML = '<p class="hint">Pick a start date for the custom range.</p>'; return; }
    qs.set('from', new Date(from + 'T00:00:00Z').toISOString());
    if (to) qs.set('to', new Date(new Date(to + 'T00:00:00Z').getTime() + 86400000).toISOString());
  } else qs.set('range', range);
  if (p2p.statsMod) qs.set('moderator', p2p.statsMod);
  body.innerHTML = '<p class="muted">Loading statistics…</p>';
  try {
    const s = await api('GET', `/p2p/moderation/stats?${qs.toString()}`);
    const sel = $('p2pStatsMod');
    if (sel && sel.options.length <= 1) {
      for (const m of s.moderators || []) { const o = document.createElement('option'); o.value = m.code; o.textContent = `${m.code} · ${m.status}`; sel.appendChild(o); }
      if (p2p.statsMod) sel.value = p2p.statsMod;
    }
    $('p2pStatsScope').textContent = `${s.moderator ? `Moderator ${s.moderator.code} · ` : ''}${range === 'custom' ? `${(s.from || '').slice(0, 10)} → ${s.to ? s.to.slice(0, 10) : 'now'}` : range === 'today' ? 'Today (UTC)' : range === 'all' ? 'All time' : `Last ${range}`}`;
    const cell = (label, v, sub) => `<div class="p2p-stat"><span class="muted small-note">${label}</span><b>${v}</b>${sub ? `<span class="muted small-note">${sub}</span>` : ''}</div>`;
    const sc = s.scoped;
    body.innerHTML = `
      <div class="p2p-stat-grid">
        ${s.moderator ? '' : cell('Offers created', sc.offersCreated)}
        ${cell('Accepted', sc.accepted.count, `${fmt(sc.accepted.volumeDltx)} DLTX reserved`)}
        ${cell('Completed', sc.completed.count, `${fmt(sc.completed.volumeDltx)} DLTX settled`)}
        ${cell('Volume', `${fmt(sc.completed.volumeDltx)} DLTX`, `${fmt(sc.completed.volumeUsdt)} USDT`)}
        ${cell('Commission', `${fmt(sc.commission.moderatorDltx)} DLTX`, `${sc.commission.entries} settled`)}
        ${cell('Cancelled', sc.cancelled)}
        ${cell('Expired', sc.expired)}
      </div>
      <div class="p2p-stat-grid p2p-stat-live">
        ${cell('Active trades', s.live.activeTrades, `${fmt(s.live.escrowDltx)} DLTX in escrow`)}
        ${cell('Payment pending', s.live.paymentPending)}
        ${cell('Payment marked', s.live.paymentMarked)}
        ${cell('Disputed', s.live.disputed)}
      </div>
      <div class="muted small-note">Today: accepted ${s.today.accepted} · completed ${s.today.completed} · offers ${s.today.offersCreated} · commission ${fmt(s.today.commissionDltx)} DLTX &nbsp;|&nbsp; All time: accepted ${s.totals.accepted} · completed ${s.totals.completed} · volume ${fmt(s.totals.volumeDltx)} DLTX / ${fmt(s.totals.volumeUsdt)} USDT</div>
      <div class="muted small-note">Accepted = a trade was created from an ad (escrow locked). Completed = final settlement. Window ${s.policy.tradeWindowMinutes} min · fees ${s.policy.sellerFeePercent}% seller + ${s.policy.buyerFeePercent}% buyer · moderator share ${s.policy.moderatorSharePercent}%.</div>`;
  } catch (e) { body.innerHTML = `<p class="hint">${escapeHtml(e.message)}</p>`; }
}

// ── My Ads: every ad I posted, in every state, with safe actions ──
async function renderP2pMyAds(list) {
  const r = await api('GET', '/p2p/offers/mine');
  const ads = r.offers || [];
  const lim = r.limit || {};
  const quota = `<div class="p2p-listhead"><span>${ads.length} ad${ads.length === 1 ? '' : 's'}</span><span>${lim.usedLast24h ?? 0}/${lim.dailyAdLimit ?? '—'} posted in 24h${lim.remaining === 0 && lim.nextSlotAt ? ` · next slot ${p2pWhen(lim.nextSlotAt)}` : ''}</span></div>`;
  if (!ads.length) { list.innerHTML = quota + '<p class="muted center">You have not posted any ads yet.</p>'; return; }
  list.innerHTML = quota + ads.map((a) => `
    <div class="card p2p-myad" data-myad="${a.id}">
      <div class="p2p-offer-top">
        <b>#${a.id} · <span class="${a.side === 'sell' ? 'p2p-red-t' : 'p2p-green-t'}">${a.side.toUpperCase()}</span> ${fmt(a.amountDltx)} DLTX @ ${a.priceUsdt} USDT</b>
        ${a.deleted ? '<span class="p2p-chip p2p-chip-muted">Deleted</span>' : p2pStatusChip(a.status)}
      </div>
      <div class="p2p-myad-grid">
        <span>Remaining <b>${fmt(a.remainingDltx)}</b></span>
        <span>Limit <b>${fmt(a.minDltx)}–${fmt(a.maxDltx)}</b></span>
        <span>Active trades <b>${a.activeTrades}</b></span>
        <span>Completed <b>${a.completedTrades}</b></span>
        <span>Payment <b>${escapeHtml(a.paymentMethod)}</b></span>
        <span>Created <b>${p2pWhen(a.createdAt)}</b></span>
        ${a.status === 'paused' && a.pausedAt ? `<span>Paused <b>${p2pWhen(a.pausedAt)}</b></span>` : ''}
        ${a.closedAt ? `<span>Closed <b>${p2pWhen(a.closedAt)}</b></span>` : ''}
        ${a.expiresAt && !a.closedAt ? `<span>Expires <b>${p2pWhen(a.expiresAt)}</b></span>` : ''}
      </div>
      ${a.terms ? `<div class="muted small-note">${escapeHtml(a.terms.slice(0, 120))}</div>` : ''}
      <div class="p2p-myad-actions">
        <button class="btn ghost" data-act="view" data-id="${a.id}">View</button>
        ${a.canPause ? `<button class="btn ghost" data-act="pause" data-id="${a.id}">Pause</button>` : ''}
        ${a.canResume ? `<button class="btn ghost" data-act="resume" data-id="${a.id}">Resume</button>` : ''}
        ${a.canEdit ? `<button class="btn ghost" data-act="edit" data-id="${a.id}">Edit</button>` : ''}
        ${a.canDelete ? `<button class="btn ghost p2p-danger-t" data-act="delete" data-id="${a.id}">Delete</button>` : (a.canCancel ? `<button class="btn ghost p2p-danger-t" data-act="cancel" data-id="${a.id}">Cancel</button>` : '')}
      </div>
    </div>`).join('');
  p2p.myAds = ads;
  list.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.dataset.id;
    const ad = ads.find((x) => x.id === id);
    const act = btn.dataset.act;
    try {
      if (act === 'view') return openP2pOffer(id);
      if (act === 'edit') return openP2pEdit(ad);
      if (act === 'pause') { await api('POST', `/p2p/offers/${id}/pause`, {}); toast('Ad paused — hidden from the market until you resume it', { tone: 'success' }); }
      if (act === 'resume') { await api('POST', `/p2p/offers/${id}/resume`, {}); toast('Ad is live again', { tone: 'success' }); }
      if (act === 'delete') {
        const okGo = await askConfirm({ title: 'Delete this ad?', message: 'This ad has no trades, so it is removed from the marketplace. It stays in your ad history for your records and does not free a posting slot.', rows: [['Ad', `#${id} · ${ad.side.toUpperCase()} ${fmt(ad.amountDltx)} DLTX @ ${ad.priceUsdt}`]], confirmText: 'Delete ad', danger: true });
        if (!okGo) return;
        const r = await api('POST', `/p2p/offers/${id}/delete`, {});
        toast(r.deleted ? 'Ad deleted' : 'Ad removed from the market (trade history kept)', { tone: 'success' });
      }
      if (act === 'cancel') {
        const okGo = await askConfirm({ title: 'Remove this ad from the market?', message: `Trades already open on it continue normally and their escrow is untouched. ${ad.activeTrades ? `${ad.activeTrades} active trade${ad.activeTrades > 1 ? 's' : ''} will keep their terms.` : ''} The ad stays in your history; this does not free a posting slot.`, rows: [['Ad', `#${id} · ${ad.side.toUpperCase()} ${fmt(ad.amountDltx)} DLTX @ ${ad.priceUsdt}`], ['Trades', `${ad.activeTrades} active · ${ad.completedTrades} completed`]], confirmText: 'Remove ad', danger: true });
        if (!okGo) return;
        await api('POST', `/p2p/offers/${id}/cancel`, {});
        toast('Ad removed from the market — open trades continue', { tone: 'success' });
      }
      renderP2pView();
    } catch (err) { toast(err.message, { tone: 'error' }); }
  }));
}

function openP2pEdit(ad) {
  if (!ad) return;
  p2p.editAd = ad;
  $('p2pEditTitle').textContent = `Edit ad #${ad.id} · ${ad.side.toUpperCase()} ${fmt(ad.amountDltx)} DLTX`;
  $('p2pEditPrice').value = ad.priceUsdt;
  $('p2pEditMin').value = ad.minDltx;
  $('p2pEditMax').value = ad.maxDltx;
  $('p2pEditTerms').value = ad.terms || '';
  $('p2pEditContact').value = ad.contact || '';
  $('p2pEditHint').textContent = ad.activeTrades ? `${ad.activeTrades} open trade${ad.activeTrades > 1 ? 's' : ''} keep their current terms.` : '';
  $('p2pEditModal').hidden = false;
}
$('p2pEditCancel')?.addEventListener('click', () => { $('p2pEditModal').hidden = true; });
$('p2pEditSave')?.addEventListener('click', async () => {
  const ad = p2p.editAd;
  if (!ad) return;
  const body = {};
  const price = Number($('p2pEditPrice').value);
  const min = Number($('p2pEditMin').value);
  const max = Number($('p2pEditMax').value);
  if (price !== ad.priceUsdt) body.priceUsdt = price;
  if (min !== ad.minDltx) body.minDltx = min;
  if (max !== ad.maxDltx) body.maxDltx = max;
  const terms = $('p2pEditTerms').value.trim();
  if (terms !== (ad.terms || '')) body.terms = terms;
  const contact = $('p2pEditContact').value.trim();
  if (contact !== (ad.contact || '')) body.contact = contact;
  if (!Object.keys(body).length) { $('p2pEditModal').hidden = true; return; }
  try {
    await api('PATCH', `/p2p/offers/${ad.id}`, body);
    $('p2pEditModal').hidden = true;
    toast('Ad updated', { tone: 'success' });
    renderP2pView();
  } catch (e) { $('p2pEditHint').textContent = e.message; }
});

document.querySelectorAll('#tab-p2p [data-view]').forEach((b) =>
  b.addEventListener('click', () => { p2p.view = b.dataset.view; renderP2pView(); }));

$('p2pMyContactSave')?.addEventListener('click', async () => {
  try {
    const r = await api('POST', '/p2p/contact', { contact: $('p2pMyContact').value.trim() });
    if (p2p.status) p2p.status.myContact = r.contact;
    toast(r.contact ? 'Contact saved — your trade partners and moderators can now reach you' : 'Contact removed — you must add one again before trading', { tone: r.contact ? 'success' : 'info' });
  } catch (e) { toast(e.message, { tone: 'error' }); }
});

// ── Trader profile (OKX-style advertiser page) ──
async function openP2pTrader(userId) {
  try {
    const t = await api('GET', `/p2p/profile/${userId}`);
    const av = $('p2pTraderAvatar');
    av.textContent = 'T';
    av.style.setProperty('--h', (Number(t.userId) * 47) % 360);
    $('p2pTraderName').textContent = t.displayName;
    $('p2pTraderBadges').innerHTML = [
      p2pCodeChip(t.referralCode, 'ID'),
      t.kycVerified ? '<span class="p2p-chip p2p-chip-ok">KYC Verified ✓</span>' : '<span class="p2p-chip p2p-chip-muted">No KYC</span>',
      t.merchant ? '<span class="p2p-chip p2p-chip-warn">★ Merchant</span>' : '',
    ].join(' ');
    $('p2pTraderStats').innerHTML = `
      <div class="p2p-tstat"><b>${t.completedTrades}</b><span>Completed trades</span></div>
      <div class="p2p-tstat"><b>${t.completionRate}%</b><span>Completion rate</span></div>
      <div class="p2p-tstat"><b>${t.totalOrders}</b><span>Total orders</span></div>
      <div class="p2p-tstat"><b>${t.cancelledTrades}</b><span>Cancelled</span></div>
      <div class="p2p-tstat"><b>${t.disputesOpened}</b><span>Disputes opened</span></div>
      <div class="p2p-tstat"><b>${t.accountAgeDays}d</b><span>Account age</span></div>`;
    $('p2pTraderModal').hidden = false;
  } catch (e) { toast(e.message, { tone: 'error' }); }
}
$('p2pTraderClose')?.addEventListener('click', () => { $('p2pTraderModal').hidden = true; });
$('p2pImgClose')?.addEventListener('click', () => { $('p2pImgModal').hidden = true; });
$('p2pImgModal')?.addEventListener('click', (e) => { if (e.target.id === 'p2pImgModal') $('p2pImgModal').hidden = true; });

// ── Create offer ──
function p2pQuoteRows(amount, price) {
  const s = p2p.status || { feePercent: 1, usdtFeePercent: 1 };
  const total = amount * price;
  const feeD = (amount * s.feePercent) / 100;
  const feeU = (total * s.usdtFeePercent) / 100;
  return `
    <div class="row"><span>Total value</span><b>${fmt(total)} USDT</b></div>
    <div class="row"><span>Buyer receives</span><b>${fmt(amount - feeD)} DLTX (after ${s.feePercent}% fee)</b></div>
    <div class="row"><span>Seller receives</span><b>${fmt(total - feeU)} USDT (after ${s.usdtFeePercent}% fee)</b></div>`;
}

function openP2pCreate() {
  p2p.createSide = 'sell';
  $('p2pSideSell').classList.add('active');
  $('p2pSideBuy').classList.remove('active');
  $('p2pCreateQuote').innerHTML = '';
  $('p2pCreateHint').textContent = '';
  $('p2pPayoutWalletWrap').hidden = false;
  // Prefill the saved payout address so it is not retyped (and not mistyped).
  if (p2p.myWallet && !$('p2pPayoutWallet').value) $('p2pPayoutWallet').value = p2p.myWallet;
  $('p2pCreateModal').hidden = false;
}
$('p2pCreateBtn')?.addEventListener('click', openP2pCreate);
$('p2pCreateCancel')?.addEventListener('click', () => { $('p2pCreateModal').hidden = true; });
$('p2pSideSell')?.addEventListener('click', () => {
  p2p.createSide = 'sell';
  $('p2pSideSell').classList.add('active');
  $('p2pSideBuy').classList.remove('active');
  $('p2pPayoutWalletWrap').hidden = false;
});
$('p2pSideBuy')?.addEventListener('click', () => {
  p2p.createSide = 'buy';
  $('p2pSideBuy').classList.add('active');
  $('p2pSideSell').classList.remove('active');
  $('p2pPayoutWalletWrap').hidden = true;
});
['p2pCreateAmount', 'p2pCreatePrice'].forEach((id) =>
  $(id)?.addEventListener('input', () => {
    const a = Number($('p2pCreateAmount').value);
    const p = Number($('p2pCreatePrice').value);
    $('p2pCreateQuote').innerHTML = a > 0 && p > 0 ? p2pQuoteRows(a, p) : '';
  }));
$('p2pCreateConfirm')?.addEventListener('click', async () => {
  const hint = $('p2pCreateHint');
  const amount = Number($('p2pCreateAmount').value);
  const price = Number($('p2pCreatePrice').value);
  const network = (p2p.status?.networks || [])[0]?.id || 'bep20';
  try {
    const payout = $('p2pPayoutWallet').value.trim();
    if (p2p.createSide === 'sell' && payout) {
      await api('POST', '/p2p/wallets', { network, address: payout });
    }
    const r = await api('POST', '/p2p/offers', {
      side: p2p.createSide,
      amountDltx: amount,
      priceUsdt: price,
      minDltx: Number($('p2pCreateMin').value) || undefined,
      maxDltx: Number($('p2pCreateMax').value) || amount,
      usdtNetwork: network,
      terms: $('p2pCreateTerms').value.trim(),
      contact: $('p2pCreateContact').value.trim(),
    });
    $('p2pCreateModal').hidden = true;
    toast(`Offer #${r.offer.id} is live`, { tone: 'success', title: 'Offer posted' });
    p2p.view = 'mine';
    renderP2pView();
    p2pMaybeAd();
  } catch (e) {
    hint.textContent = e.message;
    if (e.code === 'AD_LIMIT_REACHED' || /posting limit/i.test(e.message)) toast(e.message, { tone: 'error', title: 'Daily ad limit' });
  }
});

// ── Offer detail + negotiation ──
async function openP2pOffer(id) {
  try {
    const r = await api('GET', `/p2p/offers/${id}`);
    p2p.offer = r.offer;
    const o = r.offer;
    $('p2pOfferTitle').textContent = `${o.side === 'sell' ? 'Buy DLTX from' : 'Sell DLTX to'} ${o.trader ? o.trader.displayName : 'trader'}`;
    $('p2pOfferInfo').innerHTML = `
      <div class="row"><span>Price</span><b>${o.priceUsdt} USDT/DLTX${o.simulation ? ' · SIMULATION' : ''}</b></div>
      <div class="row"><span>Available</span><b>${fmt(o.remainingDltx)} DLTX</b></div>
      <div class="row"><span>Limits</span><b>${fmt(o.minDltx)} – ${fmt(o.maxDltx)} DLTX</b></div>
      <div class="row"><span>Network</span><b>USDT · BNB Chain (BEP-20)</b></div>
      ${o.trader ? `<div class="row"><span>Trader</span><b><a href="#" id="p2pOfferTraderLink">${escapeHtml(o.trader.displayName)}</a> · ${o.trader.completedTrades} trades · ${o.trader.completionRate}% ${o.trader.kycVerified ? '· KYC ✓' : ''}</b></div>` : ''}
      ${o.trader?.referralCode ? `<div class="row"><span>${o.side === 'sell' ? 'Seller' : 'Buyer'} ID</span><b>${escapeHtml(o.trader.referralCode)}</b></div>` : ''}
      ${o.status && o.status !== 'active' ? `<div class="row"><span>Status</span><b>${p2pStatusChip(o.status)}</b></div>` : ''}
      ${o.terms ? `<div class="row"><span>Terms</span><b>${escapeHtml(o.terms.slice(0, 140))}</b></div>` : ''}`;
    document.getElementById('p2pOfferTraderLink')?.addEventListener('click', (e) => { e.preventDefault(); openP2pTrader(o.trader.userId); });
    $('p2pTradeAmount').value = Math.min(o.maxDltx, o.remainingDltx);
    $('p2pOfferQuote').innerHTML = p2pQuoteRows(Number($('p2pTradeAmount').value), o.priceUsdt);
    $('p2pOfferHint').textContent = '';
    $('p2pBidPrice').value = '';
    $('p2pOfferCancelOffer').hidden = !o.mine;
    const acceptBtn = $('p2pAcceptBtn');
    acceptBtn.textContent = o.mine ? 'Your offer' : `${o.side === 'sell' ? 'Buy' : 'Sell'} DLTX @ ${o.priceUsdt}`;
    acceptBtn.disabled = Boolean(o.mine) || o.status !== 'active';
    acceptBtn.classList.toggle('p2p-green', !o.mine && o.side === 'sell');
    acceptBtn.classList.toggle('p2p-red', !o.mine && o.side === 'buy');
    renderP2pBids(r.bids || []);
    p2pFillAdminSelect();
    if (!p2p.admins.length) loadP2pAdmins({ silent: true });
    $('p2pOfferModal').hidden = false;
  } catch (e) {
    toast(e.message, { tone: 'error' });
  }
}

function renderP2pBids(bids) {
  const el = $('p2pBidList');
  const open = bids.filter((b) => ['proposed', 'countered'].includes(b.status));
  if (!open.length) { el.innerHTML = ''; return; }
  const myId = myUserId();
  el.innerHTML = '<h3 class="section-title">Negotiation</h3>' + open.map((b) => {
    const myTurn = String(b.lastActorId) !== myId;
    return `
      <div class="card p2p-bid-card">
        <div class="p2p-offer-top">
          <b>${fmt(b.amountDltx)} DLTX @ ${b.priceUsdt} USDT</b>
          <span class="p2p-chip p2p-chip-${b.status === 'countered' ? 'warn' : 'muted'}">${b.status}</span>
        </div>
        ${myTurn
          ? `<div class="modal-actions">
              <button class="btn primary" data-bid-accept="${b.id}">Accept</button>
              <button class="btn ghost" data-bid-counter="${b.id}">Counter</button>
              <button class="btn ghost" data-bid-reject="${b.id}">Reject</button>
            </div>`
          : '<p class="hint">Waiting for the other party to respond…</p>'}
      </div>`;
  }).join('');
  el.querySelectorAll('[data-bid-accept]').forEach((btn) =>
    btn.addEventListener('click', () => p2pAcceptBid(btn.dataset.bidAccept)));
  el.querySelectorAll('[data-bid-counter]').forEach((btn) =>
    btn.addEventListener('click', () => p2pCounterBid(btn.dataset.bidCounter)));
  el.querySelectorAll('[data-bid-reject]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try { await api('POST', `/p2p/bids/${btn.dataset.bidReject}/reject`, {}); openP2pOffer(p2p.offer.id); } catch (e) { toast(e.message, { tone: 'error' }); }
    }));
}

$('p2pTradeAmount')?.addEventListener('input', () => {
  if (p2p.offer) $('p2pOfferQuote').innerHTML = p2pQuoteRows(Number($('p2pTradeAmount').value) || 0, p2p.offer.priceUsdt);
});
$('p2pOfferClose')?.addEventListener('click', () => { $('p2pOfferModal').hidden = true; });
$('p2pOfferCancelOffer')?.addEventListener('click', async () => {
  if (!p2p.offer) return;
  const okGo = await askConfirm({ title: 'Cancel offer?', message: 'Your offer will be removed from the marketplace.', confirmText: 'Cancel offer', danger: true });
  if (!okGo) return;
  try {
    await api('POST', `/p2p/offers/${p2p.offer.id}/cancel`, {});
    $('p2pOfferModal').hidden = true;
    toast('Offer cancelled', { tone: 'success' });
    renderP2pView();
  } catch (e) { toast(e.message, { tone: 'error' }); }
});

$('p2pAcceptBtn')?.addEventListener('click', async () => {
  if (!p2p.offer || p2p.offer.mine) return;
  const amount = Number($('p2pTradeAmount').value);
  const adminId = $('p2pAdminSelect')?.value || '';
  const adminPick = adminId ? p2p.admins.find((a) => a.id === adminId) : null;
  const okGo = await askConfirm({
    title: 'Accept this price?',
    message: 'Terms freeze when both sides agree — review the numbers.',
    rows: [
      ['Amount', `${fmt(amount)} DLTX`],
      ['Price', `${p2p.offer.priceUsdt} USDT/DLTX`],
      ['Total', `${fmt(amount * p2p.offer.priceUsdt)} USDT`],
      ['Admin', adminPick ? `${adminPick.code} (online)` : 'Auto — least busy online admin'],
    ],
    confirmText: 'Accept & create order',
  });
  if (!okGo) return;
  try {
    const r = await api('POST', `/p2p/offers/${p2p.offer.id}/accept`, { amountDltx: amount, idempotencyKey: crypto.randomUUID(), ...(adminId ? { moderatorId: adminId } : {}) });
    $('p2pOfferModal').hidden = true;
    toast(`Order #${r.order.id} created`, { tone: 'success', title: 'Escrow locked' });
    openP2pOrder(r.order.id);
  } catch (e) {
    $('p2pOfferHint').textContent = e.message;
    if (['ADMIN_OFFLINE', 'ADMIN_BUSY', 'ADMIN_NOT_AUTHORIZED', 'ADMIN_CONFLICT_OF_INTEREST'].includes(e.code)) loadP2pAdmins({ silent: true });
  }
});

$('p2pBidBtn')?.addEventListener('click', async () => {
  if (!p2p.offer) return;
  try {
    await api('POST', `/p2p/offers/${p2p.offer.id}/bids`, {
      amountDltx: Number($('p2pTradeAmount').value),
      priceUsdt: Number($('p2pBidPrice').value),
    });
    toast('Bid sent — the trader can accept, counter or reject.', { tone: 'success', title: 'Bid placed' });
    openP2pOffer(p2p.offer.id);
  } catch (e) {
    $('p2pOfferHint').textContent = e.message;
  }
});

async function p2pAcceptBid(bidId) {
  try {
    const adminId = $('p2pAdminSelect')?.value || '';
    const r = await api('POST', `/p2p/bids/${bidId}/accept`, { idempotencyKey: crypto.randomUUID(), ...(adminId ? { moderatorId: adminId } : {}) });
    $('p2pOfferModal').hidden = true;
    toast(`Order #${r.order.id} created`, { tone: 'success', title: 'Escrow locked' });
    openP2pOrder(r.order.id);
  } catch (e) { toast(e.message, { tone: 'error' }); }
}
async function p2pCounterBid(bidId) {
  const price = Number($('p2pBidPrice').value);
  if (!price) { $('p2pOfferHint').textContent = 'Enter your counter price in the price field first.'; return; }
  try {
    await api('POST', `/p2p/bids/${bidId}/counter`, { priceUsdt: price });
    toast('Counter-offer sent', { tone: 'success' });
    openP2pOffer(p2p.offer.id);
  } catch (e) { toast(e.message, { tone: 'error' }); }
}

// ── Order room ──
function stopP2pChatPoll() {
  if (p2p.chatTimer) { clearInterval(p2p.chatTimer); p2p.chatTimer = null; }
  if (p2p.payTimer) { clearInterval(p2p.payTimer); p2p.payTimer = null; }
}
window.stopP2pChatPoll = stopP2pChatPoll;

// OKX/Binance-style progress tracker for the happy path.
const P2P_STEPS = ['Escrow', 'Payment', 'Verify', 'Release'];
function p2pRenderSteps(status) {
  const el = $('p2pSteps');
  const done = {
    created: 1, dltx_locked: 1, awaiting_usdt: 1,
    usdt_submitted: 2, usdt_verifying: 2,
    usdt_verified: 3, awaiting_moderator_approval: 3, moderator_approved: 3, releasing: 3,
    completed: 4,
  }[status];
  if (done === undefined) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = P2P_STEPS.map((s, i) => `
    <span class="p2p-step ${i < done ? 'done' : ''} ${i === done ? 'active' : ''}">
      <span class="p2p-step-dot">${i < done ? '✓' : i + 1}</span><span class="p2p-step-label">${s}</span>
    </span>`).join('<span class="p2p-step-line"></span>');
}

// Payment window from the SERVER deadline (the same clock the cancel/timeout
// rules use) — no client-side guess. Both parties see the same countdown.
function p2pStartPayTimer(o, { role = 'buyer', moderatorCode = null, windowMinutes = 30 } = {}) {
  const el = $('p2pPayTimer');
  const deadline = new Date(o.paymentDeadlineAt || (new Date(o.createdAt).getTime() + windowMinutes * 60 * 1000)).getTime();
  const meta = `<span class="p2p-paytimer-meta">${moderatorCode ? `Moderator <b>${escapeHtml(moderatorCode)}</b> · ` : ''}Escrow <b>${fmt(o.amountDltx)} DLTX secured</b></span>`;
  const tick = () => {
    const left = deadline - Date.now();
    if (left <= 0) {
      el.innerHTML = (role === 'buyer'
        ? '⏰ Payment window elapsed — pay and submit now, or the seller may cancel and the order will expire.'
        : '⏰ Payment window elapsed — you may cancel now if no payment has been marked; marked payments are never auto-returned.') + meta;
      el.classList.add('late');
      if (p2p.payTimer) { clearInterval(p2p.payTimer); p2p.payTimer = null; }
      return;
    }
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.innerHTML = `<span class="p2p-paytimer-main">⏱ PAYMENT WINDOW <b>${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}</b> remaining</span>${meta}`;
  };
  el.hidden = false;
  el.classList.remove('late');
  tick();
  p2p.payTimer = setInterval(tick, 1000);
}

// Turn a free-text contact into a tappable call / chat link.
function p2pContactLink(raw) {
  const c = String(raw).trim();
  if (/^https?:\/\//i.test(c)) return `<a href="${escapeHtml(c)}" target="_blank" rel="noopener">${escapeHtml(c)}</a>`;
  if (/^@\w{3,}$/.test(c)) return `<a href="https://t.me/${escapeHtml(c.slice(1))}" target="_blank" rel="noopener">${escapeHtml(c)} · Telegram</a>`;
  const phone = c.replace(/[\s\-()]/g, '');
  if (/^\+?\d{7,15}$/.test(phone)) {
    const waDigits = phone.replace(/\D/g, '');
    return `<a href="tel:${phone}">${escapeHtml(c)}</a>` +
      `<button class="p2p-callbtn" data-call="${phone}">📞 Call</button>` +
      `<a class="p2p-callbtn p2p-wabtn" href="https://wa.me/${waDigits}" target="_blank" rel="noopener">WhatsApp</a>`;
  }
  return escapeHtml(c);
}

function p2pRoleName(senderId) {
  if (!p2p.order) return `#${senderId}`;
  if (String(senderId) === String(p2p.order.buyerId)) return 'Buyer';
  if (String(senderId) === String(p2p.order.sellerId)) return 'Seller';
  return 'Moderator';
}

async function openP2pOrder(id, { moderator = false } = {}) {
  try {
    const r = await api('GET', `/p2p/orders/${id}`);
    const o = r.order;
    p2p.order = o;
    p2p.orderEvents = r.events || [];
    p2p.chatSig = null;
    p2p.chatTick = 0;
    $('p2pOrderTitle').textContent = `Order #${o.id} ${o.simulation ? '· SIMULATION' : ''}`;
    p2pRenderSteps(o.status);
    // Live on-chain verification state (server-driven): none | pending | verified | failed.
    const ver = o.usdtVerification || { status: o.usdtVerified ? 'verified' : (o.usdtTxHash ? 'pending' : 'none') };
    const payLabel = ver.status === 'verified' ? 'Verified ✅'
      : ver.status === 'failed' ? 'Could not verify ⚠️'
        : ver.status === 'pending' ? (ver.automatic === false ? 'Marked by buyer ⏳' : 'Confirming on-chain ⏳')
          : 'Awaiting';
    $('p2pOrderDetails').innerHTML = `
      <div class="row"><span>Status</span><b>${p2pStatusChip(o.status)}</b></div>
      <div class="row"><span>Amount</span><b>${fmt(o.amountDltx)} DLTX @ ${o.priceUsdt}</b></div>
      <div class="row"><span>Total</span><b>${fmt(o.totalUsdt)} USDT</b></div>
      <div class="row"><span>Buyer receives</span><b>${fmt(o.buyerReceivesDltx)} DLTX (−${o.feePercent}%)</b></div>
      <div class="row"><span>Seller receives</span><b>${fmt(o.sellerReceivesUsdt)} USDT (−1%)</b></div>
      ${o.buyerCode || o.sellerCode ? `<div class="row"><span>Parties</span><b>${p2pCodeChip(o.buyerCode, 'Buyer')} ${p2pCodeChip(o.sellerCode, 'Seller')}</b></div>` : ''}
      <div class="row"><span>USDT payment</span><b>${payLabel}</b></div>
      ${ver.reason && ver.status !== 'verified' ? `<div class="row"><span>On-chain check</span><b class="${ver.status === 'failed' ? 'p2p-danger-t' : 'muted'}">${escapeHtml(ver.reason)}${ver.status === 'pending' && ver.automatic !== false ? ' · re-checked every minute' : ''}</b></div>` : ''}
      ${o.role !== 'buyer' && o.sellerPayoutAddress ? `<div class="row"><span>Payout to</span><b class="p2p-addr-inline" title="Locked when this trade was created">${escapeHtml(o.sellerPayoutAddress.slice(0, 10))}…${escapeHtml(o.sellerPayoutAddress.slice(-6))} 🔒</b></div>` : ''}
      <div class="row"><span>Moderator</span><b>${o.moderatorAssigned ? (o.moderatorApproved ? 'Approved ✅' : 'Assigned') : 'Pending assignment'}</b></div>
      ${o.status === 'cancelled' ? `<div class="row"><span>Cancelled</span><b>${o.cancelledBy === 'system:timeout' ? 'Payment window expired' : (String(o.cancelledBy || '').startsWith('user:') ? (o.cancelledBy === `user:${o.buyerId}` ? 'by buyer' : 'by seller') : '')} · ${p2pWhen(o.closedAt)}</b></div>` : ''}
      ${o.status === 'completed' ? `<div class="row"><span>Seller payout</span><b>${o.sellerPayoutRecorded ? 'Paid ✅' : 'Processing ⏳'}</b></div>` : ''}`;
    // Assigned admin: public code + live state; parties may request another admin ONLY while theirs is offline.
    const adminRow = $('p2pOrderAdminRow');
    const mod = r.moderator;
    adminRow.hidden = false;
    adminRow.innerHTML = `
      <span class="p2p-admin-id">🛡 Trade admin: <b>${mod ? escapeHtml(mod.code || '—') : 'not assigned yet'}</b>${mod ? ' ' + p2pAdminChip(mod.status) : ''}${mod?.reassigned ? ' <span class="pill">REASSIGNED</span>' : ''}</span>
      ${r.canRequestAdmin ? '<button class="btn ghost p2p-reassign-btn" id="p2pRequestAdmin">Request another admin</button>' : ''}
      ${(r.moderatorHistory || []).length ? `<span class="muted small-note p2p-admin-hist">${r.moderatorHistory.map((h) => `${h.from ? escapeHtml(h.from) + ' → ' : ''}${escapeHtml(h.to || '')} (${escapeHtml(h.requestedBy)}, ${p2pWhen(h.at)})`).join(' · ')}</span>` : ''}`;
    $('p2pRequestAdmin')?.addEventListener('click', async () => {
      await loadP2pAdmins({ silent: true });
      const online = p2p.admins.filter((a) => a.status === 'ONLINE' && (!mod || a.code !== mod.code));
      const okGo = await askConfirm({
        title: 'Request another admin?',
        message: mod ? `Your assigned admin ${mod.code} is offline. An online admin will take over this trade. Your escrow is not affected.` : 'An online admin will be assigned to this trade. Your escrow is not affected.',
        rows: [['Online admins', online.length ? online.map((a) => a.code).join(', ') : 'none right now']],
        confirmText: 'Request admin',
      });
      if (!okGo) return;
      try {
        const rr = await api('POST', `/p2p/orders/${o.id}/reassign-request`, { reason: 'assigned admin offline' });
        toast(`Admin ${rr.moderator?.code || ''} is now handling your trade`, { tone: 'success', title: 'Admin reassigned' });
        openP2pOrder(o.id);
      } catch (e) { toast(e.message, { tone: 'error' }); }
    });
    // Contact block: official Deltix support first, then the counterparty.
    const contactEl = $('p2pContactRow');
    const contactLines = [];
    if (r.supportContact) {
      contactLines.push(`<span class="p2p-contact-line"><span class="p2p-contact-label">🛡 Deltix support (official)</span><span class="p2p-contact-val">${p2pContactLink(r.supportContact)}</span></span>`);
    }
    if (o.role === 'moderator') {
      if (r.buyerContact) contactLines.push(`<span class="p2p-contact-line"><span class="p2p-contact-label">📞 Buyer</span><span class="p2p-contact-val">${p2pContactLink(r.buyerContact)}</span></span>`);
      if (r.sellerContact) contactLines.push(`<span class="p2p-contact-line"><span class="p2p-contact-label">📞 Seller</span><span class="p2p-contact-val">${p2pContactLink(r.sellerContact)}</span></span>`);
    } else {
      // Traders never see each other's numbers — all contact goes through chat + support.
      contactLines.push('<span class="p2p-contact-line"><span class="p2p-contact-label muted">🔒 Your trade partner\'s number is held by Deltix moderators only. Use the chat below; for help, contact support.</span></span>');
    }
    contactEl.hidden = contactLines.length === 0;
    contactEl.innerHTML = contactLines.join('');
    contactEl.querySelectorAll('[data-call]').forEach((btn) =>
      btn.addEventListener('click', () => { window.open(`tel:${btn.dataset.call}`); }));
    const payable = o.role === 'buyer' && ['awaiting_usdt', 'usdt_submitted'].includes(o.status);
    $('p2pPaySection').hidden = !payable;
    $('p2pPayTimer').hidden = true;
    if (payable) {
      $('p2pDepositAddr').textContent = o.usdtDepositAddress || '';
      $('p2pTxHash').value = o.usdtTxHash || '';
      // After the hash is marked, the button only forces an immediate re-check.
      $('p2pSubmitTx').textContent = o.usdtTxHash ? 'Re-check now' : 'Submit';
    }
    // Cancel rule comes from the server (buyer: before payment verified;
    // seller: only after the payment window elapsed with nothing marked).
    const cancelBtn = $('p2pOrderCancel');
    p2p.cancelRule = r.cancel || null;
    const canCancel = o.role !== 'moderator' && r.cancel && r.cancel.allowed;
    const sellerWaiting = o.role === 'seller' && r.cancel && r.cancel.code === 'WINDOW_OPEN';
    cancelBtn.hidden = !(canCancel || sellerWaiting);
    cancelBtn.disabled = Boolean(sellerWaiting);
    cancelBtn.textContent = sellerWaiting ? `Cancel after ${new Date(o.paymentDeadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Cancel order';
    // Seller RELEASE DLTX — server-driven rule (buyer marked payment, no dispute, escrow held).
    const releaseBtn = $('p2pOrderRelease');
    p2p.releaseRule = r.release || null;
    const canRelease = o.role === 'seller' && r.release && r.release.allowed;
    releaseBtn.hidden = !canRelease;
    releaseBtn.disabled = false;
    releaseBtn.textContent = `RELEASE ${fmt(o.amountDltx)} DLTX`;
    $('p2pOrderDispute').hidden = !(o.role !== 'moderator' && !['completed', 'cancelled', 'refunded', 'disputed', 'under_review', 'escalated'].includes(o.status));
    // Hint priority: open dispute → on-chain verification state → seller timing/release guidance.
    const verifyHint = (() => {
      if (!['usdt_submitted', 'usdt_verifying'].includes(o.status)) return '';
      if (o.role === 'buyer') {
        if (ver.status === 'failed') return `⚠️ Your payment could not be verified on-chain: ${ver.reason || 'mismatch'}. If you did pay, check the hash and press "Re-check now"; otherwise open a dispute so a moderator can review.`;
        return ver.automatic === false
          ? '⏳ Payment marked. The seller will confirm receipt and release, or the moderator will verify — no further action needed.'
          : '⏳ Payment marked — we are confirming your USDT on BNB Chain automatically (re-checked every minute). No need to resubmit.';
      }
      if (o.role === 'seller') {
        if (ver.status === 'failed') return `⚠️ The buyer's payment could not be verified on-chain (${ver.reason || 'mismatch'}). Do NOT release unless you have confirmed the USDT arrived — open a dispute if nothing was received.`;
        return 'The buyer marked payment and on-chain verification is in progress. Only release after you have confirmed the USDT really arrived — a release cannot be undone.';
      }
      return '';
    })();
    $('p2pOrderHint').textContent = r.dispute ? `Dispute open: ${r.dispute.reason}` : (verifyHint || (sellerWaiting ? `The buyer has until ${new Date(o.paymentDeadlineAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to pay. If nothing is marked by then, you can cancel and your DLTX unlocks automatically.` : (canRelease ? 'The buyer has marked payment. Check that the USDT really arrived before releasing — a release cannot be undone.' : '')));
    // Moderator controls load their richer review endpoint.
    $('p2pModBlock').hidden = true;
    if (moderator || o.role === 'moderator') {
      try {
        const m = await api('GET', `/p2p/moderation/orders/${o.id}`);
        $('p2pModBlock').hidden = false;
        $('p2pModInfo').innerHTML = `
          <div class="row"><span>Buyer</span><b>${p2pCodeChip(m.buyer.profile?.referralCode || ('#' + m.buyer.id))} ${m.buyer.kycVerified ? 'KYC ✅' : 'KYC ❌'}</b></div>
          <div class="row"><span>Seller</span><b>${p2pCodeChip(m.seller.profile?.referralCode || ('#' + m.seller.id))} ${m.seller.kycVerified ? 'KYC ✅' : 'KYC ❌'}</b></div>
          <div class="row"><span>Escrow</span><b>${m.escrow.held ? `🔒 ${fmt(m.escrow.amountDltx)} DLTX held` : 'released / returned'} · ${escapeHtml(m.escrow.status)}</b></div>
          <div class="row"><span>Timeline</span><b class="p2p-timeline">created ${p2pWhen(m.timeline.createdAt)}${m.timeline.paymentMarkedAt ? ` · paid ${p2pWhen(m.timeline.paymentMarkedAt)}` : ` · pay by ${p2pWhen(m.timeline.paymentDeadlineAt)}`}${m.timeline.usdtVerifiedAt ? ` · verified ${p2pWhen(m.timeline.usdtVerifiedAt)}` : ''}${m.timeline.disputedAt ? ` · disputed ${p2pWhen(m.timeline.disputedAt)}` : ''}${m.timeline.closedAt ? ` · closed ${p2pWhen(m.timeline.closedAt)}` : ''}</b></div>
          <div class="row"><span>USDT tx</span><b>${m.usdt.txHash ? m.usdt.txHash.slice(0, 18) + '…' : '—'}${m.usdt.verification && m.usdt.txHash ? ` · ${m.usdt.verification.status === 'verified' ? 'verified ✅' : m.usdt.verification.status === 'failed' ? `<span class="p2p-danger-t">check failed ⚠️ ${escapeHtml(m.usdt.verification.reason || '')}</span>` : `confirming ⏳ ${escapeHtml(m.usdt.verification.reason || '')}`}` : ''}</b></div>
          <div class="row"><span>Payout due</span><b>${fmt(m.usdt.sellerPayoutDue)} USDT → ${m.usdt.sellerPayoutAddress ? escapeHtml(m.usdt.sellerPayoutAddress.slice(0, 12)) + '…' : 'no wallet!'} ${m.usdt.sellerPayoutAddressSource === 'snapshot' ? '🔒 locked at trade time' : (m.usdt.sellerPayoutAddressSource === 'live' ? '⚠️ live wallet (legacy order)' : '')}</b></div>
          ${m.usdt.sellerCurrentAddress && m.usdt.sellerCurrentAddress !== m.usdt.sellerPayoutAddress ? `<div class="row"><span>⚠️ Seller changed wallet</span><b>now ${escapeHtml(m.usdt.sellerCurrentAddress.slice(0, 12))}… — pay the LOCKED address above</b></div>` : ''}
          <div class="row"><span>📞 Buyer contact</span><b>${m.contacts?.buyer ? p2pContactLink(m.contacts.buyer) : '<span class="p2p-chip p2p-chip-bad">missing</span>'}</b></div>
          <div class="row"><span>📞 Seller contact</span><b>${m.contacts?.seller ? p2pContactLink(m.contacts.seller) : '<span class="p2p-chip p2p-chip-bad">missing</span>'}</b></div>`;
        $('p2pModInfo').querySelectorAll('[data-call]').forEach((btn) =>
          btn.addEventListener('click', () => { window.open(`tel:${btn.dataset.call}`); }));
        p2p.modControls = m.controls || {};
        p2p.modOrderVerified = Boolean(m.order.usdtVerified);
        $('p2pModCancel').hidden = !m.controls?.canCancel;
        $('p2pModComplete').hidden = !m.controls?.canComplete;
        $('p2pModReleaseLock').hidden = !m.controls?.canReleaseLock;
        $('p2pModControls').hidden = !(m.controls?.canCancel || m.controls?.canComplete || m.controls?.canReleaseLock);
        const se = m.sellerEscrow || {};
        $('p2pModEscrowHint').textContent = `Seller escrow: ${fmt(se.locked || 0)} locked · ${fmt(se.obligations || 0)} backing ${se.openOrders || 0} open trade(s) · ${fmt(se.releasable || 0)} releasable`;
        $('p2pModBlockers').innerHTML = m.releaseBlockers.length
          ? '<ul class="disclosure">' + m.releaseBlockers.map((b) => `<li>⛔ ${escapeHtml(b)}</li>`).join('') + '</ul>'
          : '<p class="hint">✅ All release conditions satisfied.</p>';
        $('p2pModApprove').disabled = m.releaseBlockers.length > 0;
        $('p2pPayoutRow').hidden = !(o.status === 'completed' && !o.sellerPayoutRecorded);
      } catch { /* not the assigned moderator */ }
    }
    await loadP2pChat(o.id);
    stopP2pChatPoll();
    p2p.chatTimer = setInterval(() => loadP2pChat(o.id).catch(() => {}), 5000);
    if (payable && o.status === 'awaiting_usdt') p2pStartPayTimer(o, { role: 'buyer', moderatorCode: o.moderatorCode, windowMinutes: r.paymentWindowMinutes });
    else if (o.role === 'seller' && o.status === 'awaiting_usdt') p2pStartPayTimer(o, { role: 'seller', moderatorCode: o.moderatorCode, windowMinutes: r.paymentWindowMinutes });
    $('p2pOrderModal').hidden = false;
    // Chat rendered while the modal was hidden (zero heights) — snap to latest now.
    const chatList = $('p2pChatList');
    chatList.scrollTop = chatList.scrollHeight;
  } catch (e) {
    toast(e.message, { tone: 'error' });
  }
}

// Order milestones rendered inline in the chat (OKX-style system messages).
const P2P_SYS_EVENTS = {
  created: '📝 Order created — terms locked',
  dltx_locked: '🔒 Seller\u2019s DLTX locked in escrow',
  usdt_submitted: '🧾 Buyer submitted the USDT transaction',
  usdt_verified: '✅ USDT verified at the platform wallet',
  awaiting_moderator_approval: '🛡 Queued for moderator release approval',
  completed: '🎉 DLTX released — order completed',
  disputed: '⚠️ Dispute opened — escrow frozen',
  cancelled: '↩️ Order cancelled — escrow refunded',
  refunded: '↩️ Escrow refunded to the seller',
  escalated: '⬆️ Escalated to a senior moderator',
  security_hold: '🛑 Security hold placed',
};

function p2pDayLabel(d) {
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function loadP2pChat(orderId) {
  const r = await api('GET', `/p2p/orders/${orderId}/messages`);
  // Every ~30s the poll also refreshes status so the timeline + tracker stay live;
  // a status / on-chain verification change re-renders the whole room (the
  // background verifier confirms payments without any action from the buyer).
  p2p.chatTick = (p2p.chatTick || 0) + 1;
  if (p2p.chatTick % 6 === 0) {
    try {
      const d = await api('GET', `/p2p/orders/${orderId}`);
      const sigOf = (o) => `${o?.status}|${o?.usdtVerification?.status}|${o?.usdtVerification?.reason || ''}|${o?.moderatorId || ''}`;
      const changed = sigOf(p2p.order) !== sigOf(d.order);
      p2p.order = d.order;
      p2p.orderEvents = d.events || [];
      p2pRenderSteps(d.order.status);
      if (changed && !$('p2pOrderModal').hidden) { openP2pOrder(orderId, { moderator: d.order.role === 'moderator' }); return; }
    } catch { /* keep last known state */ }
  }
  const msgs = r.messages || [];
  const sys = (p2p.orderEvents || [])
    .filter((e) => P2P_SYS_EVENTS[e.to])
    .map((e) => ({ sys: true, at: e.at, label: P2P_SYS_EVENTS[e.to] }));
  const timeline = [...msgs, ...sys].sort((a, b) => new Date(a.at) - new Date(b.at));
  const list = $('p2pChatList');
  // Re-render only when the timeline actually changed — no 5s flicker.
  const sig = `${timeline.length}:${msgs.length ? msgs[msgs.length - 1].id : '0'}:${sys.length}`;
  if (p2p.chatSig === sig && list.childElementCount) return;
  p2p.chatSig = sig;
  const myId = myUserId();
  const nearBottom = !list.childElementCount || (list.scrollHeight - list.scrollTop - list.clientHeight < 80);
  let lastDay = '';
  let lastSender = null;
  list.innerHTML = timeline.map((m) => {
    const d = new Date(m.at);
    const parts = [];
    if (d.toDateString() !== lastDay) {
      lastDay = d.toDateString();
      lastSender = null;
      parts.push(`<div class="p2p-chat-day"><span>${p2pDayLabel(d)}</span></div>`);
    }
    const when = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (m.sys) {
      lastSender = null;
      parts.push(`<div class="p2p-msg-sys">${m.label} · ${when}</div>`);
      return parts.join('');
    }
    const role = p2pRoleName(m.senderId);
    const mine = String(m.senderId) === myId;
    const grouped = lastSender === m.senderId;
    lastSender = m.senderId;
    const img = m.attachment && m.attachment.startsWith('data:image/')
      ? `<img class="p2p-msg-img" src="${m.attachment}" alt="screenshot" loading="lazy" />` : '';
    parts.push(`
    <div class="p2p-msg ${mine ? 'mine' : ''}${grouped ? ' grouped' : ''}">
      ${grouped ? '' : `<span class="p2p-msg-who p2p-role-${role.toLowerCase()}">${mine ? 'You · ' : ''}${role}</span>`}
      ${img}${m.body ? `<span class="p2p-msg-body">${escapeHtml(m.body)}</span>` : ''}
      <span class="p2p-msg-time">${when}</span>
    </div>`);
    return parts.join('');
  }).join('') || '<p class="muted center small-note">No messages yet — say hello and coordinate the payment here. Attach payment screenshots with 📷.</p>';
  list.querySelectorAll('.p2p-msg-img').forEach((im) =>
    im.addEventListener('click', () => { $('p2pImgFull').src = im.src; $('p2pImgModal').hidden = false; }));
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

// Screenshot attach: downscale to ≤1280px JPEG so it always fits the server cap.
async function p2pShrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('Unreadable image')); img.src = url; });
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    canvas.height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = canvas.toDataURL('image/jpeg', 0.8);
    if (out.length > 1400000) throw new Error('Image too large — try a smaller screenshot');
    return out;
  } finally { URL.revokeObjectURL(url); }
}

$('p2pChatFile')?.addEventListener('change', async () => {
  const fileInput = $('p2pChatFile');
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file || !p2p.order) return;
  if (!/^image\//.test(file.type)) { toast('Only images can be attached', { tone: 'error' }); return; }
  try {
    const attachment = await p2pShrinkImage(file);
    await api('POST', `/p2p/orders/${p2p.order.id}/messages`, { attachment, body: $('p2pChatInput').value.trim() });
    $('p2pChatInput').value = '';
    toast('Screenshot sent', { tone: 'success' });
    loadP2pChat(p2p.order.id);
  } catch (e) { toast(e.message || 'Could not attach the image', { tone: 'error' }); }
});

document.querySelectorAll('#p2pQuickReplies .p2p-qr').forEach((b) =>
  b.addEventListener('click', async () => {
    if (!p2p.order) return;
    try {
      await api('POST', `/p2p/orders/${p2p.order.id}/messages`, { body: b.textContent.trim() });
      loadP2pChat(p2p.order.id);
    } catch (e) { toast(e.message, { tone: 'error' }); }
  }));

$('p2pOrderClose')?.addEventListener('click', () => {
  $('p2pOrderModal').hidden = true;
  stopP2pChatPoll();
  // AdMob interstitials only after a server-confirmed terminal state — never
  // around payment / release / dispute actions still in flight.
  if (['completed', 'cancelled', 'refunded'].includes(p2p.order?.status)) p2pMaybeAd();
  renderP2pView();
});
$('p2pCopyAddr')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('p2pDepositAddr').textContent);
    toast('Platform wallet address copied', { tone: 'success' });
  } catch { toast('Copy failed — long-press the address instead', { tone: 'error' }); }
});
$('p2pSubmitTx')?.addEventListener('click', async () => {
  if (!p2p.order) return;
  const txHash = $('p2pTxHash').value.trim();
  if (!txHash) { $('p2pOrderHint').textContent = 'Paste the transaction hash of your USDT transfer first (0x followed by 64 characters).'; return; }
  const btn = $('p2pSubmitTx');
  btn.disabled = true;
  let hint = '';
  try {
    const r = await api('POST', `/p2p/orders/${p2p.order.id}/usdt`, { txHash });
    // Pending = payment MARKED, confirmation continues server-side (not an error).
    if (r.pending) toast(r.note || 'Payment marked — confirming on-chain automatically.', { tone: 'info', title: 'Payment marked' });
    else toast(r.note || 'Payment verified', { tone: 'success', title: 'USDT verified' });
  } catch (e) {
    hint = e.message;
    toast(e.message, { tone: 'error', title: e.code === 'BAD_TX_HASH' ? 'Check the hash' : 'Payment not verified' });
  } finally {
    btn.disabled = false;
  }
  // Always re-read the order: the state changed even when verification did not pass yet.
  await openP2pOrder(p2p.order.id);
  if (hint) $('p2pOrderHint').textContent = hint;
});
$('p2pOrderCancel')?.addEventListener('click', async () => {
  if (!p2p.order) return;
  const isBuyer = p2p.order.role === 'buyer';
  const paymentMarked = Boolean(p2p.order.usdtTxHash);
  const okGo = await askConfirm({
    title: 'Cancel order?',
    message: isBuyer
      ? (paymentMarked ? 'You submitted a payment hash. Cancelling gives up your claim on this trade — only do this if you did NOT actually pay. If you paid, open a dispute instead.' : 'The escrowed DLTX returns to the seller and the ad amount is restored. This cannot be undone.')
      : 'The buyer did not mark payment in time. Your escrowed DLTX unlocks immediately and your ad amount is restored.',
    confirmText: 'Cancel order',
    danger: true,
  });
  if (!okGo) return;
  try {
    const r = await api('POST', `/p2p/orders/${p2p.order.id}/cancel`, {});
    toast(r.code === 'ALREADY_CANCELLED' ? 'Order was already cancelled' : 'Order cancelled — escrow returned to the seller', { tone: 'success' });
    openP2pOrder(p2p.order.id);
  } catch (e) { toast(e.message, { tone: 'error' }); }
});
$('p2pOrderDispute')?.addEventListener('click', async () => {
  if (!p2p.order) return;
  const reason = $('p2pChatInput').value.trim();
  if (reason.length < 5) {
    $('p2pOrderHint').textContent = 'Type the dispute reason into the chat box first, then press Open dispute.';
    return;
  }
  const okGo = await askConfirm({ title: 'Open dispute?', message: 'The escrow freezes until a moderator resolves it.', rows: [['Reason', reason.slice(0, 80)]], confirmText: 'Open dispute', danger: true });
  if (!okGo) return;
  try {
    await api('POST', `/p2p/orders/${p2p.order.id}/dispute`, { reason });
    $('p2pChatInput').value = '';
    toast('Dispute opened — a moderator will review.', { tone: 'info', title: 'Escrow frozen' });
    openP2pOrder(p2p.order.id);
  } catch (e) { toast(e.message, { tone: 'error' }); }
});
async function p2pSendChat() {
  if (!p2p.order) return;
  const input = $('p2pChatInput');
  const body = input.value.trim();
  if (!body) return;
  const btn = $('p2pChatSend');
  btn.disabled = true;
  try {
    await api('POST', `/p2p/orders/${p2p.order.id}/messages`, { body });
    input.value = '';
    await loadP2pChat(p2p.order.id);
  } catch (e) {
    toast(e.message, { tone: 'error' });
  } finally {
    btn.disabled = false;
    input.focus();
  }
}
$('p2pChatSend')?.addEventListener('click', p2pSendChat);
$('p2pChatInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); p2pSendChat(); }
});

// ── Seller RELEASE DLTX (irreversible; strong confirmation; idempotent key per press) ──
$('p2pOrderRelease')?.addEventListener('click', async () => {
  const o = p2p.order;
  if (!o || !p2p.releaseRule?.allowed) return;
  const btn = $('p2pOrderRelease');
  const okGo = await askConfirm({
    title: `RELEASE ${fmt(o.amountDltx)} DLTX?`,
    message: 'WARNING: Only release DLTX after you have independently confirmed that the payment has actually arrived. Do not rely only on screenshots or messages from the buyer. This cannot be undone.',
    rows: [['Buyer', o.buyerCode || '—'], ['Trade', `P2P-${o.id}`], ['Buyer receives', `${fmt(o.buyerReceivesDltx)} DLTX (−1% fee)`], ['Payment', o.usdtVerified ? 'Verified at platform wallet ✅' : 'Marked by buyer — verify yourself']],
    confirmText: 'CONFIRM RELEASE',
    danger: true,
  });
  if (!okGo) return;
  btn.disabled = true;
  const idempotencyKey = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const r = await api('POST', `/p2p/orders/${o.id}/release`, { confirm: 'RELEASE', idempotencyKey });
    toast(r.code === 'ALREADY_RELEASED' ? 'This trade was already released.' : `Released — ${fmt(o.buyerReceivesDltx)} DLTX delivered to the buyer. Trade completed.`, { tone: 'success', title: 'Released' });
    openP2pOrder(o.id);
  } catch (e) {
    toast(e.message, { tone: 'error' });
    btn.disabled = false;
  }
});

// ── Moderator actions ──
$('p2pModApprove')?.addEventListener('click', async () => {
  if (!p2p.order) return;
  const okGo = await askConfirm({
    title: 'APPROVE DLTX RELEASE?',
    message: 'This releases the escrowed DLTX to the buyer. Only approve after verifying the USDT arrived at the platform wallet.',
    rows: [['Order', `#${p2p.order.id}`], ['Release', `${fmt(p2p.order.amountDltx)} DLTX`], ['Buyer gets', `${fmt(p2p.order.buyerReceivesDltx)} DLTX`]],
    confirmText: 'APPROVE RELEASE',
    danger: true,
  });
  if (!okGo) return;
  try {
    await api('POST', `/p2p/orders/${p2p.order.id}/approve-release`, {});
    toast('Escrow released — order completed. Now pay the seller and record the payout hash.', { tone: 'success', title: 'Released' });
    openP2pOrder(p2p.order.id, { moderator: true });
  } catch (e) { toast(e.message, { tone: 'error' }); }
});
async function p2pResolve(resolution) {
  if (!p2p.order) return;
  const reason = $('p2pModReason').value.trim();
  if (reason.length < 5) { toast('Enter a resolution reason first', { tone: 'error' }); return; }
  try {
    await api('POST', `/p2p/orders/${p2p.order.id}/resolve`, { resolution, reason });
    toast(`Resolution recorded: ${resolution.replace(/_/g, ' ')}`, { tone: 'success' });
    openP2pOrder(p2p.order.id, { moderator: true });
  } catch (e) { toast(e.message, { tone: 'error' }); }
}
$('p2pModRefund')?.addEventListener('click', () => p2pResolve('refund_to_seller'));
$('p2pModToBuyer')?.addEventListener('click', () => p2pResolve('release_to_buyer'));
$('p2pModEscalate')?.addEventListener('click', () => p2pResolve('escalate'));

// ── Moderator order controls: Cancel / Order completed / Release locked coins ──
$('p2pModCancel')?.addEventListener('click', async () => {
  if (!p2p.order) return;
  const reason = $('p2pModReason').value.trim();
  if (reason.length < 5) { toast('Enter a reason first (5+ characters)', { tone: 'error' }); return; }
  const verified = p2p.modOrderVerified;
  const okGo = await askConfirm({
    title: 'Cancel this order?',
    message: verified
      ? 'The buyer\'s USDT was VERIFIED at the platform wallet. Cancelling returns the DLTX to the seller — you must refund the buyer\'s USDT from the platform wallet yourself.'
      : 'The escrowed DLTX returns to the seller and the ad amount is restored (ad stays paused if it had filled).',
    rows: [['Order', `#${p2p.order.id}`], ['Escrow', `${fmt(p2p.order.amountDltx)} DLTX → seller`], ['Reason', reason.slice(0, 60)]],
    confirmText: verified ? 'I will refund the buyer — cancel' : 'Cancel order',
    danger: true,
  });
  if (!okGo) return;
  try {
    const r = await api('POST', `/p2p/moderation/orders/${p2p.order.id}/cancel`, { reason, acknowledgeUsdtRefund: verified });
    toast(r.code === 'ALREADY_CANCELLED' ? 'Order was already cancelled' : 'Order cancelled — escrow returned to the seller', { tone: 'success' });
    openP2pOrder(p2p.order.id, { moderator: true });
  } catch (e) { toast(e.message, { tone: 'error' }); }
});
$('p2pModComplete')?.addEventListener('click', async () => {
  if (!p2p.order) return;
  const reason = $('p2pModReason').value.trim();
  if (reason.length < 5) { toast('Enter a reason first (e.g. how the payment was confirmed)', { tone: 'error' }); return; }
  const okGo = await askConfirm({
    title: 'Mark order COMPLETED?',
    message: 'Releases the escrowed DLTX to the buyer WITHOUT on-chain USDT verification. Only do this after confirming the buyer\'s payment yourself.',
    rows: [['Order', `#${p2p.order.id}`], ['Buyer gets', `${fmt(p2p.order.buyerReceivesDltx)} DLTX`], ['Reason', reason.slice(0, 60)]],
    confirmText: 'COMPLETE ORDER',
    danger: true,
  });
  if (!okGo) return;
  try {
    const r = await api('POST', `/p2p/moderation/orders/${p2p.order.id}/complete`, { reason, confirm: 'COMPLETE' });
    toast(r.code === 'ALREADY_PROCESSED' ? 'Order was already completed' : 'Order completed — DLTX released to the buyer. Now pay the seller and record the payout hash.', { tone: 'success', title: 'Completed' });
    openP2pOrder(p2p.order.id, { moderator: true });
  } catch (e) { toast(e.message, { tone: 'error' }); }
});
$('p2pModReleaseLock')?.addEventListener('click', async () => {
  if (!p2p.order) return;
  const okGo = await askConfirm({ title: 'Release seller\'s locked coins?', message: 'Frees only DLTX that no open trade requires (left over from finished trades). Coins backing live trades are never touched.', confirmText: 'Release' });
  if (!okGo) return;
  try {
    const r = await api('POST', `/p2p/moderation/orders/${p2p.order.id}/release-lock`, {});
    toast(r.message, { tone: r.released > 0 ? 'success' : 'info' });
    openP2pOrder(p2p.order.id, { moderator: true });
  } catch (e) { toast(e.message, { tone: 'error' }); }
});
$('p2pPayoutBtn')?.addEventListener('click', async () => {
  if (!p2p.order) return;
  try {
    await api('POST', `/p2p/moderation/orders/${p2p.order.id}/payout`, { txHash: $('p2pPayoutHash').value.trim() });
    toast('Seller payout recorded', { tone: 'success' });
    openP2pOrder(p2p.order.id, { moderator: true });
  } catch (e) { toast(e.message, { tone: 'error' }); }
});

// ---------- Deltix Shop ----------
const SHOP_CAT_LABELS = { avatar: 'Avatars', theme: 'Themes', energy: 'Energy Packs', boost: 'Arcade Boosts' };
const SHOP_CAT_ORDER = ['avatar', 'theme', 'energy', 'boost'];
let shopState = { items: [], energy: 0, sendableDltx: 0 };

async function openShop() {
  showTab('tab-shop');
}
function closeShop() { const m = $('shopModal'); if (m) m.hidden = true; }
window.closeShop = closeShop;
$('openShopBtn')?.addEventListener('click', openShop);

async function loadShop() {
  try {
    shopState = await api('GET', '/shop');
    renderShop();
  } catch (e) {
    if ($('shopGrid')) $('shopGrid').innerHTML = `<p class="muted center">${e.message}</p>`;
  }
}

function shopPriceLabel(it) {
  return it.currency === 'energy' ? `⚡ ${it.price}` : `${fmt(it.price)} $DLTX`;
}
function renderShop() {
  $('shopEnergyBal').textContent = `⚡ ${fmt(shopState.energy)} Energy`;
  $('shopDltxBal').textContent = `${fmt(shopState.sendableDltx)} $DLTX`;
  const byCat = {};
  (shopState.items || []).forEach((it) => { (byCat[it.category] = byCat[it.category] || []).push(it); });
  $('shopGrid').innerHTML = SHOP_CAT_ORDER.filter((c) => byCat[c]).map((cat) => {
    const cards = byCat[cat].map((it) => {
      const disabled = it.owned || !it.affordable;
      const label = it.owned ? 'Owned ✓' : `Buy · ${shopPriceLabel(it)}`;
      const sub = it.category === 'energy' ? `+${it.grantEnergy} ⚡` : it.category === 'boost' ? `+${it.capBonus} cap today` : shopPriceLabel(it);
      return `<div class="shop-card${it.owned ? ' owned' : ''}">
        <span class="shop-emoji">${it.emoji}</span>
        <span class="shop-name">${it.name}</span>
        <span class="shop-sub">${sub}</span>
        <button class="btn ${disabled ? 'ghost' : 'primary'} shop-buy" data-item="${it.id}" ${disabled ? 'disabled' : ''}>${label}</button>
      </div>`;
    }).join('');
    return `<h4 class="shop-cat">${SHOP_CAT_LABELS[cat]}</h4><div class="shop-cat-grid">${cards}</div>`;
  }).join('');
  $('shopGrid').querySelectorAll('.shop-buy').forEach((b) =>
    b.addEventListener('click', () => buyShopItem(b.dataset.item, b))
  );
}

// A purchase that failed WITHOUT an answer from the server (dropped connection) is retried
// with the same id, so if the first try did go through the server returns its receipt
// instead of charging again. Any definite answer retires the id.
const shopPurchaseIds = new Map(); // item -> { id, at }
function shopPurchaseIdFor(item) {
  const hit = shopPurchaseIds.get(item);
  if (hit && Date.now() - hit.at < 8 * 60000) return hit.id;
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  shopPurchaseIds.set(item, { id, at: Date.now() });
  return id;
}

async function buyShopItem(id, btn) {
  const it = (shopState.items || []).find((x) => x.id === id);
  if (!it) return;
  if (btn) btn.disabled = true;
  try {
    const payload = { item: id, purchaseId: shopPurchaseIdFor(id), ...(it.currency === 'dltx' ? await getIntegrityPayload() : {}) };
    const r = await api('POST', '/shop/buy', payload, { retries: 0 });
    shopPurchaseIds.delete(id);
    await Promise.allSettled([loadShop(), loadEnergy(undefined, { force: true }), loadWallet()]);
    const msg = it.category === 'energy' ? `+${r.energyAwarded} ⚡ Energy added!`
      : it.category === 'boost' ? 'Arcade cap boosted for today! 🏆'
      : `${it.name} unlocked! 🎉`;
    try { window.ArcadeSound?.reward?.(); } catch {}
    $('shopStatus').textContent = msg;
    toast(msg);
  } catch (e) {
    if (e.status) shopPurchaseIds.delete(id);          // a definite answer — the next tap is a new purchase
    if (e.status !== 401) toast(e.status ? e.message : `${e.message} If you were charged, tap Buy again — you won’t be charged twice.`);
    if (btn) btn.disabled = false;
  }
}

// ---------- Deltix Daily Puzzle (crack the code) ----------
let puzzleState = null;
let puzzleGuess = [];

async function openPuzzle() {
  const m = $('puzzleModal');
  if (!m) return;
  m.hidden = false;
  puzzleGuess = [];
  $('puzzleStatus').textContent = '';
  $('puzzleBoard').innerHTML = '<p class="muted center">Loading…</p>';
  await loadPuzzle();
}
function closePuzzle() { const m = $('puzzleModal'); if (m) m.hidden = true; }
window.closePuzzle = closePuzzle;
$('openPuzzleBtn')?.addEventListener('click', openPuzzle);
$('puzzleClose')?.addEventListener('click', closePuzzle);

async function loadPuzzle() {
  try {
    puzzleState = await api('GET', '/puzzle');
    renderPuzzle();
  } catch (e) {
    if ($('puzzleBoard')) $('puzzleBoard').innerHTML = `<p class="muted center">${e.message}</p>`;
  }
}

function pzRow(g, len) {
  const digits = g.guess.map((d) => `<span class="pz-peg">${d}</span>`).join('');
  const marks = '🟢'.repeat(g.exact) + '🟡'.repeat(g.partial) + '⚪'.repeat(Math.max(0, len - g.exact - g.partial));
  return `<div class="pz-row"><div class="pz-digits">${digits}</div><div class="pz-marks">${marks}</div></div>`;
}

function renderPuzzle() {
  const s = puzzleState;
  const board = $('puzzleBoard');
  if (!board) return;
  if (!s || !s.enabled) {
    board.innerHTML = '<p class="muted center">The daily puzzle is not available right now.</p>';
    if ($('puzzleInput')) $('puzzleInput').innerHTML = '';
    return;
  }
  // Card subtitle reflects today's status.
  const sub = $('puzzleSub');
  if (sub) sub.textContent = s.done ? (s.solved ? 'Solved today ✓ — back tomorrow' : 'Come back tomorrow for a new code') : `Attempt ${s.attempts}/${s.maxAttempts} — solve to earn!`;

  board.innerHTML = s.guesses.length
    ? s.guesses.map((g) => pzRow(g, s.length)).join('')
    : '<p class="muted center small-note">No guesses yet — crack the code!</p>';

  const input = $('puzzleInput');
  if (s.done) {
    if (input) input.innerHTML = '';
    $('puzzleStatus').innerHTML = s.solved
      ? `Solved in ${s.attempts} ${s.attempts === 1 ? 'try' : 'tries'}! 🎉`
      : `Out of tries. The code was <b>${(s.secret || []).join(' ')}</b>.`;
    return;
  }
  const slots = Array.from({ length: s.length }, (_, i) => `<span class="pz-slot${puzzleGuess[i] ? ' filled' : ''}">${puzzleGuess[i] || ''}</span>`).join('');
  const digitBtns = Array.from({ length: s.digits }, (_, i) => `<button class="pz-digit" data-d="${i + 1}">${i + 1}</button>`).join('');
  input.innerHTML = `
    <div class="pz-current">${slots}</div>
    <div class="pz-pad">${digitBtns}</div>
    <div class="pz-actions">
      <button class="btn ghost" id="pzBack" type="button">⌫</button>
      <button class="btn primary" id="pzSubmit" type="button" ${puzzleGuess.length === s.length ? '' : 'disabled'}>Guess ▸</button>
    </div>
    <div class="pz-legend">Attempt ${s.attempts + 1} of ${s.maxAttempts}</div>`;
  input.querySelectorAll('.pz-digit').forEach((b) => b.addEventListener('click', () => {
    if (puzzleGuess.length < s.length) { puzzleGuess.push(Number(b.dataset.d)); renderPuzzle(); }
  }));
  $('pzBack')?.addEventListener('click', () => { puzzleGuess.pop(); renderPuzzle(); });
  $('pzSubmit')?.addEventListener('click', submitPuzzleGuess);
}

async function submitPuzzleGuess() {
  const s = puzzleState;
  if (!s || puzzleGuess.length !== s.length) return;
  const btn = $('pzSubmit');
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/puzzle/guess', { guess: puzzleGuess.slice(), ...await getIntegrityPayload() });
    puzzleState = r;
    puzzleGuess = [];
    renderPuzzle();
    if (r.justSolved) {
      const rw = r.reward || {};
      if (rw.dltx > 0) {
        (window.celebrate || toast)({ amount: rw.dltx, title: 'Puzzle Solved! 🧩', subtitle: `Cracked the code in ${r.attempts}!`, icon: '🧩' });
      } else {
        try { window.ArcadeSound?.reward?.(); } catch {}
        toast(`Solved! +${rw.energy || 0} ⚡ Energy 🎉`);
      }
      Promise.allSettled([loadWallet(), loadEnergy(undefined, { force: true }), loadRewards()]);
    } else if (r.justFailed) {
      try { window.ArcadeSound?.lose?.(); } catch {}
      toast('Out of tries — the code is revealed. Back tomorrow!');
    } else {
      toast(`${r.feedback.exact} in place · ${r.feedback.partial} misplaced`);
    }
  } catch (e) {
    if (e.status !== 401) toast(e.message);
    if (btn) btn.disabled = false;
  }
}
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
const dailyChallengeState = { data: null };
let rewardTimer = null;
let lastRewardInterstitial = 0;
const fmtInt = (n) => Number(n || 0).toLocaleString();

async function loadDailyChallenge() {
  if (!state.token) return;
  try {
    const r = await api('GET', '/community/daily-challenge');
    dailyChallengeState.data = r;
    renderDailyChallenge();
  } catch { /* handled by api() */ }
}

function renderDailyChallenge() {
  const d = dailyChallengeState.data;
  const fill = $('dailyChallengeFill');
  const label = $('dailyChallengeLabel');
  const list = $('dailyChallengeList');
  const btn = $('dailyChallengeBtn');
  if (!fill || !label || !list || !btn) return;
  if (!d) {
    fill.style.width = '0%';
    label.textContent = 'Loading challenge…';
    list.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Loading challenge…';
    return;
  }
  fill.style.width = `${d.progress || 0}%`;
  label.textContent = `${d.completed}/${d.total} complete · ${d.rewardText}`;
  list.innerHTML = (d.tasks || []).map((task) => `
    <div class="daily-challenge-item ${task.progress >= task.goal ? 'complete' : ''}">
      <span class="daily-challenge-dot"></span>
      <div class="daily-challenge-copy">
        <b>${task.title}</b>
        <small>${task.hint}</small>
      </div>
      <span class="daily-challenge-badge">${task.reward}</span>
    </div>
  `).join('');
  btn.disabled = !d.claimable;
  btn.textContent = d.claimed ? 'Bonus claimed ✓ · back tomorrow' : d.claimable ? 'Claim +20 ⚡ bonus' : 'Complete 3 tasks to claim';
}

async function claimDailyChallenge() {
  const btn = $('dailyChallengeBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/community/daily-challenge/claim', await getIntegrityPayload());
    dailyChallengeState.data = r.challenge;
    renderDailyChallenge();
    celebrate({ amount: r.energyAwarded, unit: '⚡ Energy', title: 'Daily Challenge Complete!', subtitle: 'Come back tomorrow for another bonus.', icon: '🎯' });
    await Promise.allSettled([loadEnergy(undefined, { force: true }), loadDailyChallenge()]);
    showRewardInterstitial();
  } catch (e) {
    if (e.data?.challenge) dailyChallengeState.data = e.data.challenge;
    renderDailyChallenge();
    toast(e.message);
  }
}

/** Frequency-capped interstitial for reward actions (native only). */
function showRewardInterstitial() {
  if (window.ADS_ENABLED === false) return;
  const cap = window.Capacitor;
  const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !AdMob) return;
  if (Date.now() - lastRewardInterstitial < 40000) return; // stay inside AdMob limits
  lastRewardInterstitial = Date.now();
  showPreloadedInterstitial();
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
  const lockedNote = $('wheelLockedNote');
  if (lockedNote) lockedNote.hidden = !(sp.segments || []).some((s) => s.locked);
  if (redrawWheel && rewardState.wheelMode !== 'paid' && !rewardState.spinning) {
    rewardState.wheelSegs = sp.segments;
    drawWheel();
  }

  // Daily chest
  const ch = d.chest;
  setText('chestSub', ch.ready
    ? 'Pick one chest — one holds $DLTX, the other two hold Energy.'
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
    const active = document.querySelector('.tab.active')?.id;
    if (active !== 'tab-rewards' && active !== 'tab-game-wheel') return;
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

// ==================== FAQ (data-driven, searchable) ====================
// Content lives in faq-data.js (window.DELTIX_FAQ) — one source shared with
// the website. Supports live text search + category filtering.
const faqState = { query: '', category: 'all', wired: false };

function renderFaq() {
  const list = $('faqList');
  const cats = $('faqCats');
  const data = window.DELTIX_FAQ || [];
  if (!list || !cats) return;

  if (!faqState.wired) {
    faqState.wired = true;
    $('faqSearch')?.addEventListener('input', (e) => {
      faqState.query = String(e.target.value || '').trim().toLowerCase();
      renderFaq();
    });
    cats.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-faq-cat]');
      if (!btn) return;
      faqState.category = btn.dataset.faqCat;
      renderFaq();
    });
  }

  cats.innerHTML = [{ id: 'all', name: 'All', icon: '📚' }, ...data]
    .map((c) => `<button type="button" class="faq-cat${faqState.category === c.id ? ' active' : ''}" data-faq-cat="${c.id}">${c.icon} ${c.name}</button>`)
    .join('');

  const q = faqState.query;
  const matches = (it) => !q || it.q.toLowerCase().includes(q) || it.a.toLowerCase().includes(q);
  const sections = data
    .filter((c) => faqState.category === 'all' || c.id === faqState.category)
    .map((c) => ({ ...c, items: c.items.filter(matches) }))
    .filter((c) => c.items.length > 0);

  if (!sections.length) {
    list.innerHTML = '<p class="muted small-note faq-empty">No answers match your search. Try different words, or email support@deltixllc.com.</p>';
    return;
  }
  list.innerHTML = sections
    .map((c) => `<div class="pp-section-label">${c.icon} ${escapeHtml(c.name)}</div>` + c.items
      .map((it) => `<details class="faq-item"${q ? ' open' : ''}><summary>${escapeHtml(it.q)}</summary><p>${escapeHtml(it.a)}</p></details>`)
      .join(''))
    .join('');
}

// ==================== Deltix Earn (Path 2) ====================
// Completely separate from games: spend Energy to start a timed session, wait
// for it, then claim its $DLTX reward. Lives only on its own dedicated page.
const earnState = { data: null };

// One shared, server-authoritative Earn clock. The server sends the remaining
// time of the running session; we anchor it to performance.now() (monotonic —
// unaffected by the user changing the device clock or time zone) and derive
// every countdown on screen from that single anchor. The anchor is refreshed
// from the server on launch, resume, reconnect and every 30s while running, so
// background throttling or device sleep can never leave it drifting.
const earnClock = { synced: false, msAtSync: 0, perfAtSync: 0, lastPoll: 0 };
let earnTicker = null;
let earnLoading = null;

function earnRemainingMs() {
  if (!earnState.data?.active || !earnClock.synced) return 0;
  return Math.max(0, earnClock.msAtSync - (performance.now() - earnClock.perfAtSync));
}

function applyEarnSnapshot(d, requestedAtPerf) {
  const now = performance.now();
  earnState.data = d;
  earnClock.synced = true;
  // The server computed msRemaining roughly half a round-trip before we got it.
  const transit = requestedAtPerf != null ? Math.max(0, (now - requestedAtPerf) / 2) : 0;
  earnClock.msAtSync = Math.max(0, Number(d.msRemaining) - transit);
  earnClock.perfAtSync = now;
  startEarnTicker();
}

async function loadEarn() {
  if (!state.token) return;
  if (earnLoading) return earnLoading;
  earnLoading = (async () => {
    const t0 = performance.now();
    try {
      applyEarnSnapshot(await api('GET', '/earn'), t0);
      renderEarn();
    } catch { /* handled by api() */ } finally {
      earnClock.lastPoll = performance.now();
      earnLoading = null;
    }
  })();
  return earnLoading;
}

const pad2 = (n) => String(n).padStart(2, '0');
function setClockDigits(prefix, h, m, s) {
  const els = [$(`${prefix}Hours`), $(`${prefix}Minutes`), $(`${prefix}Seconds`)];
  [h, m, s].forEach((v, i) => { if (els[i] && els[i].textContent !== v) els[i].textContent = v; });
}

// Paints every Earn countdown (Wallet card + Earn page) from the same state.
function paintEarnClock() {
  const d = earnState.data;
  let label = 'NEXT EARN IN';
  let digits = ['--', '--', '--'];
  if (d && earnClock.synced) {
    const rem = earnRemainingMs();
    const total = Math.ceil(rem / 1000);
    if (!d.active) { label = 'READY TO START'; digits = ['00', '00', '00']; }
    else if (d.canClaim) { label = 'EARN READY'; digits = ['00', '00', '00']; }
    else {
      if (rem <= 0) label = 'CONFIRMING…';
      digits = [pad2(Math.floor(total / 3600)), pad2(Math.floor((total % 3600) / 60)), pad2(total % 60)];
    }
  }
  setClockDigits('walletCountdown', ...digits);
  setClockDigits('countdown', ...digits);
  ['walletTimerLabel', 'earnTimerLabel'].forEach((id) => { const el = $(id); if (el && el.textContent !== label) el.textContent = label; });
}

function startEarnTicker() {
  if (!earnTicker) earnTicker = setInterval(earnTick, 1000);
  paintEarnClock();
}
function stopEarnTicker() {
  if (earnTicker) { clearInterval(earnTicker); earnTicker = null; }
}

function earnTick() {
  paintEarnClock();
  const d = earnState.data;
  if (!state.token || !d?.active || document.hidden) return;
  const rem = earnRemainingMs();
  if (!d.canClaim) {
    const sub = $('earnSub'); const b = $('earnBtn');
    const text = rem > 0 ? fmtCountdown(rem) : null;
    if (sub) sub.textContent = text ? `Ready in ${text} · ${fmt(d.reward)} DLTX locked in` : 'Confirming with the server…';
    if (b && !b.hidden) b.textContent = text ? `⏳ ${text}` : '⏳ Confirming…';
  }
  const sinceSync = performance.now() - earnClock.perfAtSync;
  const sincePoll = performance.now() - earnClock.lastPoll;
  // At zero the claim button unlocks only once the server confirms eligibility.
  if (!d.canClaim && ((rem <= 0 && sincePoll > 3000) || (sinceSync > 30000 && sincePoll > 30000))) loadEarn();
}

// The countdown is shared, so these legacy entry points just (re)start it.
function startNextEarnTimer() { startEarnTicker(); }
function stopNextEarnTimer() { stopEarnTicker(); }
function startWalletTimer() { startEarnTicker(); }
function stopWalletTimer() { stopEarnTicker(); }

function renderEarn() {
  const d = earnState.data;
  const pkgEl = $('earnPackages');
  if (!d) {
    setText('earnStatus', '◆ Deltix Earn');
    setText('earnSub', 'Sign in to start earning.');
    const b = $('earnBtn'); if (b) { b.disabled = true; b.textContent = 'Loading…'; }
    if (pkgEl) pkgEl.innerHTML = '';
    return;
  }
  const ready = d.canClaim;
  const running = d.active && !ready;
  const remainingText = fmtCountdown(earnRemainingMs());
  const packages = Array.isArray(d.packages) ? d.packages : [];
  setText('earnStatus', ready ? `◆ ${fmt(d.reward)} DLTX READY` : running ? `◆ Deltix Earn — running${d.packageLabel ? ` · ${d.packageLabel}` : ''}` : '◆ Deltix Earn');
  setText(
    'earnSub',
    ready
      ? 'Your session is complete — claim your $DLTX.'
      : running
      ? `Ready in ${remainingText} · ${fmt(d.reward)} DLTX locked in`
      : `You have ⚡ ${fmt(d.energy)} Energy. Choose a package below — every package runs ${d.durationHours}h.`
  );
  const b = $('earnBtn');
  if (b) {
    // The big button handles CLAIM (and the countdown); starting is per package.
    b.hidden = !d.active;
    b.disabled = running || !d.enabled;
    b.textContent = ready ? `Claim ◆ ${fmt(d.reward)} DLTX` : `⏳ ${remainingText}`;
  }
  if (pkgEl) {
    pkgEl.hidden = d.active;
    pkgEl.innerHTML = packages.map((p) => `
      <div class="earn-pkg ${p.canStart ? '' : 'earn-pkg-off'}">
        <div class="earn-pkg-energy">⚡ ${fmt(p.energy)} Energy</div>
        <div class="earn-pkg-reward">Earn <b>${fmt(p.rewardDltx)} DLTX</b></div>
        <div class="muted small-note">Duration: ${p.durationHours} Hours</div>
        <button class="btn gold earn-pkg-btn" data-pkg="${p.id}" ${p.canStart && d.enabled ? '' : 'disabled'}>${p.canStart ? 'START' : `Need ⚡ ${fmt(Math.max(0, p.energy - d.energy))} more`}</button>
      </div>`).join('');
    pkgEl.querySelectorAll('[data-pkg]').forEach((btn) => btn.addEventListener('click', () => startEarnSession(btn.dataset.pkg)));
  }
  setText('earnRateNote', d.active
    ? `Reward and cost were locked in when this session started. Closing the app does not reset the timer — it runs on the server.`
    : `Current Earn Rates: ${packages.map((p) => `${fmt(p.energy)}⚡ → ${fmt(p.rewardDltx)} DLTX`).join(' · ')} per ${d.durationHours}h — subject to change as the network grows.`);
}

async function handleEarnAction() {
  const d = earnState.data;
  if (!d) return;
  if (d.canClaim) return claimEarnSession();
}

let earnStarting = false;
async function startEarnSession(packageId) {
  if (earnStarting) return;
  const d = earnState.data;
  const pkg = d && Array.isArray(d.packages) ? d.packages.find((p) => p.id === packageId) : null;
  if (!pkg) return;
  const okGo = await askConfirm({
    title: `Start Deltix Earn · ${fmt(pkg.rewardDltx)} DLTX?`,
    message: `⚡ ${fmt(pkg.energy)} Energy will be spent now. The ${pkg.durationHours}-hour timer runs on the server; closing the app does not reset it.`,
    rows: [['Energy', `⚡ ${fmt(pkg.energy)}`], ['Reward', `${fmt(pkg.rewardDltx)} DLTX`], ['Duration', `${pkg.durationHours} hours`]],
    confirmText: 'START',
  });
  if (!okGo) return;
  earnStarting = true;
  try {
    const t0 = performance.now();
    const r = await api('POST', '/earn/start', { packageId });
    applyEarnSnapshot(r, t0);
    renderEarn();
    toast(`Deltix Earn session started — ${fmt(r.reward)} DLTX ready in ${r.durationHours}h.`, { tone: 'success' });
    loadEnergy(undefined, { force: true }).catch(() => {});
  } catch (e) {
    toast(e.message, { tone: 'error' });
  } finally {
    earnStarting = false;
  }
}

let earnClaiming = false;
async function claimEarnSession() {
  if (earnClaiming) return;
  earnClaiming = true;
  const b = $('earnBtn'); if (b) b.disabled = true;
  try {
    const payload = await getIntegrityPayload();
    const t0 = performance.now();
    const r = await api('POST', '/earn/claim', payload);
    applyEarnSnapshot(r, t0);
    renderEarn();
    celebrate({ amount: r.claimed, title: 'Deltix Earn Complete!', subtitle: 'Start another package any time.', icon: '◆' });
    await Promise.allSettled([loadWallet(), loadEnergy(undefined, { force: true }), loadTx()]);
    showRewardInterstitial();
  } catch (e) {
    toast(e.message, { tone: 'error' });
    if (e.code === 'EARN_ALREADY_CLAIMED' || e.code === 'EARN_NOT_ACTIVE' || e.code === 'EARN_NOT_READY') loadEarn();
    else if (b) b.disabled = false;
  } finally {
    earnClaiming = false;
  }
}

function resetEarnUI() {
  earnState.data = null;
  earnClock.synced = false;
  paintEarnClock();
  renderEarn();
}

$('earnBtn')?.addEventListener('click', handleEarnAction);
$('dailyChallengeBtn')?.addEventListener('click', claimDailyChallenge);

// ---- Fortune wheel canvas ----
const WHEEL_PALETTE = ['#6366f1', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#0ea5e9'];

function segLabel(s) {
  if (s.locked) return `🔒${s.amount}Δ`;
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
    const locked = Boolean(segs[i].locked);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, a0, a1);
    ctx.closePath();
    // Locked preview segments render visibly greyed-out — the wheel can never
    // land on them and the UI must never suggest otherwise.
    ctx.fillStyle = locked ? '#475569' : WHEEL_PALETTE[i % WHEEL_PALETTE.length];
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.save();
    ctx.rotate(a0 + seg / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = locked ? 'rgba(255,255,255,.7)' : '#fff';
    ctx.font = locked ? 'bold 11px system-ui, sans-serif' : 'bold 14px system-ui, sans-serif';
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
  try { window.ArcadeSound?.unlock?.(); window.ArcadeSound?.coin?.(); } catch {}
  const vis = $('boxVisual');
  if (vis) vis.classList.add('box-shake');
  try {
    const r = await api('POST', '/rewards/mystery-box', { useEnergy: !!useEnergy });
    if (vis) { vis.classList.remove('box-shake'); vis.classList.add('opened'); }
    if (r.capped) toast('Box opened — daily $DLTX cap reached. Try again tomorrow!');
    else celebrate({ amount: r.reward, title: 'Mystery Box Opened!', subtitle: 'You found a $DLTX reward inside.', icon: '📦' });
    await Promise.allSettled([loadRewards(), loadWallet(), loadEnergy(undefined, { force: true }), loadTx()]);
    showRewardInterstitial();
    setTimeout(() => { if (vis) vis.classList.remove('opened'); }, 1800);
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
  try { window.ArcadeSound?.unlock?.(); window.ArcadeSound?.tap?.(); } catch {}
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
    await Promise.allSettled([loadRewards(), loadWallet(), loadEnergy(undefined, { force: true }), loadTx()]);
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
    try { window.ArcadeSound?.unlock?.(); window.ArcadeSound?.coin?.(); } catch {}
    document.querySelectorAll('.chest-pick').forEach((x) => (x.disabled = true));
    b.classList.add('picked');
    try {
      const r = await api('POST', '/rewards/chest', { pick });
      const labels = {
        dltx: `+${fmt(rewardState.data.chest.dltx)} $DLTX`,
        energy_low: `+${rewardState.data.chest.energyLow} ⚡`,
        energy_high: `+${rewardState.data.chest.energyHigh} ⚡`,
      };
      document.querySelectorAll('.chest-pick').forEach((x) => {
        const outcome = r.outcomes[Number(x.dataset.pick)];
        x.classList.add('win');
        const span = x.querySelector('span');
        if (span) span.textContent = labels[outcome];
      });
      const msg = r.chosen === 'dltx'
        ? (r.capped ? 'You picked $DLTX, but the daily cap is reached!' : `🎉 You won +${fmt(r.reward)} $DLTX!`)
        : `⚡ You won +${r.energyAwarded} Energy!`;
      setText('chestResult', msg);
      if (r.chosen === 'dltx' && !r.capped && r.reward > 0) celebrate({ amount: r.reward, title: 'Mystery Chest Unlocked!', subtitle: 'A shiny $DLTX reward is yours.', icon: '🎁' });
      else if (r.energyAwarded > 0) celebrate({ amount: r.energyAwarded, unit: '⚡ Energy', title: 'Mystery Chest Unlocked!', subtitle: `You now have ${fmt(r.energy)} ⚡ total.`, icon: '🎁' });
      else toast(msg);
      await Promise.allSettled([loadRewards(), loadWallet(), loadEnergy(undefined, { force: true }), loadTx()]);
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
    const r = await api('POST', '/missions/complete');
    missionState.data = r;
    renderMissions();
    if (r.allComplete) celebrate({ amount: 0, milestone: true, title: '🌕 Moon Landing!', subtitle: 'All 6 missions complete — claim your daily reward!' });
    else { try { window.ArcadeSound?.unlock?.(); window.ArcadeSound?.coin?.(); } catch {} toast(`${r.completedMission?.name || 'Mission'} complete — ${r.progress} ✅`); }
    showRewardInterstitial();
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
    const r = await api('POST', '/missions/claim');
    missionState.data = r;
    const rw = r.reward || {};
    if (rw.kind === 'dltx' && rw.reward > 0) celebrate({ amount: rw.reward, title: 'Mission Reward!', subtitle: 'Straight to your wallet.', icon: '💎' });
    else if (rw.kind === 'energy' && rw.energyAwarded > 0) celebrate({ amount: rw.energyAwarded, unit: '⚡ Energy', title: 'Mission Reward!', subtitle: 'Non-monetary Energy added.', icon: '⚡' });
    else toast('Daily $DLTX cap reached — try again tomorrow.');
    await Promise.allSettled([loadWallet(), loadEnergy(undefined, { force: true }), loadTx(), loadRewards()]);
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
    await Promise.allSettled([loadWallet(), loadEnergy(undefined, { force: true }), loadTx()]);
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
  // Count is server-driven (expanded 12 → 20; adjustable without a release).
  const maxCountries = Number(d.maxCountries) || 20;
  const rows = (d.countries || []).slice(0, maxCountries).map((c) => ({
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
const communityState = { lbScope: 'country', lbData: null, season: null, passport: null };
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

async function loadSeason() {
  if (!state.token) return;
  try {
    const r = await api('GET', '/community/season');
    communityState.season = r;
    renderSeason();
  } catch { /* handled by api() */ }
}

function renderSeason() {
  const d = communityState.season;
  const header = $('seasonHeader');
  if (header) {
    if (!d) {
      header.textContent = 'Loading season…';
      return;
    }
    header.textContent = `${d.title} · ${fmtInt(d.totals?.players || 0)} players active · resets in ${d.daysRemaining ?? '?'}d`;
  }

  const list = $('seasonList');
  if (!list) return;
  if (!d || !d.season || !d.season.length) {
    list.innerHTML = '<p class="muted center">Season standings are loading…</p>';
  } else {
    list.innerHTML = d.season.map((p) => `
      <div class="season-row${p.isYou ? ' me' : ''}">
        <span class="season-rank">${p.rank <= 3 ? ['🥇', '🥈', '🥉'][p.rank - 1] : p.rank}</span>
        <span class="season-name">${p.handle}${p.isYou ? ' · You' : ''}</span>
        <span class="season-xp">${fmtInt(p.xp)} XP</span>
      </div>
    `).join('');
  }

  const rewards = $('seasonRewards');
  if (rewards) {
    if (!d || !d.rewardTiers) {
      rewards.innerHTML = '';
    } else {
      rewards.innerHTML = d.rewardTiers.map((tier) => `
        <div class="season-reward${tier.unlocked ? ' unlocked' : ''}">
          <div class="sr-top"><span class="sr-title">${tier.title}</span><span>${tier.icon}</span></div>
          <div class="sr-perk">Top ${tier.rank === 100 ? '100' : tier.rank}</div>
          <div class="sr-perk">${tier.perk}</div>
        </div>
      `).join('');
    }
  }
}

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
  loadBadges().catch(() => {});
}

// ---- Achievement badges (server-evaluated, placeholder art) ----
async function loadBadges() {
  if (!state.token) return;
  const grid = $('badgesGrid');
  if (!grid) return;
  try {
    const r = await api('GET', '/badges');
    setText('badgesCount', `${r.unlockedCount}/${r.total}`);
    grid.innerHTML = (r.badges || []).map((b) => `
      <div class="pp-stamp${b.unlocked ? ' earned' : ''}" title="${escapeHtml(b.name)} — ${escapeHtml(b.condition)}">
        <span class="pps-icon">${b.unlocked ? b.emoji : '🔒'}</span>
        <span class="pps-name">${escapeHtml(b.name)}</span>
        <span class="pps-prog">${b.unlocked ? (b.earnedAt ? new Date(b.earnedAt).toLocaleDateString() : 'Earned') : escapeHtml(b.rarity)}</span>
      </div>`).join('');
  } catch { /* handled by api() */ }
}

function renderPassport() {
  const d = communityState.passport;
  if (!d) return;
  setText('ppStamps', `${d.stampsEarned}/${d.stampsTotal}`);
  setText('ppMedals', `${d.medalsEarned}/${d.medalsTotal}`);
  setText('ppStreak', d.currentStreak);
  const mg = $('ppMedalsGrid');
  if (mg) mg.innerHTML = (d.medals || []).map((m) => `
    <div class="pp-medal${m.earned ? ' earned' : ''}" title="${escapeHtml(m.name)} — Day ${m.day}">
      <span class="ppm-emoji">${m.earned ? m.emoji : '🔒'}</span>
      <span class="ppm-day">Day ${m.day}</span>
    </div>`).join('');
  const sg = $('ppStampsGrid');
  if (sg) sg.innerHTML = (d.stamps || []).map((s) => `
    <div class="pp-stamp${s.earned ? ' earned' : ''}" title="${escapeHtml(s.name)} — ${escapeHtml(s.condition)}">
      <span class="pps-icon">${s.earned ? s.emoji : '🔒'}</span>
      <span class="pps-name">${escapeHtml(s.name)}</span>
      <span class="pps-prog">${s.earned ? (s.earnedAt ? new Date(s.earnedAt).toLocaleDateString() : 'Earned') : escapeHtml(s.rarity)}</span>
    </div>`).join('');
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
  communityState.season = null;
  communityState.passport = null;
  const list = $('lbList'); if (list) list.innerHTML = '<p class="muted center">Loading rankings…</p>';
  const you = $('lbYou'); if (you) you.textContent = 'Play games and check in daily to climb the ranks.';
  const seasonList = $('seasonList'); if (seasonList) seasonList.innerHTML = '<p class="muted center">Loading season standings…</p>';
  const seasonHeader = $('seasonHeader'); if (seasonHeader) seasonHeader.textContent = 'Loading season…';
  setText('ppStamps', '0/0'); setText('ppMedals', '0/0'); setText('ppStreak', '0');
  const mg = $('ppMedalsGrid'); if (mg) mg.innerHTML = '';
  const sg = $('ppStampsGrid'); if (sg) sg.innerHTML = '';
  const bg = $('badgesGrid'); if (bg) bg.innerHTML = '';
  setText('badgesCount', '0/0');
}

/** Why an ad did not pay out, in words a person understands. */
function adFailureText(reason) {
  switch (reason) {
    case 'disabled': return 'Ads are temporarily unavailable — please try again later.';
    case 'offline': return 'You’re offline — connect to the internet to watch an ad.';
    case 'unavailable': return 'No ad is available right now. Please try again in a minute.';
    case 'timeout': return 'The ad took too long to load. Please try again.';
    case 'failed_to_show': return 'The ad couldn’t be shown. Please try again in a moment.';
    case 'busy': return 'An ad is already playing.';
    case 'closed': return 'You closed the ad before it finished — no reward this time.';
    default: return 'The ad wasn’t completed — no reward this time.';
  }
}

/**
 * Opt-in rewarded ad. Resolves `{ earned, reason, nonce }`.
 *  - earned is true ONLY when the SDK reported the reward. Closing an ad early,
 *    a failed load/show, a timeout or being offline are all `earned: false`.
 *  - `nonce` identifies this one ad; it is also the customData AdMob signs into
 *    its server-side-verification callback.
 *  - Nothing here can hang the UI: every stage has a timeout.
 * Rewards must stay non-transferable in-app benefits (never $DLTX).
 */
async function playRewardedAdDetailed() {
  const result = (earned, reason, nonce = null) => {
    const r = { earned, reason, nonce, at: Date.now() };
    window.lastAdResult = r;
    return r;
  };
  if (!ADS_ENABLED || window.ADS_ENABLED === false) return result(false, 'disabled');
  const cap = window.Capacitor;
  const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
  const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform() && AdMob);

  if (!native) {
    // Web / dev fallback — disclosed simulated ad so the flow is testable.
    const okd = await askConfirm({
      title: 'Simulated rewarded ad',
      message: 'Web preview — on a real device this plays a full AdMob rewarded video.',
      confirmText: '▶ Continue',
    });
    if (!okd) return result(false, 'closed');
    await new Promise((r) => setTimeout(r, 600));
    return result(true, 'earned', newAdNonce());
  }
  if (navigator.onLine === false) return result(false, 'offline');
  if (adState.playing) return result(false, 'busy');
  adState.playing = true;

  return new Promise((resolve) => {
    let earned = false;
    let dismissed = false;
    let settled = false;
    const handles = [];
    const timers = [];
    const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
    let showTimer = null;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      handles.forEach((h) => { try { h?.remove?.(); } catch {} });
      const nonce = adState.nonce;
      rewardedLoaded = false;
      adState.nonce = null;
      adState.playing = false;
      adState.showing = false;
      resolve(result(reason === 'earned', reason, reason === 'earned' ? nonce : null));
      // Line up the next ad, but let the ad screen finish closing first.
      setTimeout(() => { if (!adState.playing) preloadRewardedAd(); }, 1200);
    };

    (async () => {
      try {
        // Listener registration is asynchronous; install all handlers before
        // loading/showing so quick callbacks cannot be lost.
        handles.push(await AdMob.addListener('onRewardedVideoAdReward', () => { earned = true; if (dismissed) finish('earned'); }));
        handles.push(await AdMob.addListener('onRewardedVideoAdShowed', () => { clearTimeout(showTimer); }));
        // Dismissal is the end of the ad. A grace period lets a late reward event land first.
        handles.push(await AdMob.addListener('onRewardedVideoAdDismissed', () => {
          dismissed = true;
          if (earned) finish('earned'); else later(() => finish(earned ? 'earned' : 'closed'), AD_REWARD_GRACE_MS);
        }));
        handles.push(await AdMob.addListener('onRewardedVideoAdFailedToShow', () => finish('failed_to_show')));
        // A failed *load* is reported through the load call itself (below). It must never end an ad that is already playing.
        handles.push(await AdMob.addListener('onRewardedVideoAdFailedToLoad', () => { adState.lastError = 'no-fill'; }));
        if (settled) return;
        later(() => finish(earned ? 'earned' : 'timeout'), AD_HARD_TIMEOUT_MS);

        // Reuse an in-flight preload rather than starting a competing load. One quick second try covers a passing no-fill.
        let ready = rewardedLoaded || (await preloadRewardedAd());
        if (!ready && !settled && navigator.onLine !== false) { await sleepMs(1500); ready = await preloadRewardedAd(); }
        // When the server asks for proof of the ad, the ad must have been loaded WITH it.
        const session = await ensureAdSession();
        const needsSsv = session.mode && session.mode !== 'off';
        if (ready && needsSsv && !adState.preparedWithSsv) { rewardedLoaded = false; ready = await preloadRewardedAd(); }
        if (settled) return;
        if (!ready) { finish(adState.lastError === 'load-timeout' ? 'timeout' : 'unavailable'); return; }

        rewardedLoaded = false;
        adState.showing = true;
        showTimer = later(() => finish('failed_to_show'), AD_SHOW_TIMEOUT_MS);
        const item = await AdMob.showRewardVideoAd();
        if (item) { earned = true; if (dismissed) finish('earned'); } // the plugin resolves only when the user actually earned the reward
      } catch (error) {
        console.warn('[ads] rewarded ad could not be shown', error);
        finish('failed_to_show');
      }
    })();
  });
}

/** Boolean form kept for the many existing callers. The reason is in window.lastAdResult. */
async function playRewardedAd() {
  return (await playRewardedAdDetailed()).earned;
}

/**
 * Asks the server to credit a completed ad. AdMob's own confirmation (server-side
 * verification) can trail the ad by a few seconds, so "not verified yet" is retried
 * with the SAME nonce; a dropped connection is retried too, safely — the server
 * pays one ad only once, however many times it is asked.
 */
async function postAdReward(path, body, { onConfirming } = {}) {
  let attempt = 0;
  let networkRetried = false;
  for (;;) {
    try {
      return await api('POST', path, body, { retries: 0 });
    } catch (e) {
      if (e.data?.code === 'AD_NOT_VERIFIED' && attempt < 2) {
        if (attempt === 0 && onConfirming) onConfirming();
        attempt += 1;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!e.status && attempt < 3) {
        networkRetried = true;
        attempt += 1;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      // The first attempt may have been credited even though its reply was lost.
      if (networkRetried && e.data?.code === 'AD_DUPLICATE') e.alreadyCredited = true;
      throw e;
    }
  }
}

// ---------- KYC & Integrations: Card Data & Rendering ----------

// KYC & Validators data
const kycData = [
  { name: 'Persona', desc: 'Identity verification', icon: '✓', color: 'blue-gradient' },
  { name: 'Binance', desc: 'Trading validator', icon: '🔀', color: 'purple-gradient' },
  { name: 'Coinbase', desc: 'Exchange validator', icon: '🪙', color: 'pink-gradient' },
  { name: 'Kraken', desc: 'Crypto exchange', icon: '🐙', color: 'red-gradient' },
  { name: 'Bybit', desc: 'Trading platform', icon: '📈', color: 'orange-gradient' },
  { name: 'OKX', desc: 'CEX validator', icon: '🔑', color: 'cyan-gradient' },
];

// Network validators
const networkValidators = [
  { name: 'Binance Validator', desc: 'High commission tier', icon: '🏆', color: 'indigo-gradient' },
  { name: 'Coinbase Pro', desc: 'Premium staking', icon: '💎', color: 'emerald-gradient' },
  { name: 'Kraken Labs', desc: 'Research validator', icon: '🔬', color: 'fuchsia-gradient' },
  { name: 'Bybit Masters', desc: 'Elite validator node', icon: '⭐', color: 'rose-gradient' },
  { name: 'OKX Tier 1', desc: 'Premium features', icon: '🎖️', color: 'blue-gradient' },
  { name: 'Deltix Native', desc: 'Direct staking', icon: '◆', color: 'purple-gradient' },
];

function createGradientCard(item, onClickHandler) {
  const card = document.createElement('button');
  card.className = `gradient-card ${item.color}`;
  card.type = 'button';
  card.innerHTML = `
    <div class="gradient-card-icon">${item.icon}</div>
    <div class="gradient-card-content">
      <div class="gradient-card-title">${item.name}</div>
      <div class="gradient-card-description">${item.desc}</div>
    </div>
    <div class="gradient-card-arrow">→</div>
  `;
  if (onClickHandler) {
    card.addEventListener('click', () => onClickHandler(item));
  }
  return card;
}

function renderKYCTab() {
  const validatorsGrid = $('kycValidatorsGrid');
  const networkGrid = $('networkValidatorsGrid');
  
  if (validatorsGrid) {
    validatorsGrid.innerHTML = '';
    kycData.forEach(item => {
      const card = createGradientCard(item, (item) => {
        toast(`Connecting to ${item.name}...`);
        console.log('KYC card clicked:', item);
      });
      validatorsGrid.appendChild(card);
    });
  }
  
  if (networkGrid) {
    networkGrid.innerHTML = '';
    networkValidators.forEach(item => {
      const card = createGradientCard(item, (item) => {
        toast(`Validator: ${item.name}`);
        console.log('Validator card clicked:', item);
      });
      networkGrid.appendChild(card);
    });
  }
}

// Hook into showTab to initialize card data
const originalShowTab = window.showTab;
window.showTab = function(tabId, opts) {
  originalShowTab.call(this, tabId, opts);
  if (tabId === 'tab-kyc') {
    renderKYCTab();
  }
};

// ---------- Navigation history + Android back button ----------
// Every screen the user opens is remembered, so Back walks the same path in
// reverse (Wallet → Stores → … → Wallet). Back first dismisses whatever sits on
// top (dialogs, the menu, an in-app browser page) and only then leaves the
// screen. Only from the root (Wallet) is the app sent to the background, the
// way any Android app behaves — it is never closed from a deeper screen.
const NAV_STACK_MAX = 40;
const navStack = ['tab-wallet'];
const navScroll = {};
let navCurrent = 'tab-wallet';
let navRestoring = false;

function navReset() {
  navStack.length = 0;
  navStack.push('tab-wallet');
  navCurrent = 'tab-wallet';
  Object.keys(navScroll).forEach((k) => delete navScroll[k]);
}

function navSaveScroll() {
  navScroll[navCurrent] = window.scrollY;
}

function navRecord(id) {
  if (id === navCurrent) return;
  if (!navRestoring) {
    const seen = navStack.lastIndexOf(id);
    // Returning to a screen already in the trail trims back to it (no loops).
    if (seen >= 0) navStack.length = seen + 1;
    else navStack.push(id);
    if (navStack.length > NAV_STACK_MAX) navStack.shift();
  }
  navCurrent = id;
  const y = navRestoring ? (navScroll[id] || 0) : 0;
  requestAnimationFrame(() => window.scrollTo(0, y));
}

// Collapsible bottom navigation: full grid, one compact row, or hidden.
const NAV_MODE_KEY = 'dltx_nav_mode';
const NAV_LAST_KEY = 'dltx_nav_last_visible';
const NAV_MODES = ['full', 'compact', 'hidden'];
let navMode = 'full';
let navLastVisible = 'full';
let navAnimTimer = null;

function navPrefersReducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function applyNavMode(mode, { animate = true, persist = true } = {}) {
  const bar = $('tabbar');
  const items = $('tabbarItems');
  if (!bar || !items || !NAV_MODES.includes(mode)) return;
  const prevHeight = items.offsetHeight;
  navMode = mode;
  if (mode !== 'hidden') navLastVisible = mode;
  bar.dataset.mode = mode;
  document.body.dataset.nav = mode;

  const toggle = $('navToggle');
  if (toggle) {
    const full = mode === 'full';
    toggle.setAttribute('aria-expanded', String(full));
    toggle.setAttribute('aria-label', full ? 'Switch to compact navigation' : 'Switch to full navigation');
    $('navToggleLabel').textContent = full ? 'Compact' : 'Full';
  }
  const restore = $('navRestore');
  if (restore) restore.hidden = mode !== 'hidden';
  // A hidden bar must not be reachable by keyboard or screen readers.
  bar.toggleAttribute('inert', mode === 'hidden');
  bar.setAttribute('aria-hidden', String(mode === 'hidden'));

  // Animate the height change between the full grid and the compact row.
  clearTimeout(navAnimTimer);
  items.style.height = '';
  if (animate && mode !== 'hidden' && prevHeight && !navPrefersReducedMotion()) {
    const nextHeight = items.offsetHeight;
    if (nextHeight !== prevHeight) {
      items.style.height = `${prevHeight}px`;
      void items.offsetHeight;
      items.style.height = `${nextHeight}px`;
      navAnimTimer = setTimeout(() => { items.style.height = ''; }, 320);
    }
  }
  if (persist) {
    try {
      localStorage.setItem(NAV_MODE_KEY, mode);
      localStorage.setItem(NAV_LAST_KEY, navLastVisible);
    } catch {}
  }
  syncNavSelection(navCurrent);
  updateNavMetrics();
}

// Publishes the live nav height so page content always clears the bar.
function updateNavMetrics() {
  const bar = $('tabbar');
  if (!bar) return;
  const h = navMode === 'hidden' ? 0 : Math.round(bar.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--nav-h', `${h}px`);
  const top = $('topbar');
  if (top && !top.hidden) document.documentElement.style.setProperty('--topbar-h', `${Math.round(top.getBoundingClientRect().height)}px`);
}

function syncNavSelection(id) {
  document.querySelectorAll('.tabbtn').forEach((b) => {
    if (b.dataset.tab === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const items = $('tabbarItems');
  const active = items?.querySelector(`.tabbtn[data-tab="${id}"]`);
  if (navMode === 'compact' && items && active) {
    const left = active.offsetLeft - (items.clientWidth - active.offsetWidth) / 2;
    items.scrollTo({ left: Math.max(0, left), behavior: navPrefersReducedMotion() ? 'auto' : 'smooth' });
  }
}

(function initNavigationBar() {
  const bar = $('tabbar');
  if (!bar) return;
  let saved = 'full';
  try {
    saved = localStorage.getItem(NAV_MODE_KEY) || 'full';
    const last = localStorage.getItem(NAV_LAST_KEY);
    if (last === 'full' || last === 'compact') navLastVisible = last;
  } catch {}
  applyNavMode(NAV_MODES.includes(saved) ? saved : 'full', { animate: false, persist: false });
  $('navToggle')?.addEventListener('click', () => applyNavMode(navMode === 'full' ? 'compact' : 'full'));
  $('navHide')?.addEventListener('click', () => {
    applyNavMode('hidden');
    $('navRestore')?.focus({ preventScroll: true });
  });
  $('navRestore')?.addEventListener('click', () => {
    applyNavMode(navLastVisible);
    $('navToggle')?.focus({ preventScroll: true });
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateNavMetrics).observe(bar);
  window.addEventListener('resize', updateNavMetrics);
  // The on-screen keyboard would otherwise leave the bar floating over the input.
  document.addEventListener('focusin', (e) => {
    if (e.target.matches?.('input, textarea, select')) document.body.classList.add('kbd-open');
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!document.activeElement?.matches?.('input, textarea, select')) document.body.classList.remove('kbd-open');
    }, 120);
  });
})();

// Dialogs and transient popups sit above everything, so they close first.
function closeTransientOverlay() {
  if (closeChatSheet()) return true;
  const confirmDlg = document.getElementById('confirmDialog');
  if (confirmDlg) {
    const cancel = confirmDlg.querySelector('.modal-actions .btn.ghost');
    if (cancel) cancel.click(); else confirmDlg.remove();
    return true;
  }
  const pop = document.getElementById('rewardPop');
  if (pop) { pop.querySelector('.rp-close')?.click(); return true; }
  const overlays = document.querySelectorAll('.modal-overlay');
  if (overlays.length) { overlays[overlays.length - 1].remove(); return true; }
  if (document.body.classList.contains('nav-open')) { closeSidenav(); return true; }
  return false;
}

function closeTopOverlay() {
  if (closeTransientOverlay()) return true;
  if (typeof closeScanner === 'function' && closeScanner()) return true;
  if (typeof closePredictFullChart === 'function' && closePredictFullChart()) return true;
  for (const id of ['p2pImgModal', 'p2pTraderModal', 'p2pEditModal', 'swapModal', 'dappModal', 'stakeModal', 'edDelegateModal', 'edUndelegateModal', 'sendModal', 'deleteModal', 'p2pCreateModal', 'p2pOfferModal', 'p2pOrderModal']) {
    const el = document.getElementById(id);
    if (el && !el.hidden) {
      el.hidden = true;
      if (id === 'p2pOrderModal' && typeof stopP2pChatPoll === 'function') stopP2pChatPoll();
      return true;
    }
  }
  const game = document.getElementById('gameModal');
  if (game && !game.hidden) { window.closeGame?.(); return true; }
  const instant = document.getElementById('instantModal');
  if (instant && !instant.hidden) { window.closeInstantGame?.(); return true; }
  const shop = document.getElementById('shopModal');
  if (shop && !shop.hidden) { window.closeShop?.(); return true; }
  const puzzle = document.getElementById('puzzleModal');
  if (puzzle && !puzzle.hidden) { window.closePuzzle?.(); return true; }
  if (!$('dappPage').hidden) { closeDappPage(); return true; }
  if (!$('explorer').hidden) {
    if (exp.stack.length > 1) { exp.stack.pop(); expRender(); } else closeExplorer();
    return true;
  }
  if (!$('dbrowser').hidden) {
    if (dbState.index > 0) goDbBack(); else closeDBrowser();
    return true;
  }
  // Any other open dialog (avatar picker, …) closes before the screen does.
  const openModals = [...document.querySelectorAll('.modal-backdrop:not([hidden])')].filter((el) => el.id !== 'updateGate');
  if (openModals.length) { openModals[openModals.length - 1].hidden = true; return true; }
  return false;
}

// One entry point for every Back gesture/button. Returns true when it handled
// the press; false means the app is already at its root.
function handleBack() {
  if (closeTopOverlay()) return true;
  // Inside a group, Back goes to the chat list first (the global chat keeps going straight to the previous screen).
  if (typeof chatLive === 'function' && chatLive() && chatIsGroup()) { chatShowList(); return true; }
  if (!$('screen-main')?.classList.contains('active')) {
    if ($('screen-otp')?.classList.contains('active')) { $('backToEmail')?.click(); return true; }
    return false;
  }
  if (navStack.length > 1) {
    navStack.pop();
    navRestoring = true;
    try { showTab(navStack[navStack.length - 1]); } finally { navRestoring = false; }
    return true;
  }
  return false;
}

function leaveApp() {
  const appPlugin = window.Capacitor?.Plugins?.App;
  if (appPlugin?.minimizeApp) appPlugin.minimizeApp();
  else appPlugin?.exitApp?.();
}

if (isNativeApp()) {
  // Android hardware button, back gesture and predictive back all arrive here.
  try {
    window.Capacitor?.Plugins?.App?.addListener('backButton', () => { if (!handleBack()) leaveApp(); });
  } catch (e) { console.warn('Back button listener unavailable:', e); }
} else {
  // Browser: one guard entry absorbs Back so it can be handled in-app first.
  const BACK_SENTINEL = { deltix: true };
  history.replaceState(BACK_SENTINEL, '');
  history.pushState(BACK_SENTINEL, '');
  window.addEventListener('popstate', () => {
    if (handleBack()) history.pushState(BACK_SENTINEL, '');
  });
}

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
        populateNewPages();
        return;
      }
    }
  }
  showScreen('screen-email');
})();

// ===== POPULATE NEW PAGES WITH CONTENT =====
function populateNewPages() {
  populateSocialMediaPage();
  populateBookingPage();
  populateStoresPage();
  startWalletTimer();
}

function populateSocialMediaPage() {
  // X Accounts with Follow & Earn Feature
  const xAccounts = [
    { handle: '@DigitalGold1979', username: 'DigitalGold1979', desc: 'Official Main Account', verified: true },
    { handle: '@Deltix_Official', username: 'Deltix_Official', desc: 'Community Updates', verified: true },
    { handle: '@Crypmatrx', username: 'Crypmatrx', desc: 'Crypto News & Insights', verified: false },
    { handle: '@Queen_Anet', username: 'Queen_Anet', desc: 'Team & Leadership', verified: false },
  ];
  
  const xGrid = $('officialSocialGrid');
  if (xGrid) {
    xGrid.innerHTML = xAccounts.map(x => `
      <div class="social-x-card">
        <div class="x-header">
          <div class="x-logo">𝕏</div>
          <div class="x-info">
            <div class="x-handle">${x.handle}</div>
            <div class="x-desc">${x.desc}</div>
          </div>
          ${x.verified ? '<div class="x-verified">✓</div>' : ''}
        </div>
        <div class="social-actions">
          <button class="btn-social btn-visit" onclick="openXAccount('${x.username}')">Visit</button>
          <button class="btn-social btn-follow" data-handle="${x.username}" onclick="followXAccount('${x.username}', '${x.handle}')">Follow & Earn</button>
        </div>
      </div>
    `).join('');
    paintFollowButtons();
    loadFollowState();
  }
  
  // KYC, ChatRoom, News Action Buttons
  const actionButtons = [
    { icon: '🛂', title: 'KYC', desc: 'Verify Identity', action: 'openKYC', color: 'kyc' },
    { icon: '💬', title: 'ChatRoom', desc: 'Live Discussion', action: 'openChat', color: 'chat' },
    { icon: '📰', title: 'News', desc: 'Latest Updates', action: 'openNews', color: 'news' },
  ];
  
  const actionGrid = $('socialActionGrid');
  if (actionGrid) {
    actionGrid.innerHTML = actionButtons.map(a => `
      <button class="action-card action-${a.color}" onclick="${a.action}()">
        <div class="action-icon">${a.icon}</div>
        <div class="action-title">${a.title}</div>
        <div class="action-desc">${a.desc}</div>
      </button>
    `).join('');
  }
  
  // Community Platforms with Direct App Links
  const communitySocial = [
    { name: 'Discord', icon: '🔵', desc: 'Community Chat', action: 'openDiscord', active: true },
    { name: 'Telegram', icon: '✈️', desc: 'Official Channel', action: 'openTelegram', active: true },
    { name: 'WhatsApp', icon: '💬', desc: 'Message Us', action: 'openWhatsApp', active: true },
    { name: 'YouTube', icon: '📺', desc: '@DigitalGold22', action: 'openYouTube', active: true },
    { name: 'Instagram', icon: '📷', desc: '@anet_deltix', action: 'openInstagram', active: true },
  ];
  
  const communityGrid = $('communitySocialGrid');
  if (communityGrid) {
    communityGrid.innerHTML = communitySocial.map(s => `
      <button class="social-platform-card ${s.active ? 'active' : 'coming-soon'}" 
              title="${s.name}" 
              onclick="${s.active && s.action ? s.action + '()' : 'return false;'}"
              ${!s.active ? 'disabled' : ''}>
        <div class="platform-icon">${s.icon}</div>
        <div class="platform-name">${s.name}</div>
        <div class="platform-desc">${s.desc}</div>
      </button>
    `).join('');
  }
}

// ---------- Official links ----------
// External links are always plain https URLs. In the native app Capacitor hands
// them to Android, which opens the matching app (X, WhatsApp, Discord, Telegram)
// when it is installed and the default browser otherwise.
const OFFICIAL_LINKS = {
  discord: 'https://discord.com/invite/xw8k3cgREy',
  whatsapp: 'https://wa.me/19253007638',
  telegram: 'https://t.me/A_Network_Community',
  youtube: 'https://www.youtube.com/@DigitalGold22',
  instagram: 'https://www.instagram.com/anet_deltix',
  xProfile: (username) => `https://x.com/${username}`,
};

function isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.();
}

function openExternalLink(url) {
  let target;
  try { target = new URL(url); } catch { return false; }
  if (target.protocol !== 'https:') return false;
  if (isNativeApp()) window.location.href = target.href;
  else window.open(target.href, '_blank', 'noopener');
  return true;
}

// Open X Account - X app when installed, browser otherwise
function openXAccount(username) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(String(username))) return;
  openExternalLink(OFFICIAL_LINKS.xProfile(username));
}

// ---------- Follow & Earn (the server decides; nothing is stored on the device) ----------
// The reward is 10 Energy, once per account per official X account. Deltix cannot see X's
// follower lists, so it trusts the member's word and cannot take the reward back on an unfollow.
const followState = { reward: 10, claimed: {}, busy: false };
try { localStorage.removeItem('userEnergy'); } catch {}   // the old, fake on-device counter

async function loadFollowState() {
  if (!state.token) return;
  try {
    const r = await api('GET', '/energy/social', null, { retries: 0 });
    followState.reward = Number(r.reward) || 10;
    followState.claimed = {};
    for (const a of r.accounts || []) followState.claimed[String(a.handle).toLowerCase()] = !!a.claimed;
    paintFollowButtons();
  } catch { /* older backend or offline — buttons stay as they are */ }
}
function paintFollowButtons() {
  document.querySelectorAll('.btn-follow[data-handle]').forEach((btn) => {
    const done = !!followState.claimed[btn.dataset.handle.toLowerCase()];
    btn.disabled = done;
    btn.classList.toggle('claimed', done);
    btn.textContent = done ? '✓ Claimed' : 'Follow & Earn';
  });
}

// Follow X Account & Earn 10 Energy Program
function followXAccount(username, handle) {
  if (followState.claimed[String(username).toLowerCase()]) { toast(`You already received the reward for ${handle}.`, { tone: 'info' }); return; }
  document.querySelectorAll('.follow-modal').forEach((m) => m.closest('.modal-overlay')?.remove());

  // Show dialog
  const dialog = document.createElement('div');
  dialog.className = 'modal-overlay';
  dialog.innerHTML = `
    <div class="modal-content follow-modal">
      <div class="modal-header">
        <h2>Follow & Earn</h2>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">✕</button>
      </div>
      <div class="modal-body">
        <div class="follow-icon">𝕏</div>
        <p>Visit <strong>${handle}</strong> on X</p>
        <p class="follow-desc">Follow the account to earn ${followState.reward} Energy — paid once per account</p>
        
        <div class="follow-reward">
          <span class="reward-icon">⚡</span>
          <span class="reward-text">+${followState.reward} Energy</span>
        </div>
        
        <div class="follow-steps">
          <div class="step">
            <div class="step-num">1</div>
            <div class="step-text">Click "Open X App" button below</div>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <div class="step-text">Follow ${handle} on X</div>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <div class="step-text">Return to app and claim reward</div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn primary" onclick="claimFollowReward('${username}', '${handle}', this.closest('.modal-overlay'))">Open X App & Follow</button>
        <button class="btn ghost" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialog);
}

// Opens X, then offers the claim. The server decides everything: the amount (10), which X
// accounts count, and that each is paid once per account.
function claimFollowReward(username, handle, modalElement) {
  openXAccount(username);
  const footer = modalElement && modalElement.querySelector('.modal-footer');
  if (!footer) return;
  footer.innerHTML = `
    <button class="btn primary" id="followClaimBtn" type="button" disabled>I followed — claim ⚡ ${followState.reward}</button>
    <button class="btn ghost" type="button" data-close>Cancel</button>`;
  footer.querySelector('[data-close]').addEventListener('click', () => modalElement.remove());
  const btn = footer.querySelector('#followClaimBtn');
  btn.addEventListener('click', () => submitFollowClaim(username, handle, modalElement, btn));
  // A short pause so the claim is not fired before the member has even reached X.
  let left = 8;
  const label = btn.textContent;
  btn.textContent = `Claim available in ${left}s`;
  const timer = setInterval(() => {
    if (!document.body.contains(modalElement)) { clearInterval(timer); return; }
    left -= 1;
    if (left <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = label; } else btn.textContent = `Claim available in ${left}s`;
  }, 1000);
}

async function submitFollowClaim(username, handle, modalElement, btn) {
  if (followState.busy) return;
  followState.busy = true;
  btn.disabled = true;
  try {
    const r = await api('POST', '/energy/social/follow', { handle: username }, { retries: 0 });
    state.energy = r;                      // the server returns the full, authoritative Energy snapshot
    renderEnergy();
    followState.claimed[username.toLowerCase()] = true;
    paintFollowButtons();
    modalElement.remove();
    celebrate({ amount: r.awarded, unit: 'Energy', icon: '⚡', title: 'Follow reward!', subtitle: `${handle} · you now have ${fmt(r.energy)} ⚡ total.`, duration: 2600 });
  } catch (e) {
    if (e.data && e.data.code === 'FOLLOW_ALREADY_CLAIMED') {
      followState.claimed[username.toLowerCase()] = true;
      if (typeof e.data.energy === 'number') { state.energy = e.data; renderEnergy(); }
      paintFollowButtons();
      modalElement.remove();
      toast(`You already received the reward for ${handle}.`, { tone: 'info' });
    } else {
      btn.disabled = false;
      toast(e.status === 404 ? 'Follow rewards are not available yet — please try again later.' : (e.message || 'Could not claim the reward. Please try again.'), { tone: 'error' });
    }
  } finally {
    followState.busy = false;
  }
}

// Action buttons - Open Social Apps Directly
function openKYC() {
  alert('KYC Verification - Coming Soon\n\nVerify your identity to unlock premium features.');
}

// Discord - Discord app when installed, browser otherwise
function openDiscord() {
  openExternalLink(OFFICIAL_LINKS.discord);
}

// Telegram - Telegram app when installed, browser otherwise
function openTelegram() {
  openExternalLink(OFFICIAL_LINKS.telegram);
}

// WhatsApp - official Deltix contact, +1 (925) 300-7638
function openWhatsApp() {
  openExternalLink(OFFICIAL_LINKS.whatsapp);
}

// YouTube - the YouTube app when installed, browser otherwise
function openYouTube() {
  openExternalLink(OFFICIAL_LINKS.youtube);
}

// Instagram - straight to the profile: the Instagram app when installed, browser otherwise
function openInstagram() {
  openExternalLink(OFFICIAL_LINKS.instagram);
}

function openChat() {
  showTab('tab-chatroom');
  renderGlobalChatroom();
}

function openNews() {
  alert('Latest News & Updates\n\nVisit our X accounts for the latest Deltix Network news!');
}

// Global ChatRoom
// The server is authoritative for Energy and for the per-message cost; the
// client only mirrors what it reports and never assumes "no energy" when the
// service itself is unreachable. (State lives next to `state`, near the top.)

// ----- helpers -----
const CHAT_RANK = { user: 0, moderator: 1, admin: 2 };
const CHAT_GROUP_RANK = { user: 0, admin: 1, owner: 2 };   // inside a group: members < admins < the owner
const chatIsGroup = () => globalChatState.room.type === 'group';
const chatRoomKey = () => (chatIsGroup() ? `g${globalChatState.room.id}` : 'global');
const chatRoomBase = () => (chatIsGroup() ? `/groups/${globalChatState.room.id}` : '/globalchat');
const chatRankOf = (role) => (chatIsGroup() ? CHAT_GROUP_RANK : CHAT_RANK)[role] || 0;
const CHAT_GROUP_GAP_MS = 5 * 60 * 1000;
const CHAT_MAX_LEN = 500;
// Low-end phones and slow links keep a shorter list on screen and skip decorative effects.
const CHAT_LITE = (() => {
  try {
    const c = navigator.connection || {};
    return (navigator.deviceMemory && navigator.deviceMemory <= 2) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2)
      || c.saveData === true || /(^|-)2g$/.test(c.effectiveType || '');
  } catch { return false; }
})();
if (CHAT_LITE) document.documentElement.classList.add('lite');
const CHAT_DOM_MAX = CHAT_LITE ? 150 : 400;

const chatSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chatReducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const chatTabActive = () => !!document.getElementById('tab-chatroom')?.classList.contains('active') && !!$('screen-main')?.classList.contains('active');
// A conversation (not the chat list) is on screen and should be kept live.
const chatLive = () => chatTabActive() && !globalChatState.listOpen;

function chatTime(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function chatDayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function chatDayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (chatDayKey(d) === chatDayKey(today)) return 'Today';
  if (chatDayKey(d) === chatDayKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
function chatHue(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
const chatSnippet = (t, n = 90) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
function chatHaptic() {
  try { navigator.vibrate?.(8); } catch {}
  try { window.Capacitor?.Plugins?.Haptics?.impact?.({ style: 'Light' }); } catch {}
}
const chatList = () => [...globalChatState.messages, ...globalChatState.pending];
const chatFind = (id) => chatList().find((m) => String(m.id) === String(id)) || null;
const chatNearBottom = (c, slack = 120) => c.scrollHeight - c.scrollTop - c.clientHeight < slack;

function chatScrollToBottom(smooth = false) {
  const c = $('chatMessages');
  if (!c) return;
  c.scrollTo({ top: c.scrollHeight, behavior: smooth && !chatReducedMotion() ? 'smooth' : 'auto' });
}

// ----- drafts & scroll position survive leaving the tab -----
const CHAT_DRAFT_KEY = 'dltx_chat_draft';
function chatDraftOwner() { return String(state.email || '').toLowerCase(); }
function chatSaveDraft() {
  const input = $('chatInput');
  const owner = chatDraftOwner();
  if (!input || !owner) return;
  try {
    // One draft per conversation (the global chat and each group keep their own text).
    let store = JSON.parse(localStorage.getItem(CHAT_DRAFT_KEY) || 'null');
    if (!store || store.o !== owner || typeof store.d !== 'object' || !store.d) store = { o: owner, d: {} };
    const key = chatRoomKey();
    if (input.value.trim()) store.d[key] = input.value.slice(0, CHAT_MAX_LEN); else delete store.d[key];
    if (Object.keys(store.d).length) localStorage.setItem(CHAT_DRAFT_KEY, JSON.stringify(store));
    else localStorage.removeItem(CHAT_DRAFT_KEY);
  } catch {}
}
function chatRestoreDraft() {
  const input = $('chatInput');
  if (!input || input.value) return;
  try {
    const d = JSON.parse(localStorage.getItem(CHAT_DRAFT_KEY) || 'null');
    const text = d && d.o === chatDraftOwner() && d.d ? d.d[chatRoomKey()] : null;
    if (typeof text === 'string') { input.value = text; chatAutosize(); }
  } catch {}
}
let chatDraftTimer = null;
function chatQueueDraftSave() { clearTimeout(chatDraftTimer); chatDraftTimer = setTimeout(chatSaveDraft, 400); }

// Must run before the tab is hidden: a display:none element reports scrollTop 0.
function chatSaveView() {
  // showTab() runs during boot, before the rest of the chat code exists — look at the DOM only.
  if (!document.getElementById('tab-chatroom')?.classList.contains('active')) return;
  const c = $('chatMessages');
  if (!c) return;
  globalChatState.view = { top: c.scrollTop, stick: chatNearBottom(c, 160) };
  clearTimeout(chatDraftTimer);
  chatSaveDraft();
}
function chatRestoreView() {
  const c = $('chatMessages');
  const v = globalChatState.view;
  if (!c) return;
  if (v && !v.stick) { c.scrollTop = v.top; globalChatState.stick = false; chatUpdateJump(); }
  else chatScrollToBottom(false);
}

function chatRoleBadge(role) {
  if (role === 'owner') return '<span class="chat-role owner">OWNER</span>';
  if (role === 'admin') return '<span class="chat-role admin">ADMIN</span>';
  if (role === 'moderator') return '<span class="chat-role mod">MOD</span>';
  return '';
}

function chatQuoteHtml(r) {
  const body = r.text ? escapeHtml(chatSnippet(r.text)) : '<i>Deleted message</i>';
  return `<div class="chat-quote" data-goto="${Number(r.id)}" style="--nh:${chatHue(r.uid || r.name)}"><b>${escapeHtml(r.name || 'Message')}</b><span>${body}</span></div>`;
}

function chatSameGroup(a, b) {
  if (!a || !b) return false;
  const sameSender = a.mine === b.mine && (a.mine || (a.uid || a.name) === (b.uid || b.name));
  return sameSender && chatDayKey(a.ts) === chatDayKey(b.ts) && Math.abs(new Date(b.ts) - new Date(a.ts)) < CHAT_GROUP_GAP_MS;
}

const chatIsOnline = (uid) => !!uid && globalChatState.presence.seen[uid] === 'o';

function chatBubbleHtml(m, { first, last }) {
  const mine = !!m.mine;
  const tick = m.failed ? '<span class="chat-tick err" title="Not sent — tap to retry">!</span>' : m.pending ? '<span class="chat-tick wait">⏳</span>' : mine ? '<span class="chat-tick">✓</span>' : '';
  const showAuthor = first && (!mine || (m.role && m.role !== 'user'));
  const hue = chatHue(m.uid || m.name);
  const author = showAuthor
    ? `<div class="chat-author">${mine ? '' : `<span class="chat-name" role="button" tabindex="0" data-uid="${escapeHtml(m.uid || '')}" style="--nh:${hue}">${escapeHtml(m.name || 'Member')}</span>`}${chatRoleBadge(m.role)}</div>`
    : '';
  return `
    <div class="chat-message ${mine ? 'mine' : ''} ${first ? 'grp-first' : ''} ${last ? 'grp-last' : ''} ${m.pending ? 'pending' : ''} ${m.failed ? 'failed' : ''}" data-id="${escapeHtml(String(m.id))}">
      ${mine ? '' : `<span class="chat-avatar ${last ? '' : 'ghost'} ${chatIsOnline(m.uid) ? 'online' : ''}" role="button" aria-label="View ${escapeHtml(m.name || 'member')}’s profile" data-uid="${escapeHtml(m.uid || '')}">${escapeHtml(m.avatar || '🦊')}</span>`}
      <div class="chat-bubble" tabindex="0" role="button" aria-label="Message from ${escapeHtml(m.name || 'member')}. Open actions">
        ${author}
        ${m.reply ? chatQuoteHtml(m.reply) : ''}
        <div class="chat-text">${escapeHtml(m.text)}</div>
        <div class="chat-meta"><span class="chat-time">${chatTime(m.ts)}</span>${tick}</div>
      </div>
    </div>`;
}

// Presence changes arrive with every sync; only the little green dots are touched.
function chatPaintPresence() {
  const c = $('chatMessages');
  if (!c) return;
  c.querySelectorAll('.chat-avatar[data-uid]').forEach((el) => el.classList.toggle('online', chatIsOnline(el.dataset.uid)));
}

function chatEmptyHtml() {
  const g = globalChatState;
  if (!g.loaded) return '<p class="chat-hint">Loading messages…</p>';
  if (!g.available) {
    return `<div class="chat-empty"><div class="chat-empty-icon">💬</div><b>Chat is temporarily unavailable</b>
      <p>We couldn’t reach the chat service. Your Energy has not been used.</p>
      <button class="btn ghost chat-retry" type="button" id="chatRetryBtn">Try again</button></div>`;
  }
  return '<div class="chat-empty"><div class="chat-empty-icon">👋</div><b>No messages yet</b><p>Be the first to say hello!</p></div>';
}

// Full repaint — used on (re)sync and when something other than a plain append changed.
function chatRenderAll({ stick = false } = {}) {
  const c = $('chatMessages');
  if (!c) return;
  const g = globalChatState;
  const list = chatList();
  const wasNear = chatNearBottom(c, 160);
  if (!list.length) {
    c.innerHTML = chatEmptyHtml();
    $('chatRetryBtn')?.addEventListener('click', () => { g.failures = 0; chatStart(); });
    return;
  }
  let html = '';
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const prev = list[i - 1];
    const next = list[i + 1];
    if (!prev || chatDayKey(prev.ts) !== chatDayKey(m.ts)) html += `<div class="chat-day"><span>${chatDayLabel(m.ts)}</span></div>`;
    html += chatBubbleHtml(m, { first: !chatSameGroup(prev, m), last: !chatSameGroup(m, next) });
  }
  c.innerHTML = html;
  if (stick || wasNear) chatScrollToBottom(false);
}

// Fast path for the common case: one new message at the end.
function chatAppend(m) {
  const c = $('chatMessages');
  if (!c) return;
  const g = globalChatState;
  const list = chatList();
  if (list.length < 2 || !c.querySelector('.chat-message')) return chatRenderAll({ stick: true });
  const prev = list[list.length - 2];
  const grouped = chatSameGroup(prev, m);
  if (grouped) {
    const prevEl = c.querySelector(`.chat-message[data-id="${CSS.escape(String(prev.id))}"]`);
    prevEl?.classList.remove('grp-last');
    prevEl?.querySelector('.chat-avatar')?.classList.add('ghost');
  }
  let html = '';
  if (chatDayKey(prev.ts) !== chatDayKey(m.ts)) html += `<div class="chat-day"><span>${chatDayLabel(m.ts)}</span></div>`;
  html += chatBubbleHtml(m, { first: !grouped, last: true });
  c.insertAdjacentHTML('beforeend', html);
  c.querySelector('.chat-hint, .chat-empty')?.remove();
  void g;
}

function chatUpdateHeader() {
  const g = globalChatState;
  const grp = chatIsGroup();
  const title = $('chatTitle');
  if (title) title.textContent = grp ? ((g.group && g.group.title) || g.room.title || 'Group') : 'Deltix Global Chat';
  const icon = $('chatHeadIcon');
  if (icon) icon.textContent = grp ? '👥' : '💬';
  $('chatHeadMain')?.classList.toggle('tappable', grp);
  const status = $('chatStatus');
  if (status) {
    const online = g.presence.online > 0 ? ` · ${g.presence.online.toLocaleString()} online` : '';
    const roleText = !g.me ? '' : grp
      ? (g.me.role === 'owner' ? ' · you own this group' : g.me.role === 'admin' ? ' · you are an admin' : '')
      : (g.me.role !== 'user' ? ` · you are ${g.me.role === 'admin' ? 'an admin' : 'a moderator'}` : '');
    const members = grp && g.group ? `${g.group.memberCount.toLocaleString()} member${g.group.memberCount === 1 ? '' : 's'}` : 'Live';
    status.textContent = !g.loaded ? 'Connecting…' : g.failures ? 'Reconnecting…' : `${members}${online}${roleText}`;
    status.classList.toggle('live', g.loaded && !g.failures);
    status.classList.toggle('off', !!g.failures);
  }
  const chip = $('chatEnergyChip');
  if (chip) chip.textContent = g.me ? `⚡ ${Number(g.me.energy).toLocaleString()}` : '⚡ —';
  const listChip = $('chatListEnergy');
  if (listChip) listChip.textContent = g.me ? `⚡ ${Number(g.me.energy).toLocaleString()}` : '⚡ —';
  const av = $('chatMyAvatar');
  if (av) av.textContent = state.avatar || '🦊';
}

function chatUpdatePinBar() {
  const g = globalChatState;
  const bar = $('chatPinBar');
  if (!bar) return;
  bar.hidden = !g.pinned;
  if (g.pinned) {
    $('chatPinName').textContent = `Pinned · ${g.pinned.name || 'message'}`;
    $('chatPinText').textContent = chatSnippet(g.pinned.text, 80);
    bar.dataset.goto = g.pinned.id;
  }
}

// The composer mirrors the server's verdict: it is disabled only for a concrete reason.
function chatUpdateComposer() {
  const g = globalChatState;
  const input = $('chatInput');
  const sendBtn = $('chatSendBtn');
  const note = $('chatEnergyNote');
  const box = $('chatComposer');
  if (!input || !sendBtn || !note || !box) return;

  const me = g.me;
  const mute = me && me.mute;
  const noEnergy = !!me && !mute && me.canChat === false;
  const offline = !g.available && !g.messages.length;
  const blocked = !!mute || noEnergy || offline;
  box.classList.toggle('blocked', blocked);
  // Without Energy a member can still type (their draft is kept) — only sending waits.
  input.disabled = !!mute || offline;
  input.placeholder = mute ? 'You are muted' : offline ? 'Chat is unavailable right now' : noEnergy ? 'Write a message (needs Energy to send)' : (g.replyTo ? 'Write a reply…' : 'Message');
  sendBtn.disabled = blocked || !input.value.trim();

  const cost = me ? me.cost : 1;
  const banner = $('chatEnergyBanner');
  if (banner) {
    banner.hidden = !noEnergy;
    if (noEnergy) {
      const need = Math.max(0, cost - me.energy);
      $('chatBannerText').innerHTML = `⚡ A message costs <b>${cost} Energy</b> and you have <b>${me.energy}</b>${need ? ` — <b>${need} more</b> needed` : ''}.`;
      const ad = $('chatBannerAd');
      const offerable = adsOfferable();
      ad.disabled = !offerable || g.adBusy;
      ad.textContent = g.adBusy ? 'Loading ad…' : offerable ? '▶ Watch an ad' : 'Ads unavailable';
    }
  }
  if (mute) {
    const until = mute.permanent ? '' : ` until ${new Date(mute.until).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}`;
    note.innerHTML = `🔇 You are muted${escapeHtml(until)}.${mute.reason ? ` Reason: ${escapeHtml(mute.reason)}.` : ''}`;
  } else if (offline) {
    note.textContent = '⚠️ Chat is temporarily unavailable. Please try again shortly.';
  } else {
    note.innerHTML = `⚡ <b>${me ? me.energy : '—'}</b> Energy · <b>${cost}</b> per message`;
  }
  const len = input.value.length;
  if (len > CHAT_MAX_LEN - 80 && !blocked) note.innerHTML += ` · <span class="${len >= CHAT_MAX_LEN ? 'over' : ''}">${len}/${CHAT_MAX_LEN}</span>`;
}

// Energy changes anywhere in the app (an ad, the shop, a game) are mirrored into the chat at once.
function chatOnEnergyChanged() {
  const g = globalChatState;
  const energy = state.energy && typeof state.energy.energy === 'number' ? state.energy.energy : null;
  if (!g.me || energy == null) return;
  g.me.energy = energy;
  g.me.needed = Math.max(0, g.me.cost - energy);
  g.me.canChat = energy >= g.me.cost && !g.me.mute;
  if (chatTabActive()) { chatUpdateHeader(); chatUpdateComposer(); }
}

// "Watch an ad" from the out-of-Energy banner.
async function chatWatchAd() {
  const g = globalChatState;
  if (g.adBusy) return;
  g.adBusy = true;
  chatUpdateComposer();
  try {
    await earnEnergy(null);
  } finally {
    g.adBusy = false;
    chatNudge();              // pull the server's view straight away
    chatOnEnergyChanged();
    chatUpdateComposer();
  }
}

function chatAutosize() {
  const input = $('chatInput');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
}

// ----- reply -----
function chatStartReply(id) {
  const m = chatFind(id);
  if (!m || m.pending) return;
  const g = globalChatState;
  g.replyTo = { id: m.id, name: m.mine ? 'You' : m.name, text: m.text };
  $('chatReplyName').textContent = g.replyTo.name;
  $('chatReplyText').textContent = chatSnippet(m.text, 100);
  $('chatReplyBar').hidden = false;
  chatUpdateComposer();
  $('chatInput')?.focus();
}
function chatCancelReply() {
  globalChatState.replyTo = null;
  const bar = $('chatReplyBar');
  if (bar) bar.hidden = true;
  chatUpdateComposer();
}

function chatGoTo(id) {
  const c = $('chatMessages');
  const el = c?.querySelector(`.chat-message[data-id="${CSS.escape(String(id))}"]`);
  if (!el) { toast('That message is further back in the history.', { tone: 'info' }); return; }
  el.scrollIntoView({ block: 'center', behavior: chatReducedMotion() ? 'auto' : 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

// ----- action sheet (tap / long-press a message) -----
function closeChatSheet() {
  const s = document.getElementById('chatSheet');
  if (!s) return false;
  s.remove();
  return true;
}

function chatOpenSheet(id) {
  const m = chatFind(id);
  const g = globalChatState;
  if (!m) return;
  if (m.failed) { chatDeliver(m); return; }
  closeChatSheet();
  chatHaptic();
  const me = g.me || { role: 'user' };
  const grp = chatIsGroup();
  const staffRank = chatRankOf(me.role);
  const targetRank = chatRankOf(m.role);
  // Global chat: admins > moderators > members. Group: the owner > admins > members.
  const can = grp ? {
    reply: !m.pending,
    copy: true,
    delete: !m.pending && (m.mine || (staffRank >= 1 && staffRank >= targetRank && m.role !== 'owner')),
    mute: !m.pending && !m.mine && staffRank >= 1 && staffRank > targetRank,
    kick: !m.pending && !m.mine && staffRank >= 1 && staffRank > targetRank,
    pin: !m.pending && staffRank >= 1,
    promote: !m.pending && me.role === 'owner' && !m.mine && m.role !== 'owner',
  } : {
    reply: !m.pending,
    copy: true,
    delete: !m.pending && (m.mine || me.role === 'admin' || (me.role === 'moderator' && m.role === 'user')),
    mute: !m.pending && !m.mine && staffRank > targetRank,
    kick: false,
    pin: !m.pending && me.role === 'admin',
    promote: !m.pending && me.role === 'admin' && !m.mine && m.role !== 'admin',
  };
  const pinned = g.pinned && String(g.pinned.id) === String(m.id);

  const wrap = document.createElement('div');
  wrap.className = 'chat-sheet-wrap';
  wrap.id = 'chatSheet';
  const render = (view) => {
    const rows = view === 'mute'
      ? [['back', '‹', 'Back'], ['mute:10', '🔇', 'Mute 10 minutes'], ['mute:60', '🔇', 'Mute 1 hour'], ['mute:1440', '🔇', 'Mute 24 hours'], ['mute:10080', '🔇', 'Mute 7 days'], ['mute:perm', '⛔', 'Mute permanently', 'danger']]
      : [
        can.reply && ['reply', '↩', 'Reply'],
        !m.mine && !m.pending && m.uid && ['profile', '👤', 'View profile'],
        grp && !m.mine && !m.pending && ['report', '🚩', 'Report message'],
        can.copy && ['copy', '⧉', 'Copy text'],
        can.pin && ['pin', '📌', pinned ? 'Unpin message' : 'Pin message'],
        can.delete && ['delete', '🗑', 'Delete', 'danger'],
        can.mute && (g.muted.includes(m.uid) ? ['unmute', '🔊', 'Unmute member'] : ['mute', '🔇', 'Mute member…']),
        can.kick && ['kick', '🚪', 'Remove from group'],
        can.kick && ['ban', '⛔', 'Remove & ban', 'danger'],
        can.promote && ['role', '🛡', grp ? (m.role === 'admin' ? 'Remove admin' : 'Make admin') : (m.role === 'moderator' ? 'Remove moderator' : 'Make moderator')],
      ].filter(Boolean);
    wrap.innerHTML = `
      <div class="chat-sheet-dim" data-act="close"></div>
      <div class="chat-sheet" role="dialog" aria-modal="true" aria-label="Message actions">
        <div class="chat-sheet-grip" aria-hidden="true"></div>
        <div class="chat-sheet-preview" style="--nh:${chatHue(m.uid || m.name)}"><b>${escapeHtml(m.mine ? 'You' : (m.name || 'Member'))} ${chatRoleBadge(m.role)}</b><span>${escapeHtml(chatSnippet(m.text, 110))}</span></div>
        <div class="chat-sheet-list">
          ${rows.map(([act, ico, label, tone]) => `<button type="button" class="chat-act ${tone || ''}" data-act="${act}"><span class="chat-act-ico" aria-hidden="true">${ico}</span><span>${label}</span></button>`).join('')}
        </div>
      </div>`;
  };
  render('main');
  document.body.appendChild(wrap);
  wrap.querySelector('.chat-act')?.focus();

  wrap.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'close') return closeChatSheet();
    if (act === 'mute') return render('mute');
    if (act === 'back') return render('main');
    closeChatSheet();
    try {
      if (act === 'reply') chatStartReply(m.id);
      else if (act === 'profile') chatOpenMember(m.uid);
      else if (act === 'report') {
        await api('POST', `${chatRoomBase()}/report`, { messageId: m.id, reason: 'Reported from the app' });
        toast('Thanks — the Deltix team will review it.', { tone: 'success' });
      }
      else if (act === 'copy') await chatCopy(m.text);
      else if (act === 'delete') {
        const ok = await askConfirm({ title: 'Delete this message?', message: m.mine ? 'It will be removed for everyone.' : 'It will be removed for everyone. This is logged.', confirmText: 'Delete', danger: true });
        if (ok) { await api('DELETE', `${chatRoomBase()}/messages/${m.id}`); chatRemoveLocal(m.id); toast('Message deleted', { tone: 'success' }); }
      } else if (act === 'pin') {
        await api('POST', `${chatRoomBase()}/messages/${m.id}/pin`, { pinned: !pinned });
        toast(pinned ? 'Message unpinned' : 'Message pinned', { tone: 'success' });
        chatNudge();
      } else if (act.startsWith('mute:')) {
        const arg = act.slice(5);
        await api('POST', grp ? `${chatRoomBase()}/members/${m.uid}/mute` : `/globalchat/messages/${m.id}/mute`, arg === 'perm' ? { permanent: true } : { minutes: Number(arg) });
        toast('Member muted', { tone: 'success' });
        chatNudge();
      } else if (act === 'unmute') {
        await api('POST', grp ? `${chatRoomBase()}/members/${m.uid}/unmute` : `/globalchat/messages/${m.id}/unmute`);
        toast('Member unmuted', { tone: 'success' });
        chatNudge();
      } else if (act === 'kick' || act === 'ban') {
        const ok = await askConfirm({ title: act === 'ban' ? 'Remove and ban this member?' : 'Remove this member?', message: act === 'ban' ? 'They will not be able to rejoin, even with the invite link.' : 'They can join again with the invite link.', confirmText: act === 'ban' ? 'Remove & ban' : 'Remove', danger: true });
        if (ok) { await api('POST', `${chatRoomBase()}/members/${m.uid}/kick`, { ban: act === 'ban' }); toast(act === 'ban' ? 'Member banned' : 'Member removed', { tone: 'success' }); chatNudge(); }
      } else if (act === 'role') {
        if (grp) {
          await api('POST', `${chatRoomBase()}/members/${m.uid}/role`, { role: m.role === 'admin' ? 'member' : 'admin' });
          toast(m.role === 'admin' ? 'Admin removed' : 'Admin added', { tone: 'success' });
        } else {
          await api('POST', `/globalchat/messages/${m.id}/role`, { role: m.role === 'moderator' ? 'user' : 'moderator' });
          toast(m.role === 'moderator' ? 'Moderator removed' : 'Moderator added', { tone: 'success' });
        }
        chatNudge();
      }
    } catch (err) {
      toast(err.message || 'Action failed', { tone: 'error' });
    }
  });
}

async function chatCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement('textarea');
    t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch {}
    t.remove();
  }
  toast('Copied', { tone: 'success' });
}

// Forces an immediate resync so the result of an action shows at once.
function chatNudge() { if (chatLive()) chatStart(); }

// ----- member card (tap a name or avatar) -----
function chatAgo(ms) {
  const diff = Math.max(0, Date.now() - Number(ms));
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'yesterday' : days < 7 ? `${days} days ago` : new Date(Number(ms)).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
// 'o' online · 'h' hidden by the member · epoch-ms last seen · null never seen.
function chatStatusText(st) {
  if (st === 'o') return 'online';
  if (st === 'h') return 'last seen recently';
  if (typeof st === 'number') return `last seen ${chatAgo(st)}`;
  return 'offline';
}

async function chatOpenMember(uid) {
  if (!uid) return;
  closeChatSheet();
  const g = globalChatState;
  const wrap = document.createElement('div');
  wrap.className = 'chat-sheet-wrap';
  wrap.id = 'chatSheet';
  wrap.innerHTML = `<div class="chat-sheet-dim" data-act="close"></div><div class="chat-sheet chat-card" role="dialog" aria-modal="true" aria-label="Member profile"><div class="chat-sheet-grip" aria-hidden="true"></div><p class="chat-hint">Loading…</p></div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'close') closeChatSheet();
    else if (btn.dataset.act === 'edit') { closeChatSheet(); openChatProfile(); }
    else if (btn.dataset.act.startsWith('g:')) { closeChatSheet(); chatGroupMemberAction(btn.dataset.act.slice(2), uid, btn.dataset.role); }
    else if (btn.dataset.act === 'mention') {
      closeChatSheet();
      const input = $('chatInput');
      if (input && !input.disabled) { input.value = `${input.value}${input.value && !/\s$/.test(input.value) ? ' ' : ''}@${btn.dataset.handle} `; chatAutosize(); input.focus(); chatUpdateComposer(); }
    }
  });
  try {
    const mine = g.me && g.me.uid === uid;
    const c = mine
      ? { uid, name: g.me.nickname || g.me.displayName, handle: g.me.handle, avatar: state.avatar, role: g.me.role, status: 'o', mine: true }
      : await api('GET', `${chatRoomBase()}/members/${encodeURIComponent(uid)}`, null, { retries: 0 });
    if (!document.getElementById('chatSheet')) return;      // dismissed while loading
    const handle = c.handle ? `<div class="chat-card-handle">@${escapeHtml(c.handle)}</div>` : '';
    const dot = c.status === 'o' ? 'online' : '';
    // Group moderation: admins act on members below them; only the owner names admins.
    const myRank = chatRankOf(g.me && g.me.role);
    const canModerate = chatIsGroup() && !mine && myRank >= 1 && myRank > chatRankOf(c.role);
    const modRows = canModerate ? [
      c.muted ? ['unmute', '🔊', 'Unmute'] : ['mute', '🔇', 'Mute for 1 hour'],
      ['kick', '🚪', 'Remove from group'],
      ['ban', '⛔', 'Remove & ban', 'danger'],
    ] : [];
    if (chatIsGroup() && !mine && g.me && g.me.role === 'owner' && c.role !== 'owner') modRows.push(['role', '🛡', c.role === 'admin' ? 'Remove admin' : 'Make admin']);
    wrap.querySelector('.chat-sheet').innerHTML = `
      <div class="chat-sheet-grip" aria-hidden="true"></div>
      <div class="chat-card-head">
        <div class="chat-card-avatar ${dot}" style="--nh:${chatHue(c.uid)}">${escapeHtml(c.avatar || '🦊')}</div>
        <div class="chat-card-id">
          <div class="chat-card-name">${escapeHtml(c.name || 'Member')} ${chatRoleBadge(c.role)}</div>
          ${handle}
          <div class="chat-card-status ${c.status === 'o' ? 'online' : ''}">${mine ? 'this is you' : chatStatusText(c.status)}</div>
        </div>
      </div>
      ${c.muted ? '<div class="chat-card-note">🔇 This member is currently muted.</div>' : ''}
      ${c.code ? `<div class="chat-card-note staff">Account code (staff only): <b>${escapeHtml(c.code)}</b></div>` : ''}
      <div class="chat-sheet-list">
        ${mine ? '<button type="button" class="chat-act" data-act="edit"><span class="chat-act-ico">✎</span><span>Edit my chat profile</span></button>' : ''}
        ${c.handle && !mine ? `<button type="button" class="chat-act" data-act="mention" data-handle="${escapeHtml(c.handle)}"><span class="chat-act-ico">@</span><span>Mention @${escapeHtml(c.handle)}</span></button>` : ''}
        ${modRows.map(([act, ico, label, tone]) => `<button type="button" class="chat-act ${tone || ''}" data-act="g:${act}" data-role="${escapeHtml(c.role || '')}"><span class="chat-act-ico">${ico}</span><span>${label}</span></button>`).join('')}
        <button type="button" class="chat-act" data-act="close"><span class="chat-act-ico">✕</span><span>Close</span></button>
      </div>`;
  } catch (err) {
    if (document.getElementById('chatSheet')) { closeChatSheet(); toast(err.message || 'Could not load this profile.', { tone: 'error' }); }
  }
}

// ----- my chat profile: nickname · @username · privacy -----
const chatProfileUi = { orig: null, usernameTimer: null, usernameSeq: 0, usernameOk: true };

async function openChatProfile() {
  const modal = $('chatProfileModal');
  if (!modal) return;
  modal.hidden = false;
  $('cpError').textContent = '';
  $('cpSave').disabled = true;
  try {
    const p = await api('GET', '/globalchat/profile', null, { retries: 0 });
    chatProfileUi.orig = { nickname: p.nickname || '', username: p.username || '', hideStatus: !!p.hideStatus };
    $('cpNickname').value = p.nickname || '';
    $('cpNickname').placeholder = p.defaultName || 'Nickname';
    $('cpUsername').value = p.username || '';
    $('cpHide').checked = !!p.hideStatus;
    $('cpPreviewAvatar').textContent = state.avatar || '🦊';
    $('cpUsernameHint').textContent = '5–20 letters, numbers or _ — optional.';
    $('cpUsernameHint').className = 'cp-hint';
    chatProfileUi.usernameOk = true;
    chatProfileRefresh();
    $('cpNickname').focus();
  } catch (err) {
    modal.hidden = true;
    toast(err.status === 404 ? 'Chat profiles are not available yet — please update the app or try again later.' : (err.message || 'Could not load your chat profile.'), { tone: 'error' });
  }
}

function chatProfilePatch() {
  const o = chatProfileUi.orig || { nickname: '', username: '', hideStatus: false };
  const nickname = $('cpNickname').value.trim();
  const username = $('cpUsername').value.trim().replace(/^@+/, '');
  const hide = $('cpHide').checked;
  const patch = {};
  if (nickname !== o.nickname) patch.nickname = nickname || null;
  if (username.toLowerCase() !== o.username.toLowerCase()) patch.username = username || null;
  if (hide !== o.hideStatus) patch.hideStatus = hide;
  return patch;
}

function chatProfileRefresh() {
  const patch = chatProfileUi.orig ? chatProfilePatch() : {};
  const nick = $('cpNickname').value.trim();
  $('cpNickCount').textContent = `${Array.from(nick).length}/24`;
  $('cpPreviewName').textContent = nick || $('cpNickname').placeholder || 'Member';
  const uname = $('cpUsername').value.trim().replace(/^@+/, '');
  $('cpPreviewHandle').textContent = uname ? `@${uname.toLowerCase()}` : '';
  $('cpSave').disabled = !Object.keys(patch).length || !chatProfileUi.usernameOk || (nick.length === 1);
}

// Live "is this username free?" while typing (debounced; the server is the judge).
function chatCheckUsername() {
  const value = $('cpUsername').value.trim().replace(/^@+/, '');
  const hint = $('cpUsernameHint');
  clearTimeout(chatProfileUi.usernameTimer);
  const same = chatProfileUi.orig && value.toLowerCase() === chatProfileUi.orig.username.toLowerCase();
  if (!value || same) {
    chatProfileUi.usernameOk = true;
    hint.textContent = '5–20 letters, numbers or _ — optional.';
    hint.className = 'cp-hint';
    return chatProfileRefresh();
  }
  chatProfileUi.usernameOk = false;
  hint.textContent = 'Checking…';
  hint.className = 'cp-hint';
  const seq = ++chatProfileUi.usernameSeq;
  chatProfileUi.usernameTimer = setTimeout(async () => {
    try {
      const r = await api('GET', `/globalchat/username-check?u=${encodeURIComponent(value)}`, null, { retries: 0 });
      if (seq !== chatProfileUi.usernameSeq) return;
      chatProfileUi.usernameOk = !!r.available;
      hint.textContent = r.available ? `@${r.value} is available` : (r.error || 'That username isn’t available.');
      hint.className = `cp-hint ${r.available ? 'ok' : 'bad'}`;
    } catch (err) {
      if (seq !== chatProfileUi.usernameSeq) return;
      chatProfileUi.usernameOk = true;           // could not check — the server decides on save
      hint.textContent = '';
    }
    chatProfileRefresh();
  }, 350);
  chatProfileRefresh();
}

async function saveChatProfile() {
  const patch = chatProfilePatch();
  if (!Object.keys(patch).length) return;
  const btn = $('cpSave');
  btn.disabled = true;
  $('cpError').textContent = '';
  try {
    const p = await api('PUT', '/globalchat/profile', patch, { retries: 0 });
    const g = globalChatState;
    if (g.me) { g.me.nickname = p.nickname; g.me.handle = p.username; g.me.hideStatus = p.hideStatus; g.me.displayName = p.displayName; }
    $('chatProfileModal').hidden = true;
    toast('Chat profile saved', { tone: 'success' });
    chatNudge();
  } catch (err) {
    $('cpError').textContent = err.message || 'Could not save — please try again.';
    btn.disabled = false;
  }
}

function initChatProfileUi() {
  if ($('chatProfileModal')?.dataset.wired) return;
  const modal = $('chatProfileModal');
  if (!modal) return;
  modal.dataset.wired = '1';
  $('cpNickname').addEventListener('input', chatProfileRefresh);
  $('cpUsername').addEventListener('input', chatCheckUsername);
  $('cpHide').addEventListener('change', chatProfileRefresh);
  $('cpSave').addEventListener('click', saveChatProfile);
  $('cpCancel').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  $('cpForm').addEventListener('submit', (e) => { e.preventDefault(); if (!$('cpSave').disabled) saveChatProfile(); });
  $('chatProfileBtn')?.addEventListener('click', openChatProfile);
  $('profileChat')?.addEventListener('click', openChatProfile);
}

// ----- applying server state -----
function chatRemoveLocal(id) {
  const g = globalChatState;
  g.messages = g.messages.filter((m) => String(m.id) !== String(id));
  for (const m of g.messages) if (m.reply && String(m.reply.id) === String(id)) m.reply = { ...m.reply, text: null };
  if (g.pinned && String(g.pinned.id) === String(id)) g.pinned = null;
  chatRenderAll();
  chatUpdatePinBar();
}

function chatApplySync(res) {
  const g = globalChatState;
  const c = $('chatMessages');
  const firstLoad = !g.loaded;
  const stick = !c || chatNearBottom(c, 160);
  let full = false;
  const added = [];

  if (res.reset) {
    g.messages = Array.isArray(res.messages) ? res.messages : [];
    g.pending = g.pending.filter((p) => !g.messages.some((m) => m.clientId === p.cid));
    full = true;
  } else {
    for (const ev of res.events || []) {
      if (ev.type === 'msg' && ev.message) {
        const m = ev.message;
        if (g.messages.some((x) => x.id === m.id)) continue;
        const pi = m.clientId ? g.pending.findIndex((p) => p.cid === m.clientId) : -1;
        if (pi >= 0) { g.pending.splice(pi, 1); full = true; }
        g.messages.push(m);
        added.push(m);
      } else if (ev.type === 'role') {
        for (const x of g.messages) if (x.uid === ev.uid) x.role = ev.role;
        full = true;
      } else if (ev.type === 'profile') {
        // A member changed their nickname / @username: every message of theirs follows.
        for (const x of g.messages) {
          if (x.uid === ev.uid) { x.name = ev.name; x.handle = ev.handle || null; }
          if (x.reply && x.reply.uid === ev.uid) x.reply = { ...x.reply, name: ev.name };
        }
        if (g.pinned && g.pinned.uid === ev.uid) g.pinned = { ...g.pinned, name: ev.name, handle: ev.handle || null };
        full = true;
      } else if (ev.type === 'del') {
        const had = g.messages.some((x) => x.id === ev.id);
        g.messages = g.messages.filter((x) => x.id !== ev.id);
        for (const x of g.messages) if (x.reply && x.reply.id === ev.id) x.reply = { ...x.reply, text: null };
        if (had) full = true;
      }
    }
    if (g.messages.length > CHAT_DOM_MAX) { g.messages.splice(0, g.messages.length - CHAT_DOM_MAX); full = true; }
  }
  g.epoch = res.epoch;
  g.rev = res.rev;
  g.pinned = res.pinned || null;
  const prevEnergy = g.me ? g.me.energy : null;
  g.me = res.me || g.me;
  // The sender's own live feed wakes the moment the message is stored, which is just BEFORE the
  // Energy is charged, so it can carry the old balance. Right after a send, keep the newer local value.
  if (res.me && prevEnergy != null && Date.now() - (g.energyLocalAt || 0) < 2500) {
    g.me.energy = prevEnergy;
    g.me.needed = Math.max(0, g.me.cost - prevEnergy);
    g.me.canChat = prevEnergy >= g.me.cost && !g.me.mute;
  }
  if (res.group) g.group = res.group;
  g.muted = Array.isArray(res.muted) ? res.muted : [];
  if (res.presence) g.presence = { online: Number(res.presence.online) || 0, seen: res.presence.seen || {} };
  g.loaded = true;
  g.available = true;

  if (full || firstLoad || g.pending.length) chatRenderAll({ stick: stick || firstLoad });
  else for (const m of added) chatAppend(m);
  chatPaintPresence();

  const others = added.filter((m) => !m.mine);
  if (others.length && !res.reset) {
    if (stick) chatScrollToBottom(true);
    else { g.unread += others.length; chatUpdateJump(); }
  } else if (added.some((m) => m.mine) && !res.reset) {
    chatScrollToBottom(true);
  }
  chatUpdateHeader();
  chatUpdatePinBar();
  chatUpdateComposer();
  chatMarkSeen();
}

// Remembers the newest message the member has actually looked at, for the unread dots in the chat list.
function chatMarkSeen() {
  const g = globalChatState;
  if (!chatTabActive() || g.listOpen) return;
  const last = g.messages[g.messages.length - 1];
  if (!last) return;
  try { localStorage.setItem(`dltx_seen_${chatRoomKey()}`, String(last.id)); } catch {}
}

function chatUpdateJump() {
  const g = globalChatState;
  const c = $('chatMessages');
  const jump = $('chatJump');
  if (!c || !jump) return;
  const far = !chatNearBottom(c, 200);
  jump.hidden = !far;
  const badge = $('chatJumpCount');
  if (badge) { badge.hidden = !g.unread; badge.textContent = g.unread > 99 ? '99+' : String(g.unread); }
}

// ----- sending (optimistic, idempotent) -----
async function chatSend() {
  const g = globalChatState;
  const input = $('chatInput');
  if (!input || input.disabled) return;
  const text = input.value.trim();
  if (!text) return;
  if (text.length > CHAT_MAX_LEN) { toast(`Message too long (max ${CHAT_MAX_LEN} characters)`); return; }

  const cid = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const reply = g.replyTo;
  const pending = {
    id: `p-${cid}`, cid, pending: true, mine: true, name: 'You', avatar: state.avatar,
    role: g.me?.role || 'user', text, ts: new Date().toISOString(),
    reply: reply ? { id: reply.id, name: reply.name, text: reply.text } : null,
  };
  g.pending.push(pending);
  input.value = '';
  chatAutosize();
  chatSaveDraft();
  chatCancelReply();
  chatAppend(pending);
  chatScrollToBottom(true);
  chatUpdateComposer();
  input.focus();
  await chatDeliver(pending);
}

async function chatDeliver(p, attempt = 0) {
  const g = globalChatState;
  const roomKey = chatRoomKey();      // the conversation this message belongs to (the member may switch away mid-send)
  const base = chatRoomBase();
  const stillHere = () => roomKey === chatRoomKey();
  p.failed = false;
  p.pending = true;
  chatPaintOne(p);
  try {
    const res = await api('POST', `${base}/messages`, { text: p.text, replyTo: p.reply ? p.reply.id : undefined, clientId: p.cid, avatar: state.avatar }, { retries: 0 });
    if (res.energyRemaining !== undefined) {
      // state.energy is the full Energy snapshot — merge, never replace it.
      adoptEnergy({ ...(state.energy || {}), energy: Number(res.energyRemaining) });
      renderEnergy();
    }
    if (!stillHere()) return;           // delivered; the other conversation will show it when opened
    g.pending = g.pending.filter((x) => x !== p);
    if (res.message && !g.messages.some((m) => m.id === res.message.id)) g.messages.push(res.message);
    g.messages.sort((a, b) => a.id - b.id);
    if (res.energyRemaining !== undefined && g.me) {
      g.me.energy = Number(res.energyRemaining); g.me.canChat = g.me.energy >= g.me.cost && !g.me.mute;
      g.energyLocalAt = Date.now();
      setTimeout(() => { if (chatLive()) chatNudge(); }, 2700);     // one authoritative refresh once the dust settles
    }
    chatRenderAll({ stick: true });
    chatUpdateHeader();
    chatUpdateComposer();
  } catch (err) {
    if (!stillHere()) return;
    if (err.status === 429 && err.data?.code !== 'CHAT_FLOOD' && attempt < 3) { await chatSleep(1100); return chatDeliver(p, attempt + 1); }
    if (err.status === 404 && err.data?.code === 'REPLY_NOT_FOUND' && p.reply) { p.reply = null; return chatDeliver(p, attempt); }
    if ([400, 402, 403, 409, 429].includes(err.status)) {
      // Refused outright (no Energy, muted, a link, a duplicate, too fast…): nothing was
      // charged, and the text goes back into the box instead of being lost.
      g.pending = g.pending.filter((x) => x !== p);
      const input = $('chatInput');
      if (input && !input.value) { input.value = p.text; chatAutosize(); }
      if (g.me) {
        if (err.status === 402) { g.me.canChat = false; if (err.data && Number.isFinite(Number(err.data.current))) g.me.energy = Number(err.data.current); }
        else if (err.data?.mute) g.me.mute = err.data.mute;
      }
      const msg = err.status === 402 ? `⚡ You need ${g.me?.cost || 1} Energy to send a message.` : (err.message || 'That message couldn’t be sent.');
      toast(msg, { tone: err.status === 403 || err.status === 402 ? 'warning' : 'error' });
      chatRenderAll();
      chatUpdateHeader();
      chatUpdateComposer();
      return;
    }
    p.pending = false;
    p.failed = true;
    chatPaintOne(p);
    // Silent while an automatic re-send is going on, so a flaky link doesn't pile up toasts.
    if (!p.silent) toast('Message not sent — it will be retried when you are back online, or tap it to retry. Your Energy was not used.', { tone: 'error' });
    p.silent = false;
  }
}

// After a reconnect, anything that failed to leave the phone is sent again. Delivery is
// idempotent per clientId, so this can never double-send or double-charge.
function chatResendFailed() {
  for (const p of [...globalChatState.pending]) {
    if (p.failed && !p.pending) { p.silent = true; chatDeliver(p); }
  }
}

// Repaints a single (pending/failed) bubble in place.
function chatPaintOne(p) {
  const c = $('chatMessages');
  const el = c?.querySelector(`.chat-message[data-id="${CSS.escape(String(p.id))}"]`);
  if (!el) return;
  el.classList.toggle('pending', !!p.pending);
  el.classList.toggle('failed', !!p.failed);
  const meta = el.querySelector('.chat-meta');
  if (meta) {
    meta.querySelector('.chat-tick')?.remove();
    meta.insertAdjacentHTML('beforeend', p.failed ? '<span class="chat-tick err">!</span>' : p.pending ? '<span class="chat-tick wait">⏳</span>' : '<span class="chat-tick">✓</span>');
  }
}

// ----- live sync loop (long-poll) -----
async function chatSyncLoop(gen) {
  const g = globalChatState;
  while (gen === g.gen && state.token && chatLive()) {
    if (document.hidden) { await chatSleep(800); continue; }
    try {
      // The first request after any (re)start is a quick one, so status, presence and
      // missed messages refresh at once; only then does the sync park as a long-poll.
      const wait = g.loaded && !g.fast ? 15 : 0;
      g.fast = false;
      const res = await api('GET', `${chatRoomBase()}/sync?since=${g.rev}&epoch=${encodeURIComponent(g.epoch || '')}&wait=${wait}`, null, { retries: 0 });
      if (gen !== g.gen) return;
      const recovered = g.failures > 0;
      g.failures = 0;
      chatApplySync(res);
      if (recovered) chatResendFailed();
    } catch (err) {
      if (gen !== g.gen) return;
      if (err.status === 401) return;
      // Removed from a group, or the group was deleted: leave it instead of retrying forever.
      if (chatIsGroup() && (err.status === 403 || err.status === 404)) { chatGroupGone(err); return; }
      g.failures += 1;
      g.available = g.messages.length > 0;
      if (!g.loaded) { g.loaded = true; chatRenderAll(); }
      chatUpdateHeader();
      chatUpdateComposer();
      await chatSleep(err.status === 404 ? 15000 : Math.min(10000, 800 * 2 ** Math.min(g.failures, 4)));
    }
  }
  if (gen === g.gen) g.running = false;
}

function chatStart() {
  const g = globalChatState;
  g.gen += 1;
  g.running = true;
  g.fast = true;
  chatSyncLoop(g.gen);
}

function stopChatPolling() {
  const g = globalChatState;
  g.gen += 1;
  g.running = false;
  // Leaving the chat must also dismiss the keyboard, or the navigation bar stays hidden.
  const input = document.getElementById('chatInput');
  if (input && document.activeElement === input) input.blur();
}

// Called on sign-out / account switch so nothing leaks between accounts.
function chatReset() {
  const g = globalChatState;
  stopChatPolling();
  Object.assign(g, {
    messages: [], pending: [], pinned: null, muted: [], me: null, epoch: '', rev: 0, failures: 0,
    available: true, loaded: false, replyTo: null, unread: 0, presence: { online: 0, seen: {} }, view: null, adBusy: false,
    room: { type: 'global' }, group: null, groups: [], listOpen: false, roomChosen: false,
  });
  $('tab-chatroom')?.classList.remove('show-list');
  const input = $('chatInput');
  if (input) { input.value = ''; chatAutosize(); }
  const c = $('chatMessages');
  if (c) c.innerHTML = '<p class="chat-hint">Loading messages…</p>';
  const bar = $('chatReplyBar');
  if (bar) bar.hidden = true;
  closeChatSheet();
}

// ----- gestures: tap = actions, long-press = actions, swipe right = reply -----
function chatInitGestures(c) {
  let st = null;
  const done = () => {
    if (!st) return;
    clearTimeout(st.timer);
    st.row.style.transform = '';
    st.row.classList.remove('reply-ready', 'swiping');
    st = null;
  };
  c.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const row = e.target.closest('.chat-message');
    if (!row) return;
    st = { row, id: row.dataset.id, x: e.clientX, y: e.clientY, dx: 0, swiping: false, fired: false, ready: false };
    st.timer = setTimeout(() => {
      if (st && !st.swiping) { st.fired = true; chatOpenSheet(st.id); }
    }, 480);
  });
  c.addEventListener('pointermove', (e) => {
    if (!st) return;
    st.dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    if (!st.swiping && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(st.dx)) return done();
    if (!st.swiping && st.dx > 14 && st.dx > Math.abs(dy) * 1.5) { st.swiping = true; clearTimeout(st.timer); st.row.classList.add('swiping'); }
    if (st.swiping) {
      const pull = Math.max(0, Math.min(st.dx, 76));
      st.row.style.transform = `translateX(${pull}px)`;
      const ready = pull >= 56;
      if (ready && !st.ready) chatHaptic();
      st.ready = ready;
      st.row.classList.toggle('reply-ready', ready);
    }
  });
  c.addEventListener('pointerup', (e) => {
    if (!st) return;
    const s = st;
    clearTimeout(s.timer);
    if (s.swiping) {
      const doReply = s.ready;
      done();
      if (doReply) chatStartReply(s.id);
      return;
    }
    const moved = Math.abs(e.clientX - s.x) > 8 || Math.abs(e.clientY - s.y) > 8;
    done();
    if (s.fired || moved) return;
    // A plain tap on a quote jumps to the original; on a name or avatar it opens that
    // member's card; anywhere else it opens the message actions.
    const quote = e.target.closest?.('.chat-quote');
    const who = e.target.closest?.('.chat-avatar, .chat-name');
    if (quote) chatGoTo(quote.dataset.goto);
    else if (who && who.dataset.uid) chatOpenMember(who.dataset.uid);
    else chatOpenSheet(s.id);
  });
  c.addEventListener('pointercancel', done);
  c.addEventListener('contextmenu', (e) => { if (e.target.closest('.chat-message')) e.preventDefault(); });
  // Keyboard users: Enter / Space on a focused bubble opens the same actions.
  c.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('chat-bubble')) {
      e.preventDefault();
      chatOpenSheet(e.target.closest('.chat-message')?.dataset.id);
    }
  });
}

// ================= Chat rooms: the chat list, groups and invites =================
const CHAT_ROOM_STORE = 'dltx_chat_room';

function chatSavedRoom() {
  try {
    const d = JSON.parse(localStorage.getItem(CHAT_ROOM_STORE) || 'null');
    if (d && d.o === chatDraftOwner() && d.r && d.r.type === 'group' && Number(d.r.id) > 0) return { type: 'group', id: Number(d.r.id), title: String(d.r.title || '').slice(0, 40) };
  } catch {}
  return { type: 'global' };
}
function chatSaveRoom(room) {
  try { localStorage.setItem(CHAT_ROOM_STORE, JSON.stringify({ o: chatDraftOwner(), r: room })); } catch {}
}

// Drops the open conversation's data (not the drafts, and not the pointer to which room is open).
function chatClearConversation() {
  const g = globalChatState;
  Object.assign(g, {
    messages: [], pending: [], pinned: null, muted: [], me: null, epoch: '', rev: 0, failures: 0,
    available: true, loaded: false, replyTo: null, unread: 0, presence: { online: 0, seen: {} }, view: null, group: null,
  });
  const input = $('chatInput');
  if (input) { input.value = ''; chatAutosize(); }
  const c = $('chatMessages');
  if (c) c.innerHTML = '<p class="chat-hint">Loading messages…</p>';
  const bar = $('chatReplyBar');
  if (bar) bar.hidden = true;
  closeChatSheet();
}

/** Opens a conversation: { type: 'global' } or { type: 'group', id, title }. */
function chatOpenRoom(room) {
  const g = globalChatState;
  const next = room.type === 'group' ? { type: 'group', id: Number(room.id), title: String(room.title || '') } : { type: 'global' };
  const same = g.room.type === next.type && g.room.id === next.id;
  stopChatPolling();
  chatSaveDraft();                       // keep what was typed in the conversation we are leaving
  if (!same) { chatClearConversation(); g.room = next; }
  chatSaveRoom(g.room);
  g.listOpen = false;
  $('tab-chatroom')?.classList.remove('show-list');
  chatRestoreDraft();
  chatUpdateHeader();
  chatUpdatePinBar();
  chatUpdateComposer();
  if (g.loaded) chatRenderAll({ stick: true });
  requestAnimationFrame(() => (g.loaded ? chatRestoreView() : chatScrollToBottom(false)));
  chatStart();
}

/** The chat list: Global chat first, then my groups. */
function chatShowList() {
  const g = globalChatState;
  chatSaveView();
  chatSaveDraft();
  stopChatPolling();
  closeChatSheet();
  g.listOpen = true;
  $('tab-chatroom')?.classList.add('show-list');
  chatPaintList();
  chatLoadList();
}

// The member was removed from a group (or it was deleted): leave it instead of retrying forever.
function chatGroupGone(err) {
  const g = globalChatState;
  const id = g.room.id;
  toast((err && err.message) || 'This group is no longer available.', { tone: 'warning' });
  g.groups = g.groups.filter((x) => x.id !== id);
  g.room = { type: 'global' };
  chatClearConversation();
  chatSaveRoom(g.room);
  chatShowList();
}

function chatAddGroupCard(card) {
  const g = globalChatState;
  g.groups = [card, ...g.groups.filter((x) => x.id !== card.id)];
}

async function chatLoadList() {
  const g = globalChatState;
  try {
    const r = await api('GET', '/groups', null, { retries: 0 });
    g.groups = Array.isArray(r.groups) ? r.groups : [];
    g.groupsError = '';
  } catch (err) {
    if (err.status === 401) return;
    g.groupsError = err.status === 404 ? 'Groups are not available yet — please update the app or try again later.' : (err.message || 'Could not load your groups.');
  }
  if (g.listOpen) chatPaintList();
}

const chatListTime = (ts) => {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? chatTime(ts) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const chatInitial = (title) => (Array.from(String(title || '#').trim())[0] || '#').toUpperCase();

function chatPaintList() {
  const g = globalChatState;
  const box = $('chatRows');
  if (!box) return;
  const energy = state.energy && typeof state.energy.energy === 'number' ? state.energy.energy : null;
  const chip = $('chatListEnergy');
  if (chip) chip.textContent = energy == null ? '⚡ —' : `⚡ ${energy.toLocaleString()}`;
  const rows = [`
    <button type="button" class="chat-row" role="listitem" data-room="global">
      <span class="chat-row-av global" aria-hidden="true">🌍</span>
      <span class="chat-row-body"><span class="chat-row-top"><b class="chat-row-title">Deltix Global Chat</b></span><span class="chat-row-last">Everyone on Deltix Network</span></span>
    </button>`];
  for (const gr of g.groups) {
    const seen = Number(localStorage.getItem(`dltx_seen_g${gr.id}`) || 0);
    const unread = gr.last && gr.last.id > seen;
    const roleTag = gr.role === 'owner' ? '<span class="chat-role owner">OWNER</span>' : gr.role === 'admin' ? '<span class="chat-role admin">ADMIN</span>' : '';
    rows.push(`
      <button type="button" class="chat-row ${unread ? 'unread' : ''}" role="listitem" data-room="g:${gr.id}" data-title="${escapeHtml(gr.title)}">
        <span class="chat-row-av" style="--nh:${chatHue(String(gr.id))}" aria-hidden="true">${escapeHtml(chatInitial(gr.title))}</span>
        <span class="chat-row-body">
          <span class="chat-row-top"><b class="chat-row-title">${escapeHtml(gr.title)}</b>${roleTag}<span class="chat-row-time">${gr.last ? chatListTime(gr.last.ts) : ''}</span></span>
          <span class="chat-row-last">${gr.last ? `<i>${escapeHtml(gr.last.name || 'Member')}:</i> ${escapeHtml(gr.last.text)}` : `${gr.memberCount.toLocaleString()} member${gr.memberCount === 1 ? '' : 's'} · no messages yet`}</span>
        </span>
        ${unread ? '<span class="chat-unread-dot" aria-label="New messages"></span>' : ''}
      </button>`);
  }
  if (g.groupsError) rows.push(`<p class="chat-hint">${escapeHtml(g.groupsError)}</p>`);
  else if (!g.groups.length) rows.push('<div class="chat-empty small"><div class="chat-empty-icon">👥</div><b>Start your own group</b><p>Create a group for your friends or team, or discover public groups to join.</p></div>');
  box.innerHTML = rows.join('');
}

// ----- dialogs (a bottom sheet; Back and the dim area close it) -----
function chatDialog(html, label) {
  closeChatSheet();
  const wrap = document.createElement('div');
  wrap.className = 'chat-sheet-wrap';
  wrap.id = 'chatSheet';
  wrap.innerHTML = `<div class="chat-sheet-dim" data-act="close"></div><div class="chat-sheet chat-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}"><div class="chat-sheet-grip" aria-hidden="true"></div><div class="cd-body">${html}</div></div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-act="close"]')) closeChatSheet(); });
  const body = wrap.querySelector('.cd-body');
  return { wrap, body, set(htmlNext) { body.innerHTML = htmlNext; } };
}

function chatOpenCreateGroup() {
  const g = globalChatState;
  const cost = g.me ? g.me.cost : 1;
  const d = chatDialog(`
    <h3 class="cd-title">New group</h3>
    <p class="cd-sub">You become the group’s owner and admin. Every message costs ${cost} ⚡ Energy, for everyone.</p>
    <label class="cp-label" for="cgTitle">Group name <span id="cgCount">0/40</span></label>
    <input id="cgTitle" class="cp-input" type="text" maxlength="40" placeholder="e.g. Crypto Friends" autocomplete="off" enterkeyhint="next">
    <label class="cp-label" for="cgAbout">Description <em>(optional)</em></label>
    <textarea id="cgAbout" class="cp-input" rows="2" maxlength="200" placeholder="What is this group about?"></textarea>
    <label class="cp-switch"><input type="checkbox" id="cgPublic"><span>Public group <small>Anyone can find and join it. Private groups are joined with an invite code.</small></span></label>
    <p class="cp-error" id="cgError" role="alert"></p>
    <div class="cp-btns"><button class="btn ghost" type="button" data-act="close">Cancel</button><button class="btn primary" id="cgCreate" type="button" disabled>Create group</button></div>`, 'New group');
  const title = d.body.querySelector('#cgTitle');
  const btn = d.body.querySelector('#cgCreate');
  const err = d.body.querySelector('#cgError');
  const refresh = () => { const n = Array.from(title.value.trim()).length; d.body.querySelector('#cgCount').textContent = `${n}/40`; btn.disabled = n < 3; };
  title.addEventListener('input', refresh);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    err.textContent = '';
    try {
      const r = await api('POST', '/groups', { title: title.value, about: d.body.querySelector('#cgAbout').value, isPublic: d.body.querySelector('#cgPublic').checked }, { retries: 0 });
      chatAddGroupCard(r.group);
      chatOpenRoom({ type: 'group', id: r.group.id, title: r.group.title });
      toast(`“${r.group.title}” created — you are its owner.`, { tone: 'success' });
      setTimeout(() => { if (chatIsGroup() && globalChatState.room.id === r.group.id) chatOpenGroupInfo(); }, 350);   // shows the invite code
    } catch (e) {
      err.textContent = e.message || 'Could not create the group.';
      btn.disabled = false;
    }
  });
  title.focus();
}

function chatGroupRowHtml(x) {
  return `<div class="cd-item">
    <span class="chat-row-av" style="--nh:${chatHue(String(x.id))}" aria-hidden="true">${escapeHtml(chatInitial(x.title))}</span>
    <div class="cd-item-body"><b>${escapeHtml(x.title)}</b><span>${x.memberCount.toLocaleString()} member${x.memberCount === 1 ? '' : 's'}${x.about ? ` · ${escapeHtml(chatSnippet(x.about, 70))}` : ''}</span></div>
    <button class="btn small ${x.joined ? 'ghost' : 'primary'}" type="button" data-join="${x.id}" data-title="${escapeHtml(x.title)}">${x.joined ? 'Open' : 'Join'}</button>
  </div>`;
}

async function chatJoinGroup(btn, payload, titleHint) {
  btn.disabled = true;
  try {
    const r = await api('POST', '/groups/join', payload, { retries: 0 });
    chatAddGroupCard(r.group);
    chatOpenRoom({ type: 'group', id: r.group.id, title: r.group.title || titleHint });
  } catch (e) {
    toast(e.message || 'Could not join this group.', { tone: 'error' });
    btn.disabled = false;
  }
}

function chatOpenDiscover() {
  const d = chatDialog(`
    <h3 class="cd-title">Discover groups</h3>
    <input id="dcQuery" class="cp-input" type="search" placeholder="Search public groups" maxlength="40" autocomplete="off">
    <div id="dcList" class="cd-list"><p class="chat-hint">Loading…</p></div>
    <div class="cp-btns"><button class="btn ghost" type="button" data-act="close">Close</button></div>`, 'Discover groups');
  const list = d.body.querySelector('#dcList');
  const q = d.body.querySelector('#dcQuery');
  let seq = 0; let timer = null;
  const load = async () => {
    const mine = ++seq;
    try {
      const r = await api('GET', `/groups/discover?q=${encodeURIComponent(q.value.trim())}`, null, { retries: 0 });
      if (mine !== seq) return;
      const gs = r.groups || [];
      list.innerHTML = gs.length ? gs.map(chatGroupRowHtml).join('') : '<p class="chat-hint">No public groups found yet. Create the first one!</p>';
    } catch (e) {
      if (mine === seq) list.innerHTML = `<p class="chat-hint">${escapeHtml(e.status === 404 ? 'Groups are not available yet.' : (e.message || 'Could not load groups.'))}</p>`;
    }
  };
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-join]');
    if (b) chatJoinGroup(b, { groupId: Number(b.dataset.join) }, b.dataset.title);
  });
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  load();
}

// Accepts the bare code or any text that ends with it (a pasted invite message).
function chatExtractCode(text) {
  const found = String(text || '').trim().toLowerCase().match(/[a-z0-9]{10}/g);
  return found ? found[found.length - 1] : '';
}

function chatOpenJoin() {
  const d = chatDialog(`
    <h3 class="cd-title">Join with an invite code</h3>
    <p class="cd-sub">Paste the code (or the whole invite message) you were sent.</p>
    <input id="jcCode" class="cp-input" type="text" placeholder="Invite code" autocomplete="off" autocapitalize="none" spellcheck="false">
    <div id="jcInfo" class="cd-list"></div>
    <p class="cp-error" id="jcError" role="alert"></p>
    <div class="cp-btns"><button class="btn ghost" type="button" data-act="close">Cancel</button><button class="btn primary" id="jcFind" type="button" disabled>Find group</button></div>`, 'Join with an invite code');
  const input = d.body.querySelector('#jcCode');
  const find = d.body.querySelector('#jcFind');
  const err = d.body.querySelector('#jcError');
  const info = d.body.querySelector('#jcInfo');
  let code = '';
  input.addEventListener('input', () => { code = chatExtractCode(input.value); find.disabled = !code; find.textContent = 'Find group'; info.innerHTML = ''; err.textContent = ''; find.dataset.step = ''; });
  find.addEventListener('click', async () => {
    err.textContent = '';
    if (find.dataset.step === 'join') return chatJoinGroup(find, { code }, '');
    find.disabled = true;
    try {
      const r = await api('GET', `/groups/invite/${encodeURIComponent(code)}`, null, { retries: 0 });
      const x = r.group;
      info.innerHTML = `<div class="cd-item"><span class="chat-row-av" style="--nh:${chatHue(String(x.id))}">${escapeHtml(chatInitial(x.title))}</span><div class="cd-item-body"><b>${escapeHtml(x.title)}</b><span>${x.memberCount.toLocaleString()} member${x.memberCount === 1 ? '' : 's'} · ${x.isPublic ? 'public' : 'private'} group${x.about ? ` · ${escapeHtml(chatSnippet(x.about, 70))}` : ''}</span></div></div>`;
      find.textContent = 'Join group';
      find.dataset.step = 'join';
      find.disabled = false;
    } catch (e) {
      err.textContent = e.message || 'That invite code is not valid.';
      find.disabled = false;
    }
  });
  input.focus();
}

// ----- the open group: info, members, invite, settings -----
const chatGroupData = () => globalChatState.group || globalChatState.groups.find((x) => x.id === globalChatState.room.id) || null;

async function chatShareInvite(d) {
  const text = `Join “${d.title}” on Deltix Network — open Chat › Join with code and enter: ${d.inviteCode}`;
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  await chatCopy(text);
}

function chatOpenGroupInfo(view = 'main') {
  const g = globalChatState;
  if (!chatIsGroup()) return;
  const info = chatGroupData();
  if (!info) return;
  const owner = (g.me && g.me.role === 'owner') || info.role === 'owner';
  const dlg = chatDialog('', 'Group info');
  const row = (act, ico, label, tone) => `<button type="button" class="chat-act ${tone || ''}" data-act="${act}"><span class="chat-act-ico" aria-hidden="true">${ico}</span><span>${label}</span></button>`;

  const renderMain = () => {
    const d = chatGroupData() || info;
    dlg.set(`
      <div class="cd-head"><span class="chat-row-av big" style="--nh:${chatHue(String(d.id))}" aria-hidden="true">${escapeHtml(chatInitial(d.title))}</span>
        <div><h3 class="cd-title">${escapeHtml(d.title)}</h3><span class="cd-sub">${d.memberCount.toLocaleString()} member${d.memberCount === 1 ? '' : 's'} · ${d.isPublic ? 'public' : 'private'} group</span></div></div>
      ${d.about ? `<p class="cd-about">${escapeHtml(d.about)}</p>` : ''}
      ${d.inviteCode ? `<div class="cd-invite"><span>Invite code</span><b id="gdCode">${escapeHtml(d.inviteCode)}</b><button class="btn small ghost" type="button" data-act="copy-code">Copy</button><button class="btn small primary" type="button" data-act="share-code">Share</button></div>` : ''}
      <div class="chat-sheet-list">
        ${row('members', '👥', `Members (${d.memberCount.toLocaleString()})`)}
        ${owner ? row('edit', '✎', 'Edit group') : ''}
        ${row('report', '🚩', 'Report group')}
        ${owner ? row('delete', '🗑', 'Delete group', 'danger') : row('leave', '🚪', 'Leave group', 'danger')}
        ${row('close', '✕', 'Close')}
      </div>`);
  };

  const renderMembers = async () => {
    dlg.set('<h3 class="cd-title">Members</h3><div class="cd-list"><p class="chat-hint">Loading…</p></div>');
    try {
      const r = await api('GET', `${chatRoomBase()}/members`, null, { retries: 0 });
      dlg.set(`<h3 class="cd-title">Members <span class="cd-count">${r.total}</span></h3>
        <div class="cd-list">${r.members.map((m) => `
          <button type="button" class="cd-item member" data-act="member" data-uid="${escapeHtml(m.uid)}">
            <span class="chat-avatar ${m.status === 'o' ? 'online' : ''}" aria-hidden="true">${escapeHtml(m.avatar || '🦊')}</span>
            <span class="cd-item-body"><b>${escapeHtml(m.name)}${m.me ? ' (you)' : ''} ${chatRoleBadge(m.role)}</b><span>${m.handle ? `@${escapeHtml(m.handle)} · ` : ''}${m.me ? 'online' : chatStatusText(m.status)}${m.muted ? ' · muted' : ''}</span></span>
          </button>`).join('')}</div>
        <div class="cp-btns"><button class="btn ghost" type="button" data-act="back">‹ Back</button></div>`);
    } catch (e) {
      dlg.set(`<p class="chat-hint">${escapeHtml(e.message || 'Could not load members.')}</p><div class="cp-btns"><button class="btn ghost" type="button" data-act="back">‹ Back</button></div>`);
    }
  };

  const renderEdit = () => {
    const d = chatGroupData() || info;
    dlg.set(`
      <h3 class="cd-title">Edit group</h3>
      <label class="cp-label" for="geTitle">Group name <span id="geCount">${Array.from(d.title).length}/40</span></label>
      <input id="geTitle" class="cp-input" type="text" maxlength="40" value="${escapeHtml(d.title)}" autocomplete="off">
      <label class="cp-label" for="geAbout">Description</label>
      <textarea id="geAbout" class="cp-input" rows="2" maxlength="200">${escapeHtml(d.about || '')}</textarea>
      <label class="cp-switch"><input type="checkbox" id="gePublic" ${d.isPublic ? 'checked' : ''}><span>Public group <small>Anyone can find and join it.</small></span></label>
      <button class="chat-act" type="button" data-act="rotate"><span class="chat-act-ico" aria-hidden="true">🔄</span><span>New invite code <small class="cd-note">(the old one stops working)</small></span></button>
      <p class="cp-error" id="geError" role="alert"></p>
      <div class="cp-btns"><button class="btn ghost" type="button" data-act="back">‹ Back</button><button class="btn primary" type="button" data-act="save-edit">Save</button></div>`);
  };

  const saveEdit = async (rotate) => {
    const err = dlg.body.querySelector('#geError');
    if (err) err.textContent = '';
    try {
      const patch = rotate ? { rotateInvite: true } : { title: dlg.body.querySelector('#geTitle').value, about: dlg.body.querySelector('#geAbout').value, isPublic: dlg.body.querySelector('#gePublic').checked };
      const r = await api('PUT', chatRoomBase(), patch, { retries: 0 });
      g.group = r.group;
      g.room.title = r.group.title;
      chatAddGroupCard(r.group);
      chatUpdateHeader();
      toast(rotate ? 'New invite code created' : 'Group updated', { tone: 'success' });
      renderMain();
    } catch (e) { if (err) err.textContent = e.message || 'Could not save.'; }
  };

  dlg.wrap.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const d = chatGroupData() || info;
    if (act === 'members') renderMembers();
    else if (act === 'back') renderMain();
    else if (act === 'edit') renderEdit();
    else if (act === 'save-edit') saveEdit(false);
    else if (act === 'rotate') saveEdit(true);
    else if (act === 'copy-code') chatCopy(d.inviteCode);
    else if (act === 'share-code') chatShareInvite(d);
    else if (act === 'member') { const uid = btn.dataset.uid; closeChatSheet(); chatOpenMember(uid); }
    else if (act === 'report') {
      closeChatSheet();      // the confirm dialog sits below the sheet layer, so the sheet must go first
      const ok = await askConfirm({ title: 'Report this group?', message: 'The Deltix team will review the group. Your report is confidential.', confirmText: 'Report' });
      if (ok) { try { await api('POST', `${chatRoomBase()}/report`, { reason: 'Group reported from the app' }); toast('Thanks — the Deltix team will review it.', { tone: 'success' }); } catch (er) { toast(er.message || 'Could not send the report.', { tone: 'error' }); } }
    } else if (act === 'leave' || act === 'delete') {
      const del = act === 'delete';
      closeChatSheet();
      const ok = await askConfirm({ title: del ? 'Delete this group?' : 'Leave this group?', message: del ? 'The group and all its messages will be deleted for everyone. This cannot be undone.' : 'You can join again with the invite code.', confirmText: del ? 'Delete group' : 'Leave', danger: true });
      if (!ok) return;
      try {
        await api(del ? 'DELETE' : 'POST', del ? chatRoomBase() : `${chatRoomBase()}/leave`, null, { retries: 0 });
        g.groups = g.groups.filter((x) => x.id !== g.room.id);
        g.room = { type: 'global' };
        chatClearConversation();
        chatSaveRoom(g.room);
        toast(del ? 'Group deleted' : 'You left the group', { tone: 'success' });
        chatShowList();
      } catch (er) { toast(er.message || 'Could not do that.', { tone: 'error' }); }
    }
  });

  if (view === 'members') renderMembers(); else renderMain();
}

// Moderation from a member's card inside a group.
async function chatGroupMemberAction(kind, uid, role) {
  const base = chatRoomBase();
  try {
    if (kind === 'mute') { await api('POST', `${base}/members/${uid}/mute`, { minutes: 60 }); toast('Member muted for 1 hour', { tone: 'success' }); }
    else if (kind === 'unmute') { await api('POST', `${base}/members/${uid}/unmute`); toast('Member unmuted', { tone: 'success' }); }
    else if (kind === 'kick' || kind === 'ban') {
      const ban = kind === 'ban';
      const ok = await askConfirm({ title: ban ? 'Remove and ban this member?' : 'Remove this member?', message: ban ? 'They will not be able to rejoin, even with the invite code.' : 'They can join again with the invite code.', confirmText: ban ? 'Remove & ban' : 'Remove', danger: true });
      if (!ok) return;
      await api('POST', `${base}/members/${uid}/kick`, { ban });
      toast(ban ? 'Member banned' : 'Member removed', { tone: 'success' });
    } else if (kind === 'role') {
      await api('POST', `${base}/members/${uid}/role`, { role: role === 'admin' ? 'member' : 'admin' });
      toast(role === 'admin' ? 'Admin removed' : 'Admin added', { tone: 'success' });
    }
    chatNudge();
  } catch (e) { toast(e.message || 'Action failed', { tone: 'error' }); }
}

function initChatRoomsUi() {
  const list = $('chatListView');
  if (!list || list.dataset.wired) return;
  list.dataset.wired = '1';
  $('chatListBtn')?.addEventListener('click', chatShowList);
  $('chatHeadMain')?.addEventListener('click', () => { if (chatIsGroup()) chatOpenGroupInfo(); });
  $('chatNewGroup')?.addEventListener('click', chatOpenCreateGroup);
  $('chatDiscover')?.addEventListener('click', chatOpenDiscover);
  $('chatJoinCode')?.addEventListener('click', chatOpenJoin);
  $('chatListEnergy')?.addEventListener('click', () => { if (typeof openShop === 'function') openShop(); });
  $('chatRows')?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-room]');
    if (!row) return;
    const key = row.dataset.room;
    if (key === 'global') chatOpenRoom({ type: 'global' });
    else chatOpenRoom({ type: 'group', id: Number(key.slice(2)), title: row.dataset.title || '' });
  });
}

function renderGlobalChatroom() {
  const input = $('chatInput');
  const sendBtn = $('chatSendBtn');
  const c = $('chatMessages');
  if (!input || !sendBtn || !c) return;
  const g = globalChatState;

  if (!c.dataset.initialized) {
    c.dataset.initialized = 'true';
    chatInitGestures(c);
    c.addEventListener('scroll', () => {
      g.stick = chatNearBottom(c, 160);
      if (g.stick) g.unread = 0;
      chatUpdateJump();
    }, { passive: true });
    $('chatJump')?.addEventListener('click', () => { g.unread = 0; chatScrollToBottom(true); chatUpdateJump(); });
    $('chatPinBar')?.addEventListener('click', (e) => chatGoTo(e.currentTarget.dataset.goto));
    $('chatReplyCancel')?.addEventListener('click', chatCancelReply);
    sendBtn.addEventListener('click', chatSend);
    input.addEventListener('input', () => { chatAutosize(); chatUpdateComposer(); chatQueueDraftSave(); });
    input.addEventListener('keydown', (e) => {
      // Desktop: Enter sends, Shift+Enter breaks the line. Phones: Enter is a new line.
      if (e.key === 'Enter' && !e.shiftKey && window.matchMedia?.('(pointer: fine)').matches) { e.preventDefault(); chatSend(); }
    });
    input.addEventListener('focus', () => setTimeout(() => { if (g.stick !== false) chatScrollToBottom(false); }, 320));
    window.visualViewport?.addEventListener('resize', () => { if (chatTabActive() && g.stick !== false) chatScrollToBottom(false); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && chatLive()) chatStart(); });
    window.addEventListener('online', () => { if (chatLive()) { g.failures = 0; chatStart(); chatResendFailed(); } });
    window.addEventListener('offline', () => { if (chatLive()) { g.failures = Math.max(1, g.failures); chatUpdateHeader(); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) chatSaveView(); });
    $('chatBannerAd')?.addEventListener('click', chatWatchAd);
    $('chatBannerShop')?.addEventListener('click', () => { if (typeof openShop === 'function') openShop(); });
    $('chatEnergyChip')?.addEventListener('click', () => { if (typeof openShop === 'function') openShop(); });
    initChatProfileUi();
    initChatRoomsUi();
  }

  // The first time the tab opens, go back to where the member left off (a group or the global chat).
  if (!g.roomChosen) {
    g.roomChosen = true;
    const saved = chatSavedRoom();
    if (saved.type === 'group') { g.room = saved; chatUpdateHeader(); }
  }
  if (g.listOpen) {
    $('tab-chatroom').classList.add('show-list');
    chatPaintList();
    chatLoadList();
    return;
  }
  $('tab-chatroom').classList.remove('show-list');

  // Re-entering the tab shows what is already cached straight away.
  if (g.loaded) { chatRenderAll({ stick: true }); chatUpdateHeader(); chatUpdatePinBar(); }
  chatRestoreDraft();
  chatUpdateComposer();
  requestAnimationFrame(() => (g.loaded ? chatRestoreView() : chatScrollToBottom(false)));
  chatStart();
}

// ================= Predict: call the market, earn Energy =================
// The server prices every call from its own live feed and settles it; the app only says which
// coin, which direction and how long. Wins are collected with one atomic claim (paid once).
const prPrice = (p) => {
  const n = Number(p);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 3 })}`;
  return `$${n.toLocaleString(undefined, { maximumSignificantDigits: 4 })}`;
};
const prPct = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
const prHorizonLabel = (m) => (m >= 1440 ? `${m / 1440} day` : m >= 60 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} min`);
const prCoin = (id) => (predictState.markets ? predictState.markets.coins.find((c) => c.id === id) : null);
function prRemaining(endsAt) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 'Settling…';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
}

async function loadPredictMarkets() {
  try {
    predictState.markets = await api('GET', '/predict/markets', null, { retries: 0 });
    predictState.marketsError = '';
  } catch (e) {
    predictState.marketsError = e.status === 404 ? 'Predictions are not available yet — please update the app or try again later.' : (e.data?.code === 'PREDICT_PAUSED' ? 'Predictions are paused for now. Check back soon.' : (e.message || 'Could not load prices.'));
  }
  paintPredict();
}

async function loadPredictMine() {
  try {
    predictState.mine = await api('GET', '/predict/mine', null, { retries: 0 });
  } catch { /* keep what is shown */ }
  paintPredict();
  const c = predictState.mine && predictState.mine.claimable;
  if (c && c.count > 0) collectPredictWins();
}

async function loadPredictBoard() {
  try { predictState.board = await api('GET', '/predict/leaderboard', null, { retries: 0 }); } catch { /* optional */ }
  paintPredictBoard();
}

// Pays every winning call, once. The server flips a one-time flag per win, so a double-tap or a retry can never pay twice.
async function collectPredictWins() {
  if (predictState.claiming) return;
  predictState.claiming = true;
  try {
    const r = await api('POST', '/predict/claim', null, { retries: 0 });
    if (r.energy > 0) {
      adoptEnergy({ ...(state.energy || {}), energy: Number(r.balance) });
      renderEnergy();
      celebrate({ amount: r.energy, unit: 'Energy', icon: '📈', title: r.claimed > 1 ? `${r.claimed} predictions won!` : 'Prediction won!', subtitle: `You now have ${fmt(r.balance)} ⚡ total.`, duration: 2600 });
      const mine = await api('GET', '/predict/mine', null, { retries: 0 }).catch(() => null);
      if (mine) predictState.mine = mine;
      paintPredict();
    }
  } catch { /* tried again at the next refresh */ } finally { predictState.claiming = false; }
}

function paintPredictChart() {
  const box = $('prChart');
  const coin = prCoin(predictState.coin);
  if (!box || !coin) return;
  const dark = !!document.documentElement.dataset.dark;
  const symbol = coin.tv;
  const interval = PR_CHART_INTERVAL[predictState.horizon] || '60';
  const key = `${symbol}|${dark}|${interval}`;
  const link = $('prTvLink');
  if (link) link.href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
  if (predictState.lastChart === key && box.querySelector('iframe')) return;
  predictState.lastChart = key;
  // Low-end phones and data-saver mode load the chart only when asked (it is a full web page).
  if (typeof CHAT_LITE !== 'undefined' && CHAT_LITE && !predictState.chartOn) {
    box.innerHTML = '<button class="btn ghost pr-load-chart" type="button">Load live chart</button>';
    box.querySelector('button').addEventListener('click', () => { predictState.chartOn = true; predictState.lastChart = ''; paintPredictChart(); });
    return;
  }
  box.innerHTML = `<iframe title="${escapeHtml(coin.name)} live chart" src="${prChartSrc(symbol, dark, interval)}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>
    <div class="pr-chart-fallback" hidden>The live chart needs an internet connection.</div>`;
  if (navigator.onLine === false) box.querySelector('.pr-chart-fallback').hidden = false;
}

// A clean chart: no side or top toolbar, legend or volume bars, and the candle size follows the time frame.
const PR_CHART_INTERVAL = { 15: '5', 30: '15', 60: '30', 300: '60', 1440: '240' };
function prChartSrc(symbol, dark, interval) {
  return `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(symbol)}&interval=${interval}&theme=${dark ? 'dark' : 'light'}&style=1&locale=en`
    + '&hide_side_toolbar=1&hide_top_toolbar=1&hide_legend=1&hidevolume=1&allow_symbol_change=0&save_image=0&hideideas=1&withdateranges=0&timezone=Etc%2FUTC';
}

function openPredictFullChart() {
  const coin = prCoin(predictState.coin);
  const box = $('prFullChart');
  if (!coin || !box) return;
  const dark = !!document.documentElement.dataset.dark;
  $('prFullTitle').textContent = `${coin.name} · ${coin.id}`;
  $('prFullBody').innerHTML = `<iframe title="${escapeHtml(coin.name)} live chart, full screen" src="${prChartSrc(coin.tv, dark, PR_CHART_INTERVAL[predictState.horizon] || '60')}" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`;
  box.hidden = false;
  document.body.classList.add('pr-full-open');
}
function closePredictFullChart() {
  const box = $('prFullChart');
  if (!box || box.hidden) return false;
  box.hidden = true;
  $('prFullBody').innerHTML = '';
  document.body.classList.remove('pr-full-open');
  return true;
}

// ----- staking -----
const prStakeCfg = () => { const s = predictState.markets && predictState.markets.stakes; return s && s.enabled ? s : null; };
const prPayout = (stake, cfg) => Math.max(stake + 1, Math.round((stake * cfg.payoutPct) / 100));   // same rule as the server
function prClampStake(v) {
  const c = prStakeCfg();
  const n = Math.floor(Number(v));
  const lo = c ? c.min : 1;
  const hi = c ? c.max : 100;
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
// Small steps near the bottom, bigger ones higher up; going up then down returns to the same value.
function prStepStake(v, dir) {
  const step = dir > 0 ? (v >= 50 ? 10 : v >= 10 ? 5 : 1) : (v > 50 ? 10 : v > 10 ? 5 : 1);
  return prClampStake(v + dir * step);
}
function prSetStake(v, { repaint = true } = {}) {
  predictState.stake = prClampStake(v);
  try { localStorage.setItem('dltx_pr_stake', String(predictState.stake)); } catch { /* private mode */ }
  if (repaint) paintPredict();
}
const prEnergyNow = () => (state.energy && typeof state.energy.energy === 'number' ? state.energy.energy : null);

function paintPredict() {
  const p = predictState;
  const energy = prEnergyNow();
  const chip = $('prEnergy');
  if (chip) chip.textContent = energy == null ? '⚡ —' : `⚡ ${energy.toLocaleString()}`;

  const banner = $('prBanner');
  if (banner) {
    const msg = p.marketsError || (p.markets && (!p.markets.pricesAvailable ? 'Live prices are unavailable right now. Try again in a minute.' : p.markets.stale ? 'Prices look out of date — they will refresh shortly.' : ''));
    banner.hidden = !msg;
    banner.textContent = msg || '';
  }

  // coin chips
  const box = $('prCoins');
  if (box && p.markets) {
    const coins = p.markets.coins.filter((c) => p.filter === 'all' || c.dex);
    if (!coins.some((c) => c.id === p.coin) && coins.length) p.coin = coins[0].id;
    box.innerHTML = coins.map((c) => `
      <button type="button" class="pr-coin ${c.id === p.coin ? 'active' : ''}" data-coin="${c.id}" role="option" aria-selected="${c.id === p.coin}">
        <span class="pr-coin-top"><b>${c.id}</b>${c.dex ? '<i class="pr-dex">DEX</i>' : ''}</span>
        <span class="pr-coin-price">${prPrice(c.price)}</span>
        <span class="pr-coin-chg ${Number(c.change24h) >= 0 ? 'up' : 'down'}">${prPct(c.change24h) || '&nbsp;'}</span>
      </button>`).join('');
  }
  document.querySelectorAll('.pr-pill').forEach((b) => b.classList.toggle('active', b.dataset.filter === p.filter));

  // selected coin
  const coin = prCoin(p.coin);
  if (coin) {
    $('prCoinName').textContent = coin.name;
    $('prCoinSym').textContent = coin.id;
    $('prCoinPrice').innerHTML = `${prPrice(coin.price)} <small class="${Number(coin.change24h) >= 0 ? 'up' : 'down'}">${prPct(coin.change24h)} 24h</small>`;
    paintPredictChart();
  }

  const sc = prStakeCfg();
  if (p.markets && !p.horizonChosen && !p.markets.horizons.some((x) => x.minutes === p.horizon) && p.markets.horizons.length) p.horizon = p.markets.horizons[0].minutes;

  // time frames
  const hz = $('prHorizons');
  if (hz && p.markets) {
    hz.innerHTML = p.markets.horizons.map((h) => `<button type="button" class="pr-horizon ${h.minutes === p.horizon ? 'active' : ''}" data-h="${h.minutes}" role="radio" aria-checked="${h.minutes === p.horizon}"><b>${h.label}</b>${sc ? '' : `<span>+${h.reward} ⚡</span>`}</button>`).join('');
  }

  // stake picker
  const stakeBox = $('prStakeBox');
  if (stakeBox) stakeBox.hidden = !sc;
  const heroSub = $('prHeroSub');
  if (heroSub) heroSub.textContent = sc
    ? 'Pick a coin, choose how much Energy to stake, and call it UP or DOWN. Right call: you win. Wrong call: the stake is lost.'
    : 'Pick a coin, call it UP or DOWN, and earn Energy when you’re right. Free to play — no stake.';
  if (sc) {
    const input = $('prStake');
    if (input && document.activeElement !== input) input.value = String(p.stake);
    $('prStakeRange').textContent = `${sc.min}–${sc.max} ⚡`;
    $('prMinus').disabled = p.stake <= sc.min || p.busy;
    $('prPlus').disabled = p.stake >= sc.max || p.busy;
    const quickMax = Math.max(sc.min, Math.min(sc.max, energy == null ? sc.max : Math.floor(energy)));
    const quick = [5, 10, 25, 50].filter((v) => v >= sc.min && v <= sc.max);
    $('prQuick').innerHTML = quick.map((v) => `<button type="button" class="pr-chipq ${p.stake === v ? 'active' : ''}" data-q="${v}">${v}</button>`).join('')
      + `<button type="button" class="pr-chipq ${p.stake === quickMax && !quick.includes(quickMax) ? 'active' : ''}" data-q="${quickMax}">Max ${quickMax}</button>`;
    const payout = prPayout(prClampStake(p.stake), sc);
    const shown = prClampStake(p.stake);
    $('prPreview').innerHTML = `<span class="pr-win">Win <b>+${payout - shown} ⚡</b> <small>(${payout} back)</small></span><span class="pr-lose">Lose <b>−${shown} ⚡</b></span>`;
  }

  // call buttons + the reason they might be unavailable
  const mine = p.mine;
  const used = mine ? mine.used : 0;
  const perDay = (p.markets && p.markets.perDay) || (mine && mine.perDay) || 5;
  const open = mine ? mine.active.find((a) => a.coin === p.coin) : null;
  const short = sc && energy != null && energy < p.stake ? p.stake - energy : 0;
  const badStake = sc && !(Number.isInteger(p.stake) && p.stake >= sc.min && p.stake <= sc.max);
  let why = '';
  if (!p.markets || !p.markets.pricesAvailable || !coin || coin.price == null) why = 'Waiting for live prices…';
  else if (used >= perDay) why = `You’ve used all ${perDay} calls for today. New ones open at 00:00 UTC.`;
  else if (open) why = `You already have an open ${p.coin} call — it ends in ${prRemaining(open.endsAt)}.`;
  else if (badStake) why = `Choose between ${sc.min} and ${sc.max} Energy.`;
  else if (short) why = `You have ⚡ ${fmt(energy)} but this call needs ⚡ ${fmt(p.stake)} — ${fmt(short)} more to go.`;
  const h = p.markets ? p.markets.horizons.find((x) => x.minutes === p.horizon) : null;
  const ok = !why && !p.busy;
  $('prUp').disabled = !ok;
  $('prDown').disabled = !ok;
  const getBtn = $('prGetEnergy');
  if (getBtn) getBtn.hidden = !short;
  let hint = why;
  if (!hint && h) {
    hint = sc
      ? `${perDay - used} of ${perDay} calls left today. Moves under ${p.markets.minMovePct}% are a tie — your stake comes back.`
      : `Right call = +${h.reward} ⚡ Energy. ${perDay - used} of ${perDay} calls left today. Moves under ${p.markets.minMovePct}% are a tie (no win, no loss).`;
  }
  $('prHint').textContent = hint || '';

  paintPredictStats();
  paintPredictLists();
}

function paintPredictStats() {
  const box = $('prStats');
  const m = predictState.mine;
  if (!box) return;
  if (!m) { box.innerHTML = ''; return; }
  const s = m.stats;
  const cell = (v, l, cls = '') => `<div class="pr-stat ${cls}"><b>${v}</b><span>${l}</span></div>`;
  const net = Number(s.netEnergy) || 0;
  box.innerHTML = cell(s.wins, 'Wins') + cell(s.winRate == null ? '—' : `${s.winRate}%`, 'Win rate')
    + (prStakeCfg() ? cell(`${net > 0 ? '+' : ''}${net} ⚡`, 'Net Energy', net > 0 ? 'up' : net < 0 ? 'down' : '') : cell(s.streak ? `🔥 ${s.streak}` : '0', 'Streak'))
    + cell(`${m.used}/${m.perDay}`, 'Calls today');
}

function prStatusBadge(r) {
  const stake = Number(r.stake) || 0;
  if (r.status === 'won') return `<span class="pr-badge won">WON +${stake ? r.rewardEnergy - stake : r.rewardEnergy} ⚡</span>`;
  if (r.status === 'lost') return `<span class="pr-badge lost">LOST${stake ? ` −${stake} ⚡` : ''}</span>`;
  if (r.status === 'tie') return `<span class="pr-badge tie">TIE · ${stake ? `${stake} ⚡ back` : 'refunded'}</span>`;
  if (r.status === 'void') return `<span class="pr-badge void">VOID · ${stake ? `${stake} ⚡ back` : 'refunded'}</span>`;
  return '<span class="pr-badge open">OPEN</span>';
}

function paintPredictLists() {
  const m = predictState.mine;
  const act = $('prActive');
  const rec = $('prRecent');
  if (!act || !rec) return;
  if (!m) { act.innerHTML = '<p class="chat-hint">Loading…</p>'; return; }
  act.innerHTML = m.active.length ? m.active.map((a) => {
    const cur = prCoin(a.coin);
    const delta = cur && cur.price != null ? ((cur.price - a.entryPrice) / a.entryPrice) * 100 : null;
    const winning = delta != null && ((a.direction === 'up' && delta > 0) || (a.direction === 'down' && delta < 0));
    return `<div class="pr-row" data-ends="${escapeHtml(a.endsAt)}">
      <span class="pr-dir ${a.direction}">${a.direction === 'up' ? '▲' : '▼'}</span>
      <div class="pr-row-body"><b>${escapeHtml(a.coin)} ${a.direction.toUpperCase()} · ${prHorizonLabel(a.horizonMinutes)}</b>
        <span>Entry ${prPrice(a.entryPrice)}${delta == null ? '' : ` · now ${prPct(delta)}`}</span>
        ${a.stake ? `<span class="pr-row-stake">Stake ⚡ ${fmt(a.stake)} · win ⚡ ${fmt(a.potentialEnergy)}</span>` : ''}</div>
      <div class="pr-row-side"><span class="pr-eta">${prRemaining(a.endsAt)}</span>${delta == null ? '' : `<small class="${winning ? 'up' : 'down'}">${winning ? 'in the money' : 'behind'}</small>`}</div>
    </div>`;
  }).join('') : '<p class="chat-hint">No open calls. Pick a coin above and make one!</p>';
  rec.innerHTML = m.recent.length ? m.recent.map((r) => `<div class="pr-row">
      <span class="pr-dir ${r.direction}">${r.direction === 'up' ? '▲' : '▼'}</span>
      <div class="pr-row-body"><b>${escapeHtml(r.coin)} ${r.direction.toUpperCase()} · ${prHorizonLabel(r.horizonMinutes)}</b>
        <span>${prPrice(r.entryPrice)} → ${r.exitPrice == null ? 'no price' : prPrice(r.exitPrice)}${r.changePct == null ? '' : ` (${prPct(r.changePct)})`}</span></div>
      <div class="pr-row-side">${prStatusBadge(r)}</div>
    </div>`).join('') : '<p class="chat-hint">Your results will show up here.</p>';
}

function paintPredictBoard() {
  const box = $('prBoard');
  const b = predictState.board;
  if (!box) return;
  if (!b) { box.innerHTML = ''; return; }
  box.innerHTML = b.top.length ? b.top.map((r) => `<div class="pr-row ${r.me ? 'me' : ''}">
      <span class="pr-rank">${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</span>
      <div class="pr-row-body"><b>${escapeHtml(r.name)}${r.me ? ' (you)' : ''}</b><span>${r.wins} win${r.wins === 1 ? '' : 's'} of ${r.played} · ${r.winRate}%</span></div>
    </div>`).join('') + (b.me && !b.top.some((r) => r.me) ? `<p class="chat-hint">You’re #${b.me.rank} this week (${b.me.wins} of ${b.me.played}).</p>` : '')
    : '<p class="chat-hint">No settled calls yet this week — be the first on the board!</p>';
}

async function placePredict(direction) {
  const p = predictState;
  if (p.busy) return;
  const sc = prStakeCfg();
  if (sc && !(Number.isInteger(p.stake) && p.stake >= sc.min && p.stake <= sc.max)) { toast(`Choose between ${sc.min} and ${sc.max} Energy.`, { tone: 'error' }); return; }
  const stake = sc ? p.stake : undefined;
  p.busy = true;
  paintPredict();
  try {
    const r = await api('POST', '/predict', { coin: p.coin, direction, horizon: p.horizon, ...(sc ? { stake } : {}) }, { retries: 0 });
    const x = r.prediction;
    if (typeof r.energyRemaining === 'number') {
      adoptEnergy({ ...(state.energy || {}), energy: r.energyRemaining });
      renderEnergy();
    }
    toast(`${x.stake ? `⚡ ${fmt(x.stake)} staked: ` : ''}${x.coin} ${direction.toUpperCase()} for ${prHorizonLabel(x.horizonMinutes)} at ${prPrice(x.entryPrice)}. Good luck! 🍀`, { tone: 'success' });
    chatHaptic();
    const mine = await api('GET', '/predict/mine', null, { retries: 0 }).catch(() => null);
    if (mine) p.mine = mine;
  } catch (e) {
    if (e.code === 'INSUFFICIENT_ENERGY' && e.data) {
      toast(`You need ⚡ ${fmt(e.data.required)} for this call — you have ⚡ ${fmt(e.data.current)}. Get more Energy to continue.`, { tone: 'error' });
      loadEnergy(undefined, { force: true }).catch(() => {}).then(paintPredict);
    } else {
      toast(e.message || 'Could not place the call.', { tone: 'error' });
    }
    loadPredictMine();
  } finally {
    p.busy = false;
    paintPredict();
  }
}

function stopPredictPolling() {
  clearInterval(predictState.poll); predictState.poll = null;
  clearInterval(predictState.tick); predictState.tick = null;
}

function initPredictUi() {
  const root = $('tab-predict');
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';
  try { predictState.stake = Number(localStorage.getItem('dltx_pr_stake')) || predictState.stake; } catch { /* default */ }
  $('prCoins').addEventListener('click', (e) => { const b = e.target.closest('[data-coin]'); if (b) { predictState.coin = b.dataset.coin; paintPredict(); } });
  $('prHorizons').addEventListener('click', (e) => { const b = e.target.closest('[data-h]'); if (b) { predictState.horizon = Number(b.dataset.h); predictState.horizonChosen = true; paintPredict(); } });
  root.querySelector('.pr-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-filter]'); if (b) { predictState.filter = b.dataset.filter; paintPredict(); } });
  $('prUp').addEventListener('click', () => placePredict('up'));
  $('prDown').addEventListener('click', () => placePredict('down'));
  $('prEnergy').addEventListener('click', () => { if (typeof openShop === 'function') openShop(); });
  $('prGetEnergy').addEventListener('click', () => { if (typeof openShop === 'function') openShop(); });
  $('prMinus').addEventListener('click', () => prSetStake(prStepStake(predictState.stake, -1)));
  $('prPlus').addEventListener('click', () => prSetStake(prStepStake(predictState.stake, 1)));
  $('prQuick').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) prSetStake(Number(b.dataset.q)); });
  const input = $('prStake');
  // Digits only; the value is clamped when the member finishes typing, so a half-typed number is never rewritten under their thumb.
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D+/g, '').slice(0, 4);
    if (input.value !== '') { predictState.stake = Number(input.value); paintStakeDependents(); }
  });
  const commit = () => prSetStake(input.value === '' ? predictState.stake : input.value);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  $('prChartExpand').addEventListener('click', openPredictFullChart);
  $('prFullClose').addEventListener('click', closePredictFullChart);
}

// While typing: refresh the preview and the buttons without rewriting the field.
function paintStakeDependents() {
  const sc = prStakeCfg();
  if (!sc) return;
  const stake = predictState.stake;
  const valid = stake >= sc.min && stake <= sc.max;
  const payout = prPayout(prClampStake(stake), sc);
  const s = prClampStake(stake);
  $('prPreview').innerHTML = `<span class="pr-win">Win <b>+${payout - s} ⚡</b> <small>(${payout} back)</small></span><span class="pr-lose">Lose <b>−${s} ⚡</b></span>`;
  if (!valid) $('prHint').textContent = `Choose between ${sc.min} and ${sc.max} Energy.`;
  const energy = prEnergyNow();
  const blocked = !valid || (energy != null && energy < stake);
  if (blocked) { $('prUp').disabled = true; $('prDown').disabled = true; }
}

function renderPredict() {
  initPredictUi();
  stopPredictPolling();
  paintPredict();
  if (!state.energy && state.token && typeof loadEnergy === 'function') loadEnergy().then(paintPredict).catch(() => {});
  loadPredictMarkets().then(() => loadPredictMine());
  loadPredictBoard();
  // Prices and calls refresh every 30s — only while this screen is open and visible.
  predictState.poll = setInterval(() => {
    if (document.hidden || !$('tab-predict')?.classList.contains('active')) return;
    loadPredictMarkets();
    loadPredictMine();
  }, 30000);
  // A 1-second tick keeps the countdowns live without touching the network.
  predictState.tick = setInterval(() => {
    document.querySelectorAll('#prActive .pr-row[data-ends]').forEach((row) => {
      const eta = row.querySelector('.pr-eta');
      if (eta) eta.textContent = prRemaining(row.dataset.ends);
    });
  }, 1000);
}

function populateBookingPage() {
  // Track Real Flight using PNR/Booking Reference
  const flightTrackerForm = $('flightTrackerForm');
  if (flightTrackerForm) {
    flightTrackerForm.innerHTML = `
      <div class="flight-tracker-form">
        <h3>Track Your Real Flight</h3>
        <p class="form-subtitle">Enter your booking reference to track your actual flight</p>
        
        <div class="tracker-input-group">
          <input 
            type="text" 
            id="pnrInput" 
            placeholder="PNR / Booking Reference (e.g., ABC123)" 
            maxlength="10"
            class="pnr-input"
          />
          <input 
            type="text" 
            id="lastNameInput" 
            placeholder="Last Name on Ticket" 
            class="pnr-input"
          />
          <button class="btn primary track-flight-btn" id="trackFlightBtn">🔍 Track Flight</button>
        </div>
      </div>
    `;
    
    const trackBtn = $('trackFlightBtn');
    if (trackBtn) {
      trackBtn.addEventListener('click', () => {
        const pnr = $('pnrInput')?.value?.trim().toUpperCase();
        const name = $('lastNameInput')?.value?.trim();
        
        if (!pnr || !name) {
          alert('Please enter both PNR and last name');
          return;
        }
        
        trackBtn.disabled = true;
        trackBtn.textContent = '🔄 Loading...';
        
        // Simulate API call to real flight database
        setTimeout(() => {
          displayTrackedFlight(pnr, name);
          trackBtn.disabled = false;
          trackBtn.textContent = '🔍 Track Flight';
        }, 1000);
      });
    }
  }
  
  // Display tracked flight info
  function displayTrackedFlight(pnr, name) {
    const resultsContainer = $('flightTrackerResults');
    if (resultsContainer) {
      // Simulated real flight data
      const flightData = {
        pnr: pnr,
        name: name,
        airline: 'Air India',
        flightCode: 'AI 302',
        aircraft: 'Boeing 777-200LR',
        departure: {
          airport: 'DEL - Delhi',
          time: '14:30',
          actualTime: '14:35',
          terminal: 'Terminal 3'
        },
        arrival: {
          airport: 'MNL - Manila',
          time: '23:45',
          estimatedTime: '23:50',
          terminal: 'Terminal 2'
        },
        status: 'In Flight',
        currentPosition: {
          latitude: 15.8234,
          longitude: 96.1949,
          altitude: '38,500 ft',
          speed: '465 knots'
        },
        progress: 68,
        duration: '6h 15m',
        remaining: '2h 10m',
        passengers: {
          seat: '12A',
          name: name,
          boarding: 'Completed',
          mealService: 'Completed',
          nextService: 'Beverage Service in 15 min'
        }
      };
      
      resultsContainer.innerHTML = `
        <div class="real-flight-tracker">
          <div class="flight-header-real">
            <div class="airline-header">
              <div class="airline-name-real">${flightData.airline}</div>
              <div class="flight-code-real">${flightData.flightCode}</div>
            </div>
            <div class="flight-status-badge">${flightData.status} ✈️</div>
          </div>
          
          <div class="booking-reference">
            <span>PNR: ${flightData.pnr}</span>
            <span>Seat: ${flightData.passengers.seat}</span>
          </div>
          
          <div class="flight-route-real">
            <div class="city-info">
              <div class="city-time">${flightData.departure.time}</div>
              <div class="city-name">${flightData.departure.airport}</div>
              <div class="city-detail">${flightData.departure.terminal}</div>
            </div>
            
            <div class="route-visual">
              <div class="route-line-real">
                <div class="plane-icon">✈️</div>
                <div class="progress-container">
                  <div class="progress-bar-real">
                    <div class="progress-fill-real" style="width: ${flightData.progress}%"></div>
                  </div>
                  <div class="progress-text">${flightData.progress}% of journey</div>
                </div>
              </div>
            </div>
            
            <div class="city-info right">
              <div class="city-time">${flightData.arrival.estimatedTime}</div>
              <div class="city-name">${flightData.arrival.airport}</div>
              <div class="city-detail">${flightData.arrival.terminal}</div>
            </div>
          </div>
          
          <div class="flight-details-section">
            <h4>Current Position</h4>
            <div class="position-grid">
              <div class="position-item">
                <div class="position-label">Altitude</div>
                <div class="position-value">${flightData.currentPosition.altitude}</div>
              </div>
              <div class="position-item">
                <div class="position-label">Speed</div>
                <div class="position-value">${flightData.currentPosition.speed}</div>
              </div>
              <div class="position-item">
                <div class="position-label">Duration</div>
                <div class="position-value">${flightData.duration}</div>
              </div>
              <div class="position-item">
                <div class="position-label">Remaining</div>
                <div class="position-value">${flightData.remaining}</div>
              </div>
            </div>
          </div>
          
          <div class="passenger-info">
            <h4>Passenger Information</h4>
            <div class="info-row">
              <span>Name:</span>
              <span>${flightData.passengers.name}</span>
            </div>
            <div class="info-row">
              <span>Seat:</span>
              <span>${flightData.passengers.seat}</span>
            </div>
            <div class="info-row">
              <span>Boarding:</span>
              <span class="status-ok">${flightData.passengers.boarding}</span>
            </div>
            <div class="info-row">
              <span>Meal Service:</span>
              <span class="status-ok">${flightData.passengers.mealService}</span>
            </div>
            <div class="info-row">
              <span>Next:</span>
              <span>${flightData.passengers.nextService}</span>
            </div>
          </div>
          
          <div class="flight-map-placeholder">
            <div class="map-icon">🗺️</div>
            <div class="map-text">Live Flight Map</div>
            <div class="map-coords">Lat: ${flightData.currentPosition.latitude} | Lon: ${flightData.currentPosition.longitude}</div>
          </div>
        </div>
      `;
    }
  }
}

function populateStoresPage() {
  // P2B Marketplace Platforms - Real affiliate links that open in-app browser
  const marketplaces = [
    { icon: '🛒', name: 'eBay', desc: 'Buy & sell online', link: 'https://www.ebay.com/', refId: 'ebay' },
    { icon: '📦', name: 'Amazon', desc: 'Shop everything', link: 'https://www.amazon.com/', refId: 'amazon' },
    { icon: '🛍️', name: 'Shopify', desc: 'Shop independent stores', link: 'https://www.shopify.com/', refId: 'shopify' },
    { icon: '🏬', name: 'Walmart', desc: 'Save money everyday', link: 'https://www.walmart.com/', refId: 'walmart' },
    { icon: '⚡', name: 'Best Buy', desc: 'Tech & electronics', link: 'https://www.bestbuy.com/', refId: 'bestbuy' },
    { icon: '👗', name: 'Target', desc: 'Shop style & home', link: 'https://www.target.com/', refId: 'target' },
  ];
  
  const marketplaceGrid = $('marketplaceStoresGrid');
  if (marketplaceGrid) {
    marketplaceGrid.innerHTML = marketplaces.map(m => `
      <button class="integration-card" data-marketplace="${m.refId}" data-link="${m.link}" title="${m.name}">
        <div class="integration-card-icon">${m.icon}</div>
        <div class="integration-card-title">${m.name}</div>
        <div class="integration-card-status">${m.desc}</div>
      </button>
    `).join('');
    
    // Attach click listeners to open links in-app browser
    marketplaceGrid.querySelectorAll('.integration-card').forEach(card => {
      card.addEventListener('click', async (e) => {
        const link = card.dataset.link;
        const name = card.querySelector('.integration-card-title').textContent;
        if (link) {
          try {
            const cap = window.Capacitor;
            if (cap && cap.Plugins && cap.Plugins.Browser) {
              await cap.Plugins.Browser.open({ url: link });
            } else {
              window.open(link, '_blank');
            }
          } catch (err) {
            console.error('Error opening marketplace link:', err);
            window.open(link, '_blank');
          }
        }
      });
    });
  }
}

// ===== CEX Listings removed - not professional for this release =====

// Defer these to ensure original functions are defined
setTimeout(() => {
  if (window.showTab && typeof window.showTab === 'function') {
    const originalShowTab = window.showTab;
    window.showTab = function(tabId, opts) {
      if (originalShowTab) originalShowTab.call(this, tabId, opts);
      if (tabId === 'tab-wallet') { startWalletTimer(); }
      if (tabId === 'tab-social' || tabId === 'tab-booking' || tabId === 'tab-stores') {
        if (!window.newPagesPopulated) { populateNewPages(); window.newPagesPopulated = true; }
      }
    };
  }
  if (window.enterApp && typeof window.enterApp === 'function') {
    const originalEnterApp = window.enterApp;
    window.enterApp = function() {
      const entering = originalEnterApp.apply(this, arguments);
      startWalletTimer();
      startNextEarnTimer();
      if (!window.newPagesPopulated) { populateNewPages(); window.newPagesPopulated = true; }
      return entering;
    };
  }
  
  // KYC Verify Button Handler
  const kycVerifyBtn = $('kycVerifyBtn');
  if (kycVerifyBtn) {
    kycVerifyBtn.addEventListener('click', () => {
      const statusMsg = $('kycStatusMsg');
      if (statusMsg) {
        statusMsg.textContent = 'Opening Persona verification...';
      }
      // Show verification in progress
      kycVerifyBtn.disabled = true;
      kycVerifyBtn.textContent = 'Verifying... ⏳';
      
      // Simulate Persona.com KYC integration
      // In production, this would open Persona iframe or redirect to verification
      setTimeout(() => {
        alert('🛂 Persona Identity Verification\n\n' +
              'This will open a secure verification process.\n\n' +
              'You\'ll need to:\n' +
              '• Provide ID (passport, driver\'s license)\n' +
              '• Take a selfie\n' +
              '• Verify your address\n\n' +
              'Verification typically completes in 5-10 minutes.');
        
        // Reset button
        kycVerifyBtn.disabled = false;
        kycVerifyBtn.textContent = 'Verify Now →';
        if (statusMsg) {
          statusMsg.textContent = 'Connect Persona for instant verification';
        }
      }, 800);
    });
  }
}, 100);

