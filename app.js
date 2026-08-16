'use strict';

// In the native app shell (Capacitor) there is no same-origin backend —
// point at the production API instead.
const API = window.Capacitor ? 'https://app.deltixllc.com/api' : '/api';
const APP_VERSION = '1.1.0';
const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem('dltx_token') || null,
  email: null,
  validators: [],
  address: null,
  balances: null,
  hideBalances: localStorage.getItem('dltx_hide_balances') === '1',
  faucet: null,
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
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
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
    const r = await api('POST', '/auth/register', {
      email,
      ...(referralCode ? { referralCode } : {}),
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
  await Promise.all([loadWallet(), loadStats(), loadValidators(), loadStakes(), loadTx(), loadReferrals(), loadGovernance(), loadChain(), loadArcade(), refreshFaucetStatus()]);
}

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

    // 3-slot visual
    $('refSlots').innerHTML = Array.from({ length: r.maxDirect }, (_, i) =>
      `<div class="slot ${i < r.slotsUsed ? 'used' : ''}">${i < r.slotsUsed ? '✓' : i + 1}</div>`
    ).join('');
    $('refInfo').textContent =
      `${r.slotsLeft} of ${r.maxDirect} invites left · +${fmt(r.rewardPerActivation)} $DLTX when a referral keeps a stake of ${fmt(r.minStakeToActivate)}+ $DLTX · Earned so far: ${fmt(r.totalReferralRewards)} $DLTX`;

    // Referral list
    const list = $('refList');
    if (!r.referrals.length) {
      list.innerHTML = '<p class="muted center">No referrals yet. Share your code — up to three genuine participants.</p>';
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

// ---------- Faucet ----------
function showFaucetPopup({ title, message, showCountdown }) {
  $('faucetModalTitle').textContent = title;
  $('faucetModalMsg').textContent = message;
  const clock = $('faucetModalCountdown');
  clock.hidden = !showCountdown;
  if (showCountdown && state.faucet?.nextClaimAt) {
    clock.textContent = msToClock(Math.max(0, state.faucet.nextClaimAt - Date.now()));
  }
  $('faucetModal').hidden = false;
}
$('faucetModalOk').addEventListener('click', () => ($('faucetModal').hidden = true));

$('faucetBtn').addEventListener('click', async () => {
  const f = state.faucet;
  // Known-unavailable states — explain via popup without a round-trip.
  if (f?.limitReached) {
    showFaucetPopup({
      title: 'Faucet limit reached',
      message: `You have used all ${f.claimsMax} genesis faucet claims. Earn more $DLTX by staking, playing the Arcade, or inviting friends.`,
    });
    return;
  }
  if (f?.nextClaimAt && f.nextClaimAt > Date.now()) {
    showFaucetPopup({
      title: 'Already claimed',
      message: `You already claimed the faucet. Your next claim unlocks in:`,
      showCountdown: true,
    });
    return;
  }
  $('faucetBtn').style.pointerEvents = 'none';
  try {
    const r = await api('POST', '/wallet/faucet');
    if (r.nextClaimAt) state.faucet = { ...(state.faucet || {}), claimsUsed: r.claimsUsed, claimsMax: r.claimsMax, limitReached: r.claimsUsed >= r.claimsMax, nextClaimAt: r.nextClaimAt };
    toast(`+${fmt(r.amount)} $DLTX · faucet claim ${r.claimsUsed}/${r.claimsMax}`);
    renderFaucetCard();
    await Promise.all([loadWallet(), loadTx()]);
  } catch (e) {
    if (e.data?.code === 'FAUCET_COOLDOWN') {
      state.faucet = { ...(state.faucet || {}), nextClaimAt: e.data.nextClaimAt, claimsUsed: e.data.claimsUsed, claimsMax: e.data.claimsMax, limitReached: false };
      renderFaucetCard();
      showFaucetPopup({
        title: 'Already claimed',
        message: 'You already claimed the faucet. Your next claim unlocks in:',
        showCountdown: true,
      });
    } else if (e.data?.code === 'FAUCET_LIMIT') {
      state.faucet = { ...(state.faucet || {}), limitReached: true, claimsUsed: e.data.claimsUsed, claimsMax: e.data.claimsMax };
      renderFaucetCard();
      showFaucetPopup({
        title: 'Faucet limit reached',
        message: `You have used all ${e.data.claimsMax} genesis faucet claims. Earn more $DLTX by staking, playing the Arcade, or inviting friends.`,
      });
    } else {
      toast(e.message);
    }
  } finally {
    $('faucetBtn').style.pointerEvents = '';
  }
});

async function refreshFaucetStatus() {
  try {
    state.faucet = await api('GET', '/wallet/faucet/status');
    renderFaucetCard();
  } catch {
    /* non-critical */
  }
}

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
  $('sendHint').textContent = '';
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
]);
document.querySelectorAll('#dappGrid .dapp').forEach((d) =>
  d.addEventListener('click', () => {
    // Native in-app dApp pages (no external navigation)
    if (d.dataset.page) {
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
  frame.src = target;
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
  $('dbFrame').src = 'about:blank';
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
      const claims = Number(state.faucet?.claimsUsed || 0);
      const txCount = (state.txs || []).length;
      body.innerHTML = `
        <div class="feature-card">
          <div class="name">Deltix Collectibles</div>
          <div class="meta">On-chain achievement badges tied to your validator activity. Collectibles are
          utility rewards — they carry no monetary value and cannot be bought, sold, or transferred.</div>
        </div>
        ${collectibleCard({ icon: 'shield-blue.svg', name: 'Genesis Wallet', desc: 'Created a Deltix wallet on-chain.', earned: !!state.address })}
        ${collectibleCard({ icon: 'icon-faucet-tap.svg', name: 'First Claim', desc: 'Claimed $DLTX from the genesis faucet.', earned: claims > 0 })}
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
    `</div><h3 class="section-title">Latest blocks</h3><div id="expBlocks"></div>`;
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
// Google's official TEST ids. Swap for real unit ids once the AdMob account
// and Play listing are approved (see mobile-app/README.md).
// Real Deltix Network production ids (ready, currently unused while testing):
//   App:          ca-app-pub-6703659529197503~2016406742
//   Banner:       ca-app-pub-6703659529197503/5133524678
//   Interstitial: ca-app-pub-6703659529197503/1357931192
//   Rewarded:     ca-app-pub-6703659529197503/5850926156
const ADMOB_BANNER_ID = 'ca-app-pub-3940256099942544/6300978111';
const ADMOB_INTERSTITIAL_ID = 'ca-app-pub-3940256099942544/1033173712';
const ADMOB_REWARDED_ID = 'ca-app-pub-3940256099942544/5224354917';
const ADMOB_TESTING = true;
let adsReady = false;
let gamesSinceInterstitial = 0;
let lastInterstitialAt = 0;

async function initAds() {
  try {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
    const AdMob = cap.Plugins && cap.Plugins.AdMob;
    if (!AdMob) return;
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
    // Show banner at bottom: margin 0 positions it at the base; body.has-ad-banner elevates footer tabbar above it
    await cap.Plugins.AdMob.showBanner({
      adId: ADMOB_BANNER_ID,
      adSize: 'ADAPTIVE_BANNER',
      position: 'BOTTOM_CENTER',
      margin: 0,
      isTesting: ADMOB_TESTING,
    });
    document.body.classList.add('has-ad-banner');
  } catch {
    /* ignore ad errors */
  }
}
window.updateTabAd = updateTabAd;

// Faucet card — driven by real claim state from GET /wallet/faucet/status.
const padClock = (n) => String(n).padStart(2, '0');
function msToClock(ms) {
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${padClock(hrs)}:${padClock(mins)}:${padClock(secs)}`;
}
function renderFaucetCard() {
  const timerEl = $('faucetTimer');
  if (!timerEl) return;
  const f = state.faucet;
  if (!f) {
    timerEl.innerHTML = 'Tap to claim';
    return;
  }
  if (!f.enabled) {
    timerEl.textContent = 'Faucet retired by the DAO';
    return;
  }
  if (f.limitReached) {
    timerEl.textContent = `All ${f.claimsMax} claims used · earn via staking & Arcade`;
    return;
  }
  const msLeft = f.nextClaimAt ? f.nextClaimAt - Date.now() : 0;
  if (msLeft > 0) {
    timerEl.innerHTML = `Next claim in <span class="faucet-clock">⏱</span> <span id="faucetCountdown">${msToClock(msLeft)}</span> · ${f.claimsUsed}/${f.claimsMax} used`;
  } else {
    timerEl.innerHTML = `Ready to claim · ${f.claimsUsed || 0}/${f.claimsMax || 3} used`;
  }
}
function startFaucetTimer() {
  const tick = () => {
    if (state.token) renderFaucetCard();
    // Live countdown inside the "already claimed" popup, if open.
    const popupClock = $('faucetModalCountdown');
    if (popupClock && !$('faucetModal').hidden && state.faucet?.nextClaimAt) {
      const ms = Math.max(0, state.faucet.nextClaimAt - Date.now());
      popupClock.textContent = msToClock(ms);
      if (ms === 0) $('faucetModal').hidden = true;
    }
  };
  tick();
  setInterval(tick, 1000);
}

// ---------- Boot ----------
(async function boot() {
  if (!(await checkAppVersion())) return; // outdated client — blocked until update
  initAds();
  startFaucetTimer();
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
