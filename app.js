'use strict';

// In the native app shell (Capacitor) there is no same-origin backend —
// point at the production API instead.
const API = window.Capacitor ? 'https://app.deltixllc.com/api' : '/api';
const APP_VERSION = '1.1.0';
const $ = (id) => document.getElementById(id);
const state = { token: localStorage.getItem('dltx_token') || null, email: null, validators: [] };

// ---------- API helper ----------
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
  if (!res.ok) throw new Error(json.error || 'Request failed');
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
      $('updateReloadBtn').onclick = () => location.reload(true);
      return false;
    }
  } catch {
    /* offline or server unreachable — do not lock the user out */
  }
  return true;
}

// ---------- UI helpers ----------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  const authed = id === 'screen-main';
  $('topbar').hidden = !authed;
  $('tabbar').hidden = !authed;
}
function showTab(id) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  $(id).classList.add('active');
  document.querySelectorAll('.tabbtn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === id)
  );
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
  await Promise.all([loadWallet(), loadStats(), loadValidators(), loadStakes(), loadTx(), loadReferrals(), loadGovernance(), loadChain(), loadArcade()]);
}

async function loadWallet() {
  try {
    const w = await api('GET', '/wallet');
    $('totalBalance').innerHTML = `${fmt(w.totalValue)} <small>$DLTX</small>`;
    $('liquidBalance').textContent = fmt(w.balance);
    $('stakedBalance').textContent = fmt(w.stakedBalance);
    $('pendingRewards').textContent = fmt(w.pendingRewards);
    const addr = $('walletAddress');
    addr.textContent = w.address;
    addr.onclick = () => {
      navigator.clipboard?.writeText(w.address);
      toast('Address copied');
    };
  } catch (e) {
    if (/token/i.test(e.message)) return $('logoutBtn').click();
    toast(e.message);
  }
}

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
    .map((v) => {
      const apy = (0.08 * (1 - v.commission) * 100).toFixed(1);
      return `
      <div class="validator">
        <div>
          <div class="name">${v.name}</div>
          <div class="meta">Commission ${(v.commission * 100).toFixed(0)}% · Uptime ${v.uptime}% · Staked ${fmt(v.total_staked)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="apy-badge">~${apy}% APY</span>
          <button class="mini-btn" data-validator="${v.id}" data-name="${v.name}">Delegate</button>
        </div>
      </div>`;
    })
    .join('');
  list.querySelectorAll('.mini-btn').forEach((btn) =>
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
      (s) => `
    <div class="stake-card">
      <div>
        <div class="name">${s.validator}</div>
        <div class="meta">${fmt(s.amount)} $DLTX · ${(s.apy * 100).toFixed(1)}% APY · x${s.multiplier.toFixed(2)}<br/>Rewards: ${fmt(s.pendingRewards)} $DLTX</div>
      </div>
      <div class="stake-actions">
        <button class="mini-btn ghost" data-claim="${s.id}">Claim</button>
        <button class="mini-btn" data-unstake="${s.id}">Unstake</button>
      </div>
    </div>`
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
    $('daoMeta').textContent =
      `The DAO decides protocol changes by stake-weighted vote — 1 staked $DLTX = 1 vote. ` +
      `Your voting power: ${fmt(g.votingPower)} $DLTX. ` +
      `Proposing requires ${fmt(g.dao.minStakeToPropose)}+ $DLTX staked · voting period ${g.dao.votingPeriodDays} days · quorum ${fmt(g.dao.quorumVotes)} voted stake.`;

    const list = $('daoList');
    if (!g.proposals.length) {
      list.innerHTML = '<p class="muted center">No proposals yet — submit the first one below.</p>';
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
    const [info, blocks] = await Promise.all([
      api('GET', '/chain/info'),
      api('GET', '/chain/blocks?limit=6'),
    ]);
    $('chainInfo').innerHTML = [
      ['Chain', info.chainId],
      ['Height', '#' + info.height],
      ['Latest hash', info.latestHash.slice(0, 18) + '…'],
      ['Block time', info.blockTimeMs / 1000 + 's'],
      ['Total txs on chain', info.totalTxs],
      ['Pending txs', info.pendingTxs],
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
$('faucetBtn').addEventListener('click', async () => {
  $('faucetBtn').disabled = true;
  try {
    const r = await api('POST', '/wallet/faucet');
    toast(`+${fmt(r.amount)} $DLTX · faucet claim ${r.claimsUsed}/${r.claimsMax}`);
    await Promise.all([loadWallet(), loadTx()]);
  } catch (e) {
    toast(e.message);
  } finally {
    $('faucetBtn').disabled = false;
  }
});

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
  const addr = $('walletAddress').textContent;
  navigator.clipboard?.writeText(addr);
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
const ALLOWED_DAPP_HOSTS = new Set([
  'app.uniswap.org', 'opensea.io', 'aave.com', 'snapshot.org', 'etherscan.io', 'web3.storage',
]);
document.querySelectorAll('#dappGrid .dapp').forEach((d) =>
  d.addEventListener('click', () => {
    let url;
    try {
      url = new URL(d.dataset.url);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' || !ALLOWED_DAPP_HOSTS.has(url.hostname)) return;
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
});

/** Open a dApp inside the app: native in-app browser sheet on device, overlay browser on web. */
function openDBrowser(url, name) {
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
    const B = cap.Plugins && cap.Plugins.Browser;
    if (B && B.open) {
      B.open({ url, toolbarColor: '#ffffff' });
      return;
    }
    window.open(url, '_blank', 'noopener');
    return;
  }
  $('dbName').textContent = name || 'dApp';
  $('dbHost').textContent = '🔒 ' + new URL(url).hostname;
  const loading = $('dbLoading');
  loading.hidden = false;
  loading.innerHTML = '◆ Connecting securely…';
  const frame = $('dbFrame');
  frame.dataset.url = url;
  frame.src = url;
  let loaded = false;
  frame.onload = () => {
    loaded = true;
    loading.hidden = true;
  };
  // Many dApps refuse to be embedded (X-Frame-Options) — offer the system browser.
  setTimeout(() => {
    if (loaded) return;
    loading.innerHTML = `<div class="db-blocked">
      <div class="db-blocked-icon">🛡</div>
      <b>${name || 'This dApp'} blocks embedded browsing</b>
      <p>For your security it only runs in a full browser tab.</p>
      <button class="btn primary" id="dbBlockedOpen">Open ${new URL(url).hostname} ↗</button>
    </div>`;
    document.getElementById('dbBlockedOpen').onclick = () => window.open(url, '_blank', 'noopener');
  }, 5000);
  $('dbrowser').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeDBrowser() {
  $('dbFrame').src = 'about:blank';
  $('dbrowser').hidden = true;
  document.body.style.overflow = '';
}
$('dbClose').addEventListener('click', closeDBrowser);
$('dbExternal').addEventListener('click', () => {
  const url = $('dbFrame').dataset.url;
  if (url) window.open(url, '_blank', 'noopener');
});
$('dbOpenExt').addEventListener('click', () => {
  const url = $('dbFrame').dataset.url;
  if (url) window.open(url, '_blank', 'noopener');
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
  expGo(view || { v: 'home' });
}
function closeExplorer() {
  $('explorer').hidden = true;
  document.body.style.overflow = '';
  exp.stack = [];
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

// ---------- Boot ----------
(async function boot() {
  if (!(await checkAppVersion())) return; // outdated client — blocked until update
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
