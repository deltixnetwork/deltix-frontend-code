'use strict';

// In the native app shell (Capacitor) there is no same-origin backend —
// point at the production API instead.
const API = window.Capacitor ? 'https://app.deltixllc.com/api' : '/api';
const APP_VERSION = '1.2.4';
const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem('dltx_token') || null,
  email: localStorage.getItem('dltx_email') || null,
  refCode: null,
  avatar: localStorage.getItem('dltx_avatar') || '🦊',
  validators: [],
  address: null,
  balances: null,
  hideBalances: localStorage.getItem('dltx_hide_balances') === '1',
};

// ---------- API helper ----------
// Self-healing session: if the server ever reports the session/wallet as
// gone (stale token, or — in local dev — a server restart that wiped
// in-memory data), sign the user out and return to the sign-in screen
// instead of leaving stale cached numbers on screen.
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Deltix-Client': 'deltix-app',
      'X-App-Version': APP_VERSION,
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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
    if (staleSession && state.token) {
      state.token = null;
      localStorage.removeItem('dltx_token');
      showScreen('screen-email');
      toast('Your session has expired — please sign in again.');
    }
    const err = new Error(json.error || 'Request failed');
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
// Re-check whenever the app returns to the foreground.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkAppVersion();
});

// ---------- UI helpers ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  const authed = id === 'screen-main';
  $('topbar').hidden = !authed;
  $('tabbar').hidden = !authed;
  if (!authed) {
    document.body.classList.remove('has-ad-banner');
    const cap = window.Capacitor;
    if (cap?.Plugins?.AdMob) cap.Plugins.AdMob.hideBanner().catch(() => {});
  } else {
    updateTabAd();
  }
}
function showTab(id) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  $(id).classList.add('active');
  document.querySelectorAll('.tabbtn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === id)
  );
  updateTabAd(id);
  if (id === 'tab-energy') renderEnergy();
}
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
const fmt = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });

// ---------- Auth flow ----------
$('ageGate').addEventListener('change', () => {
  $('sendCodeBtn').disabled = !$('ageGate').checked;
});
$('sendCodeBtn').addEventListener('click', async () => {
  const email = $('emailInput').value.trim().toLowerCase();
  const hint = $('emailHint');
  hint.className = 'hint';
  if (!$('ageGate').checked) {
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
    const referralCode = $('refCodeInput').value.trim().toUpperCase();
    const integrityPayload = await getIntegrityPayload();
    const r = await api('POST', '/auth/register', {
      email,
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
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('sendCodeBtn').disabled = false;
  }
});

$('backToEmail').addEventListener('click', () => showScreen('screen-email'));

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
  state.token = null;
  localStorage.removeItem('dltx_token');
  localStorage.removeItem('dltx_email');
  showScreen('screen-email');
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
    state.token = null;
    localStorage.removeItem('dltx_token');
    localStorage.removeItem('dltx_email');
    showScreen('screen-email');
    toast('Account permanently deleted');
  } catch (e) {
    hint.textContent = e.message;
    hint.classList.add('error');
  } finally {
    $('confirmDelete').disabled = false;
  }
});

// ---------- Tabs ----------
document.querySelectorAll('.tabbtn').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab))
);

// ---------- Data loading ----------
async function enterApp() {
  showScreen('screen-main');
  showTab('tab-wallet');
  // Recover the email from the JWT for sessions that signed in before we
  // started persisting it (so the profile never shows a blank email).
  if (!state.email && state.token) {
    state.email = emailFromToken(state.token);
    if (state.email) localStorage.setItem('dltx_email', state.email);
  }
  renderProfile();
  await Promise.all([loadWallet(), loadStats(), loadValidators(), loadStakes(), loadTx(), loadReferrals(), loadGovernance(), loadChain(), loadArcade()]);
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
const AVATAR_CHOICES = ['🦊','🐼','🐯','🦁','🐸','🐵','🐨','🐧','🦉','🐙','🐝','🦄','🐳','🦖','👾','🤖','👽','🎮','⚡','🔥','🌟','💎'];
// Premium avatars: unlocked via an opt-in rewarded ad. The unlock is a
// non-transferable cosmetic on this account — the AdMob-compliant reward.
const PREMIUM_AVATARS = ['🐉','🦅','🧙','🥷','👑','🛸'];
function unlockedAvatars() {
  try { return JSON.parse(localStorage.getItem('dltx_avatar_unlocked') || '[]'); } catch { return []; }
}

// Premium app themes: same AdMob-compliant model — an opt-in rewarded ad
// unlocks a non-transferable cosmetic color theme (never $DLTX).
const THEMES = [
  { id: 'classic', name: 'Classic', free: true },
  { id: 'emerald', name: 'Emerald', free: false },
  { id: 'sunset',  name: 'Sunset',  free: false },
  { id: 'royal',   name: 'Royal',   free: false },
];
function unlockedThemes() {
  try { return JSON.parse(localStorage.getItem('dltx_theme_unlocked') || '[]'); } catch { return []; }
}
function applyTheme(id) {
  if (!THEMES.some((t) => t.id === id)) id = 'classic';
  if (id === 'classic') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
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
        const u = unlockedThemes();
        u.push(id);
        localStorage.setItem('dltx_theme_unlocked', JSON.stringify(u));
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
        const u = unlockedAvatars();
        u.push(emoji);
        localStorage.setItem('dltx_avatar_unlocked', JSON.stringify(u));
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

async function loadWallet() {
  try {
    const w = await api('GET', '/wallet');
    state.address = w.address;
    state.balances = w;
    renderBalances();
    const addr = $('walletAddress');
    addr.onclick = () => {
      navigator.clipboard?.writeText(state.address);
      toast('Address copied');
    };
  } catch (e) {
    if (/token/i.test(e.message)) return $('logoutBtn').click();
    toast(e.message);
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

async function loadStats() {
  try {
    const s = await api('GET', '/network/stats');
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
  const r = await api('GET', '/network/validators');
  state.validators = r.validators;
  const list = $('validatorList');
  list.innerHTML = r.validators
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
}

async function loadStakes() {
  const r = await api('GET', '/staking');
  const el = $('myStakes');
  const active = r.stakes.filter((s) => s.status === 'active');
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
}

async function loadTx() {
  const r = await api('GET', '/wallet/transactions');
  state.txs = r.transactions;
  const el = $('txList');
  if (!r.transactions.length) {
    el.innerHTML = '<p class="muted center">No activity yet.</p>';
    return;
  }
  const negatives = ['stake', 'send', 'treasury_burn'];
  el.innerHTML = r.transactions
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
}

// ---------- Referrals + Ambassador program ----------
async function loadReferrals() {
  try {
    const r = await api('GET', '/referrals');

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
      ['Unbonding', 'Applies on unstake'],
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
    toast(`Claimed ${fmt(r.rewardsPaid)} $DLTX`);
    await Promise.all([loadWallet(), loadStakes(), loadTx()]);
  } catch (e) {
    toast(e.message);
  }
}
async function unstake(id) {
  try {
    const r = await api('POST', `/staking/${id}/unstake`);
    toast(`Unstaked ${fmt(r.returnedPrincipal)} + ${fmt(r.rewardsPaid)} rewards`);
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
  const negatives = ['stake', 'send', 'treasury_burn'];
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
const ADS_ENABLED = false; // policy hold default: ship ad-free unless explicitly re-enabled
const ADMOB_TESTING = false; // PRODUCTION BUILD: live AdMob creatives — flip to true for test-ads builds
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
  { name: 'Deltix Soldier',   min: 1,    max: 49,       c: ['#94a3b8', '#475569'] },
  { name: 'Deltix Inspector', min: 50,   max: 100,      c: ['#4ade80', '#15803d'] },
  { name: 'Deltix Guardian',  min: 101,  max: 250,      c: ['#60a5fa', '#1d4ed8'] },
  { name: 'Deltix Captain',   min: 251,  max: 500,      c: ['#c084fc', '#6d28d9'] },
  { name: 'Deltix Major',     min: 501,  max: 1000,     c: ['#f87171', '#991b1b'] },
  { name: 'Deltix Commander', min: 1001, max: 2500,     c: ['#38bdf8', '#1e40af'] },
  { name: 'Deltix Elite',     min: 2501, max: 4000,     c: ['#f472b6', '#a21caf'] },
  { name: 'Deltix Legend',    min: 4001, max: Infinity, c: ['#fbbf24', '#b45309'] },
];
function energyState() {
  return {
    energy: parseInt(localStorage.getItem('dltx_energy') || '0', 10) || 0,
    streak: parseInt(localStorage.getItem('dltx_energy_streak') || '0', 10) || 0,
    last: localStorage.getItem('dltx_energy_last') || '',
  };
}
function rankForEnergy(e) {
  for (let i = ENERGY_RANKS.length - 1; i >= 0; i--) if (e >= ENERGY_RANKS[i].min) return { rank: ENERGY_RANKS[i], index: i };
  return { rank: ENERGY_RANKS[0], index: 0 };
}
function renderEnergy() {
  const st = energyState();
  const { rank, index } = rankForEnergy(st.energy);
  const next = ENERGY_RANKS[index + 1] || null;
  const base = rank.min <= 1 ? 0 : rank.min;
  const shield = $('ercShield');
  if (shield) shield.style.background = `linear-gradient(150deg, ${rank.c[0]}, ${rank.c[1]})`;
  const set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  set('ercRankName', rank.name);
  set('ercEnergy', fmt(st.energy));
  set('eecMeta', `Energy: ${fmt(st.energy)}`);
  const fill = $('ercBarFill');
  if (next) {
    const pct = Math.max(0, Math.min(100, ((st.energy - base) / (next.min - base)) * 100));
    if (fill) fill.style.width = pct + '%';
    set('ercNext', `Next rank: ${next.name}`);
    set('ercRange', `${fmt(st.energy)} / ${fmt(next.min)}`);
  } else {
    if (fill) fill.style.width = '100%';
    set('ercNext', 'Max rank reached 🏆');
    set('ercRange', `${fmt(st.energy)} Energy`);
  }
  const grid = $('energyRanksGrid');
  if (grid) grid.innerHTML = ENERGY_RANKS.map((rk, i) => `
    <div class="energy-rank ${i === index ? 'current' : ''}">
      <div class="er-badge" style="background:linear-gradient(150deg,${rk.c[0]},${rk.c[1]})">D</div>
      <div class="er-name">${rk.name.replace('Deltix ', '')}</div>
      <div class="er-range">${rk.max === Infinity ? rk.min + '+' : rk.min + '\u2013' + rk.max}</div>
      <div class="er-rate">+1 Energy / Ad</div>
    </div>`).join('');
  set('efStreakSub', st.streak > 0 ? `${st.streak}-day streak 🔥` : 'Build streaks, earn bonus Energy');
}
async function earnEnergy(btn) {
  if (window.ADS_ENABLED === false) { toast('Ads are temporarily unavailable — please try again later.'); return; }
  if (btn) btn.disabled = true;
  try {
    const earned = await playRewardedAd();
    if (!earned) { toast('Ad not completed — no Energy earned.'); return; }
    const st = energyState();
    const today = new Date().toISOString().slice(0, 10);
    if (st.last !== today) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const streak = st.last === yesterday ? st.streak + 1 : 1;
      localStorage.setItem('dltx_energy_streak', String(streak));
      localStorage.setItem('dltx_energy_last', today);
    }
    localStorage.setItem('dltx_energy', String(st.energy + 1));
    renderEnergy();
    toast('+1 Energy ⚡');
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
    } else {
      toast('Coming soon 🚀');
    }
  })
);

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
  if (!(await checkAppVersion())) return; // outdated client — blocked until update
  initAds();
  if (state.token) {
    try {
      await enterApp();
      return;
    } catch {
      localStorage.removeItem('dltx_token');
      state.token = null;
    }
  }
  showScreen('screen-email');
})();
