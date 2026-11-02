'use strict';

// ---------- Native $DLTX migration: claim flow, freeze banner, native balance ----------
// Server-driven: GET /api/migration/status says whether migration claims are enabled (and for which
// chain), whether the application-level balance freeze is on, and where the native chain's public REST
// endpoint is (empty until a network exists). Nothing here moves funds: a claim only binds this account
// to ONE native `dltx1…` address through an ADR-36 signature over a server challenge. Keys are generated
// on the device by the wallet SDK bundle (vendor/deltix-wallet-sdk.js, loaded on first use) and never
// leave it; the recovery phrase is shown once and, only if the member asks, kept on the device encrypted
// with a password of their choosing (scrypt + AES-256-GCM, see deltix-wallet/src/webCryptoStore.js).
//
// Uses app.js globals: api, $, state, toast, askConfirm, loadScriptOnce, copyText, escapeHtml.

const MIG_SDK_SRC = 'vendor/deltix-wallet-sdk.js';
const MIG_MIN_PASSWORD = 10;
const MIG_KEYSTORE_PREFIX = 'deltix-keystore:';   // same constant as the SDK (KEYSTORE_KEY_PREFIX)
const MIG_PATH_PREFIX = 'deltix-claim-path:';     // which wallet slot (HD path) of the phrase a linked address uses
const MIG_SLOTS = 10;                              // slots offered in the picker (1..10); the device cap is 4 accounts
const MIG_SCAN_SLOTS = 20;                         // slots tried when restoring a linked address from a phrase
const MIG_REST_TIMEOUT_MS = 12000;

const migState = {
  status: null,      // last /migration/status payload
  claim: null,       // the account's active claim { address, chainId, createdAt } or null
  native: null,      // { amount: string (DLTX), at } | { error: true } | null
  step: null,
  mnemonic: null,    // only while the flow is open; cleared on close
  wallet: null,      // unlocked SDK wallet while the flow is open; destroy()ed on close
  network: null,
  slot: 0,           // 0-based wallet slot of the phrase (hdPathForAccount(slot)); shown 1-based
  challenge: null,   // { nonce, message, expiresAt } for the sign step
  expectAddress: null, // restore flow: the phrase must derive this address
  busy: false,
};

const migShort = (a) => (a && a.length > 20 ? `${a.slice(0, 11)}…${a.slice(-6)}` : a || '');
const migKeystoreId = (address) => `claim-${address}`;
const migHasKeystore = (address) => !!address && localStorage.getItem(MIG_KEYSTORE_PREFIX + migKeystoreId(address)) !== null;
const migSavedPath = (address) => (address ? localStorage.getItem(MIG_PATH_PREFIX + address) : null);
const migSavePath = (address, hdPath) => { try { localStorage.setItem(MIG_PATH_PREFIX + address, hdPath); } catch { /* storage full: the restore scan finds it again */ } };
/** "slot 3 · m/44'/118'/2'/0/0" for a path produced by hdPathForAccount; a custom path is shown as-is. */
function migSlotLabel(hdPath) {
  const m = /^m\/44'\/\d+'\/(\d+)'\/0\/0$/.exec(hdPath || '');
  return m ? `wallet slot ${Number(m[1]) + 1} · ${hdPath}` : (hdPath || 'unknown slot');
}

async function migSdk() {
  await loadScriptOnce(MIG_SDK_SRC);
  if (!window.DeltixWalletSdk) throw new Error('The wallet module could not be loaded. Check your connection and try again.');
  return window.DeltixWalletSdk;
}

/** Network profile for the chain the server accepts claims for (mainnet ids only reach the app once the owner allowed them). */
function migNetwork(sdk) {
  const c = migState.status && migState.status.claims;
  if (!c || !c.enabled) throw new Error('Migration claims are not open right now.');
  return sdk.defineNetwork({ kind: c.kind, chainId: c.chainId, prefix: c.prefix || 'dltx', approved: true });
}

// ---------- status, banner, card ----------

async function loadMigrationStatus() {
  if (!state.token) return;
  let s;
  try {
    s = await api('GET', '/migration/status');
  } catch {
    return; // older backend or offline: leave the card as it is
  }
  migState.status = s;
  renderMigrationBanner(s.freeze);
  if (s.claims && s.claims.enabled) {
    try {
      const r = await api('GET', '/migration-claims/status');
      migState.claim = (r && r.claim) || null;
    } catch (e) {
      if (e.status !== 404) console.warn('migration claim status:', e.message);
      migState.claim = null;
    }
  } else {
    migState.claim = null;
  }
  renderMigrationCard();
  if (migState.claim && s.l1 && s.l1.live) loadNativeBalance();
}

function renderMigrationBanner(freeze) {
  const el = $('migrationBanner');
  if (!el) return;
  if (!freeze || !freeze.on) { el.hidden = true; return; }
  let text = freeze.message || '';
  if (freeze.until) {
    const t = new Date(freeze.until);
    if (!Number.isNaN(t.getTime())) text += ` Expected to end around ${t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`;
  }
  $('migrationBannerMsg').textContent = text;
  el.hidden = false;
}

/** Any API refusal with code MIGRATION_FREEZE paints the banner at once (app.js calls this). */
function onMigrationFreezeError(json) {
  renderMigrationBanner({ on: true, message: (json && json.error) || '', until: json && json.until });
}

/**
 * The "Mainnet checklist" shown at the top of the card (Pi-style): four steps with a tick, the current one
 * highlighted. Step 1 is always done for a signed-in member (claims need a verified, active account);
 * steps 2 and 3 are done once a claim exists (the flow enforces the backup before linking); step 4 is the
 * genesis allocation, reported done once the native balance is visible on a live chain.
 */
function migChecklistHtml({ claim, l1, stored, native }) {
  const migrated = Boolean(claim && l1 && l1.live && native && !native.error && native.amount && native.amount !== '0');
  const steps = [
    { title: 'Account verified', note: 'Your e-mail is verified. Deltix KYC is only needed for the P2P market, not for the migration.', done: true },
    { title: 'Native wallet backed up', note: claim ? (stored ? 'Recovery phrase written down; an encrypted copy is on this phone.' : 'Recovery phrase written down (paper only on this phone).') : 'Create or import a wallet and write down its 24-word recovery phrase.', done: Boolean(claim) },
    { title: 'Address linked to this account', note: claim ? `${migShort(claim.address)} — one address per account; cannot be changed from the app.` : 'Sign a short message that proves the address is yours. Nothing moves.', done: Boolean(claim) },
    { title: 'Balance migrated at genesis', note: migrated ? `${native.amount} DLTX on the Deltix chain.` : 'Your balance at the snapshot is created at this address when the Deltix chain starts. Date announced in advance.', done: migrated },
  ];
  const current = steps.findIndex((s) => !s.done);
  return `<ol class="mig-check">${steps.map((s, i) => `
    <li class="${s.done ? 'done' : i === current ? 'current' : ''}">
      <span class="mig-check-ic" aria-hidden="true">${s.done ? '✓' : i + 1}</span>
      <span class="mig-check-txt"><b>${escapeHtml(s.title)}</b><small>${escapeHtml(s.note)}</small></span>
    </li>`).join('')}</ol>`;
}

function renderMigrationCard() {
  const card = $('migrationCard');
  if (!card) return;
  const s = migState.status;
  const claims = s && s.claims;
  if (!claims || !claims.enabled) { card.hidden = true; return; }
  card.hidden = false;
  const body = $('migrationCardBody');
  const pill = $('migrationPill');
  const sub = $('migrationCardSub');
  const claim = migState.claim;
  const l1 = (s && s.l1) || {};
  const chainId = escapeHtml(claims.chainId);
  if (!claim) {
    pill.textContent = 'Step 2 of 4';
    pill.className = 'mig-pill';
    sub.textContent = 'Mainnet checklist: link one native Deltix address to receive your balance on the Deltix chain at genesis. Nothing moves now.';
    body.innerHTML = `
      ${migChecklistHtml({ claim: null, l1, stored: false, native: null })}
      <div class="mig-row"><span class="k">Chain</span><span class="v mono">${chainId}</span></div>
      <div class="mig-actions">
        <button class="btn primary" type="button" id="migStartBtn">Link a native address →</button>
      </div>
      <p class="mig-note">You create (or import) a native wallet on this phone, write down its 24-word recovery phrase and sign a short message that proves the address is yours. Deltix never sees the phrase or the key. Several accounts? One phrase, a different wallet slot per account.</p>`;
    $('migStartBtn').onclick = () => openMigrationModal('intro');
    return;
  }
  const address = escapeHtml(claim.address);
  const stored = migHasKeystore(claim.address);
  const savedPath = migSavedPath(claim.address);
  const migrated = Boolean(l1.live && migState.native && !migState.native.error && migState.native.amount && migState.native.amount !== '0');
  pill.textContent = migrated ? 'Migrated' : 'Step 4 of 4';
  pill.className = 'mig-pill linked';
  sub.textContent = migrated
    ? 'Your balance is on the Deltix chain at the address you linked. Keep the recovery phrase safe — it is the only key.'
    : 'Your legacy balance will be allocated to this address at genesis. Keep the recovery phrase safe — it is the only key.';
  let balance;
  if (!l1.live) balance = '<span class="v">chain not live yet</span>';
  else if (!migState.native) balance = '<span class="v">loading…</span>';
  else if (migState.native.error) balance = '<span class="v">unavailable right now</span>';
  else balance = `<span class="v">${escapeHtml(migState.native.amount)} DLTX</span>`;
  const n = migState.native && !migState.native.error ? migState.native : null;
  const stakingRows = n && n.staked !== undefined ? `
    <div class="mig-row"><span class="k">Staked on chain</span><span class="v">${escapeHtml(n.staked)} DLTX</span></div>
    <div class="mig-row"><span class="k">Staking rewards</span><span class="v">${escapeHtml(n.rewards)} DLTX</span></div>
    ${n.unbonding !== '0' ? `<div class="mig-row"><span class="k">Unbonding</span><span class="v">${escapeHtml(n.unbonding)} DLTX</span></div>` : ''}` : '';
  body.innerHTML = `
    ${migChecklistHtml({ claim, l1, stored, native: migState.native })}
    <div class="mig-row"><span class="k">Chain</span><span class="v mono">${escapeHtml(claim.chainId || claims.chainId)}</span></div>
    <div class="mig-row"><span class="k">Linked address</span><span class="v mono" title="${address}">${escapeHtml(migShort(claim.address))}</span></div>
    <div class="mig-row"><span class="k">Phrase slot</span><span class="v mono">${savedPath ? escapeHtml(migSlotLabel(savedPath)) : 'unknown on this phone'}</span></div>
    <div class="mig-row"><span class="k">Native balance</span>${balance}</div>${stakingRows}
    <div class="mig-row"><span class="k">Recovery phrase on this phone</span><span class="v">${stored ? 'encrypted copy saved' : 'not stored'}</span></div>
    ${l1.mode === 'shadow' && l1.live ? `
    <div class="mig-actions mig-actions-native">
      <button class="btn primary" type="button" id="migSendBtn" ${n && n.exists && n.amount !== '0' ? '' : 'disabled'}>↑ Send native DLTX</button>
      <button class="btn ghost" type="button" id="migReceiveBtn">↓ Receive</button>
    </div>
    <div class="mig-history" id="migHistory"></div>` : ''}
    <div class="mig-actions">
      <button class="btn ghost" type="button" id="migCopyAddr">Copy address</button>
      ${stored
    ? '<button class="btn ghost" type="button" id="migRevealBtn">Show phrase</button><button class="btn ghost" type="button" id="migForgetBtn">Remove from phone</button>'
    : '<button class="btn ghost" type="button" id="migRestoreBtn">Restore wallet here</button>'}
      ${l1.live ? '<button class="btn ghost" type="button" id="migRefreshBal">Refresh balance</button>' : ''}
      ${l1.explorerUrl ? `<a class="btn ghost" href="${escapeHtml(l1.explorerUrl)}/#/account/${address}" target="_blank" rel="noopener" style="text-align:center">Explorer ↗</a>` : ''}
    </div>
    <p class="mig-note">Linked on ${escapeHtml(new Date(claim.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' }))}. A linked address cannot be changed from the app; if you lost the phrase, contact support <b>before</b> genesis.${savedPath ? ' Several Deltix accounts can share one recovery phrase — each account uses its own slot.' : ''}</p>`;
  $('migCopyAddr').onclick = async () => {
    const ok = await copyText(claim.address);
    toast(ok ? 'Native address copied' : 'Could not copy automatically. Press and hold the address to copy it.', { tone: ok ? 'success' : 'error' });
  };
  const sendBtn = $('migSendBtn');
  if (sendBtn) sendBtn.onclick = () => openMigrationModal('send');
  const receiveBtn = $('migReceiveBtn');
  if (receiveBtn) receiveBtn.onclick = () => openMigrationModal('receive');
  if ($('migHistory')) renderMigHistory();
  const reveal = $('migRevealBtn');
  if (reveal) reveal.onclick = () => openMigrationModal('reveal');
  const forget = $('migForgetBtn');
  if (forget) forget.onclick = migForgetKeystore;
  const restore = $('migRestoreBtn');
  if (restore) restore.onclick = () => { migState.expectAddress = claim.address; openMigrationModal('import'); };
  const refresh = $('migRefreshBal');
  if (refresh) refresh.onclick = () => { migState.native = null; renderMigrationCard(); loadNativeBalance(); };
}

/**
 * Native balance of the claimed address. Preferred source: the backend's L1 adapter (GET /api/l1/account — same
 * origin, chain id verified server-side, also returns staked / unbonding / rewards). Fallback while the backend runs
 * with L1_MODE=off: the chain's public REST endpoint directly (balance only). Read-only; no key involved.
 */
async function loadNativeBalance() {
  const l1 = migState.status && migState.status.l1;
  const claim = migState.claim;
  if (!l1 || !claim || (!l1.restUrl && l1.mode !== 'shadow')) return;
  try {
    const sdk = await migSdk();
    if (l1.mode === 'shadow') {
      const acc = await api('GET', '/l1/account');
      migState.native = {
        amount: sdk.formatDltx(BigInt(acc.balance || '0')),
        staked: sdk.formatDltx(BigInt(acc.staked || '0')),
        rewards: sdk.formatDltx(BigInt(acc.rewards || '0')),
        unbonding: sdk.formatDltx(BigInt(acc.unbonding || '0')),
        exists: acc.exists !== false,
        at: Date.now(),
      };
    } else {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), MIG_REST_TIMEOUT_MS) : null;
      try {
        const res = await fetch(`${l1.restUrl}/cosmos/bank/v1beta1/balances/${encodeURIComponent(claim.address)}/by_denom?denom=sdltx`, { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const raw = json && json.balance && /^[0-9]+$/.test(String(json.balance.amount)) ? String(json.balance.amount) : '0';
        migState.native = { amount: sdk.formatDltx(BigInt(raw)), at: Date.now() };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } catch (e) {
    console.warn('native balance:', e.message);
    migState.native = { error: true };
  }
  renderMigrationCard();
}

async function migForgetKeystore() {
  const claim = migState.claim;
  if (!claim) return;
  const ok = await askConfirm({
    title: 'Remove the encrypted phrase from this phone?',
    message: 'Only the written 24-word recovery phrase can restore the wallet afterwards. Deltix cannot recover it for you.',
    confirmText: 'Remove', danger: true,
  });
  if (!ok) return;
  localStorage.removeItem(MIG_KEYSTORE_PREFIX + migKeystoreId(claim.address));
  toast('Encrypted phrase removed from this phone');
  renderMigrationCard();
}

// ---------- the modal ----------

const MIG_PROGRESS = { intro: 0, create: 1, confirm: 1, import: 1, protect: 2, sign: 3, done: 4, reveal: -1, send: -1, review: -1, unlock: -1, result: -1, receive: -1 };

function openMigrationModal(step) {
  migResetSecrets();
  migState.challenge = null;
  migState.slot = 0;
  if (step !== 'import') migState.expectAddress = null;
  $('migrationModal').hidden = false;
  migSetHint('');
  migRender(step || 'intro');
}

/** Closes the flow if it is open and wipes every secret it held. Returns true when it was open (Back handling). */
function closeMigrationModal() {
  const m = $('migrationModal');
  if (!m || m.hidden) return false;
  m.hidden = true;
  migResetSecrets();
  $('migrationSteps').innerHTML = '';
  return true;
}

function migResetSecrets() {
  if (migState.wallet && !migState.wallet.destroyed) { try { migState.wallet.destroy(); } catch { /* already gone */ } }
  migState.wallet = null;
  migState.mnemonic = null;
  migState.network = null;
  migState.busy = false;
  migState.send = null;   // draft / reviewed transfer; never outlives the modal
}

function migSetHint(msg, error = false) {
  const h = $('migrationHint');
  if (!h) return;
  h.textContent = msg || '';
  h.className = error ? 'hint error' : 'hint';
}

function migBusy(btn, on, label) {
  migState.busy = on;
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; btn.classList.add('busy'); btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.classList.remove('busy'); btn.disabled = false; }
}

function migRender(step) {
  migState.step = step;
  migState.busy = false;   // every step starts idle (a previous step's busy button is gone with its markup)
  const pos = MIG_PROGRESS[step];
  const prog = $('migrationProgress');
  prog.hidden = pos === undefined || pos < 0;
  prog.querySelectorAll('li').forEach((li, i) => {
    li.className = i < pos ? 'done' : i === pos ? 'active' : '';
  });
  migSetHint('');
  const host = $('migrationSteps');
  switch (step) {
    case 'intro': return migRenderIntro(host);
    case 'create': return migRenderCreate(host);
    case 'confirm': return migRenderConfirm(host);
    case 'import': return migRenderImport(host);
    case 'protect': return migRenderProtect(host);
    case 'sign': return migRenderSign(host);
    case 'done': return migRenderDone(host);
    case 'reveal': return migRenderReveal(host);
    case 'send': return migRenderSend(host);
    case 'review': return migRenderReview(host);
    case 'unlock': return migRenderUnlock(host);
    case 'result': return migRenderResult(host);
    case 'receive': return migRenderReceive(host);
    default: host.innerHTML = '';
  }
}

function migRenderIntro(host) {
  const c = migState.status.claims;
  host.innerHTML = `
    <div class="mig-step">
      <h4>Bring your $DLTX to the native Deltix chain</h4>
      <p>Your in-app balance lives on Deltix's legacy ledger today. At the native chain's genesis it is allocated to <b>one native address that you control</b>. This flow links that address to your account.</p>
      <ul class="disclosure">
        <li><b>Nothing moves now.</b> You only prove that the address is yours by signing a short message.</li>
        <li>One address per account. It cannot be changed from the app afterwards.</li>
        <li>The 24-word recovery phrase <b>is</b> the wallet. Deltix never sees it and cannot restore it. Lose it and the balance allocated to that address is lost.</li>
        <li><b>Several Deltix accounts?</b> Use <b>one</b> recovery phrase for all of them: link the first account with a new phrase (wallet slot 1), then in each other account choose "I already have a recovery phrase", enter the same phrase and pick the next slot (2, 3, 4…). Every account gets its own address; the same address cannot be linked twice.</li>
        <li>Chain: <code>${escapeHtml(c.chainId)}</code> · derivation path <code>${escapeHtml(c.hdPath || "m/44'/118'/0'/0/0")}</code> (slot 1)</li>
      </ul>
      <button class="mig-choice primary" type="button" id="migChooseCreate">
        <span class="ic">✨</span>
        <span class="txt"><b>Create a new native wallet</b><small>Generates a 24-word phrase on this phone. Recommended.</small></span>
      </button>
      <button class="mig-choice" type="button" id="migChooseImport">
        <span class="ic">🔑</span>
        <span class="txt"><b>I already have a recovery phrase</b><small>Use an existing 12–24 word Deltix / Cosmos-style phrase.</small></span>
      </button>
    </div>`;
  $('migChooseCreate').onclick = () => migStartCreate();
  $('migChooseImport').onclick = () => migRender('import');
}

async function migStartCreate() {
  const btn = $('migChooseCreate');
  migBusy(btn, true, 'Generating…');
  try {
    const sdk = await migSdk();
    migState.network = migNetwork(sdk);
    migState.slot = 0;
    migState.mnemonic = sdk.generateMnemonic();
    migState.wallet = await sdk.Wallet.fromMnemonic(migState.mnemonic, migState.network, { hdPath: sdk.hdPathForAccount(0) });
    migRender('create');
  } catch (e) {
    migSetHint(e.message || 'Could not create the wallet.', true);
    migBusy(btn, false);
  }
}

function migWordsHtml(words, revealLabel) {
  return `<div class="mig-words covered" id="migWords">
        <ol>${words.map((w, i) => `<li><i>${i + 1}</i><b>${escapeHtml(w)}</b></li>`).join('')}</ol>
        <button class="mig-reveal" type="button" id="migRevealWords">${revealLabel}</button>
      </div>`;
}

function migRenderCreate(host) {
  const words = migState.mnemonic.split(' ');
  host.innerHTML = `
    <div class="mig-step">
      <h4>Write down your recovery phrase</h4>
      <div class="mig-warn"><span>⚠️</span><div><b>Paper, not pixels.</b> Write all 24 words in order and keep them offline. Do not screenshot, photograph, message or store them in a notes app — anyone with these words owns the wallet.</div></div>
      ${migWordsHtml(words, 'Tap to reveal — make sure nobody is watching')}
      <div class="mig-kv">
        <div><span>Your native address</span><span>${escapeHtml(migState.wallet.address)}</span></div>
        <div><span>Phrase slot</span><span>${escapeHtml(migSlotLabel(migState.wallet.hdPath))}</span></div>
      </div>
      <p>Have other Deltix accounts? Keep this one phrase: in each other account choose "I already have a recovery phrase", enter it and pick slot 2, 3, 4… — one phrase to back up, one address per account.</p>
      <label class="check-row" for="migWroteDown"><input type="checkbox" id="migWroteDown" /><span>I have written down all 24 words, in order, and stored them somewhere safe and offline.</span></label>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migBackIntro">Back</button>
        <button class="btn primary" type="button" id="migToConfirm" disabled>Continue</button>
      </div>
    </div>`;
  const sync = () => { $('migToConfirm').disabled = !$('migWroteDown').checked || $('migWords').classList.contains('covered'); };
  $('migRevealWords').onclick = () => { $('migWords').classList.remove('covered'); sync(); };
  $('migWroteDown').onchange = sync;
  $('migBackIntro').onclick = () => { migResetSecrets(); migRender('intro'); };
  $('migToConfirm').onclick = () => migRender('confirm');
}

function migPickCheckIndexes(count, total) {
  const picked = new Set();
  const buf = new Uint32Array(1);
  while (picked.size < count) {
    crypto.getRandomValues(buf);
    picked.add(buf[0] % total);
  }
  return [...picked].sort((a, b) => a - b);
}

function migRenderConfirm(host) {
  const words = migState.mnemonic.split(' ');
  const idx = migPickCheckIndexes(3, words.length);
  host.innerHTML = `
    <div class="mig-step">
      <h4>Check your backup</h4>
      <p>Type the words at these positions exactly as you wrote them down.</p>
      <div class="mig-check-grid">
        ${idx.map((i) => `<label>Word #${i + 1}<input type="text" data-idx="${i}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="text" /></label>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migBackCreate">Show the phrase again</button>
        <button class="btn primary" type="button" id="migCheckWords">Verify</button>
      </div>
    </div>`;
  $('migBackCreate').onclick = () => migRender('create');
  $('migCheckWords').onclick = () => {
    const inputs = [...host.querySelectorAll('input[data-idx]')];
    const wrong = inputs.filter((inp) => inp.value.trim().toLowerCase() !== words[Number(inp.dataset.idx)]);
    if (wrong.length) {
      wrong.forEach((inp) => { inp.style.borderColor = 'var(--danger)'; });
      migSetHint(`${wrong.length === 1 ? 'One word does not match' : `${wrong.length} words do not match`} your phrase. Check your notes and try again.`, true);
      return;
    }
    migRender('protect');
  };
}

function migRenderImport(host) {
  const expect = migState.expectAddress;
  const slotOptions = Array.from({ length: MIG_SLOTS }, (_, i) => `<option value="${i}"${i === migState.slot ? ' selected' : ''}>Slot ${i + 1}${i === 0 ? ' (default)' : ''}</option>`).join('');
  host.innerHTML = `
    <div class="mig-step">
      <h4>${expect ? 'Restore your linked wallet' : 'Import a recovery phrase'}</h4>
      <p>${expect
    ? `Enter the recovery phrase of your linked address <code>${escapeHtml(migShort(expect))}</code> to keep an encrypted copy on this phone. The slot is found automatically.`
    : 'Enter the 12–24 words separated by spaces. The phrase is processed on this phone only and never sent anywhere.'}</p>
      <textarea id="migPhrase" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="word1 word2 word3 …">${migState.mnemonic && !expect ? escapeHtml(migState.mnemonic) : ''}</textarea>
      ${expect ? '' : `
      <label for="migSlot">Wallet slot of this phrase</label>
      <select id="migSlot">${slotOptions}</select>
      <p>One phrase can serve all your Deltix accounts: use a different slot for each account. Slot 1 is the usual choice for your first account.</p>`}
      <div class="mig-kv" id="migImportPreview" hidden><div><span>Address</span><span id="migImportAddr"></span></div><div><span>Slot</span><span id="migImportPath"></span></div></div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migBackIntro2">${expect ? 'Cancel' : 'Back'}</button>
        <button class="btn primary" type="button" id="migImportBtn">Continue</button>
      </div>
    </div>`;
  $('migBackIntro2').onclick = () => { if (expect) closeMigrationModal(); else { migResetSecrets(); migRender('intro'); } };
  const ta = $('migPhrase');
  const sel = $('migSlot');
  const prefix = (migState.status.claims.prefix || 'dltx');
  const preview = async () => {
    const sdk = await migSdk().catch(() => null);
    const box = $('migImportPreview');
    if (!sdk || !box || migState.step !== 'import') return;   // debounced call after the step changed
    const text = ta.value;
    if (!sdk.validateMnemonic(text) || expect) { box.hidden = true; return; }
    try {
      const hdPath = sdk.hdPathForAccount(Number(sel.value));
      const [acc] = await sdk.deriveAddresses(sdk.normalizeMnemonic(text), { prefix, hdPaths: [hdPath] });
      if (!$('migImportAddr')) return;
      $('migImportAddr').textContent = acc.address;
      $('migImportPath').textContent = migSlotLabel(acc.hdPath);
      box.hidden = false;
    } catch { box.hidden = true; }
  };
  let t = 0;
  ta.oninput = () => { clearTimeout(t); t = setTimeout(preview, 350); };
  if (sel) sel.onchange = () => { migState.slot = Number(sel.value); preview(); };
  if (ta.value) preview();
  $('migImportBtn').onclick = async () => {
    const btn = $('migImportBtn');
    migBusy(btn, true, 'Checking…');
    try {
      const sdk = await migSdk();
      const text = ta.value;
      if (!sdk.validateMnemonic(text)) throw new Error('That is not a valid recovery phrase. Check the spelling and the word order (12, 15, 18, 21 or 24 words).');
      migState.network = migNetwork(sdk);
      const mnemonic = sdk.normalizeMnemonic(text);
      let hdPath;
      if (expect) {
        // Restore: find which slot of this phrase derives the linked address.
        const paths = Array.from({ length: MIG_SCAN_SLOTS }, (_, i) => sdk.hdPathForAccount(i));
        const hit = (await sdk.deriveAddresses(mnemonic, { prefix, hdPaths: paths })).find((x) => x.address === expect);
        if (!hit) throw new Error(`This phrase does not open your linked address ${migShort(expect)} in any of its first ${MIG_SCAN_SLOTS} wallet slots. Only the phrase of the linked address can be restored here.`);
        hdPath = hit.hdPath;
        migState.slot = paths.indexOf(hdPath);
      } else {
        migState.slot = sel ? Number(sel.value) : 0;
        hdPath = sdk.hdPathForAccount(migState.slot);
      }
      const w = await sdk.Wallet.fromMnemonic(mnemonic, migState.network, { hdPath });
      migState.mnemonic = mnemonic;
      migState.wallet = w;
      if (expect) migSavePath(expect, hdPath);
      ta.value = '';
      migRender('protect');
    } catch (e) {
      migSetHint(e.message || 'Could not import the phrase.', true);
      migBusy(btn, false);
    }
  };
}
function migRenderProtect(host) {
  const restoreOnly = !!migState.expectAddress;
  host.innerHTML = `
    <div class="mig-step">
      <h4>Keep an encrypted copy on this phone?</h4>
      <p>Optional. The phrase is encrypted with a password you choose (scrypt + AES-256-GCM) and stays inside the Deltix app's storage. You will need it later to show the phrase or sign on the native chain from this phone. <b>The written phrase stays the only real backup</b> — Deltix cannot reset this password.</p>
      <label for="migPw1">Password (at least ${MIG_MIN_PASSWORD} characters)</label>
      <input id="migPw1" type="password" autocomplete="new-password" />
      <label for="migPw2">Repeat password</label>
      <input id="migPw2" type="password" autocomplete="new-password" />
      <div class="modal-actions">
        ${restoreOnly ? '' : '<button class="btn ghost" type="button" id="migSkipProtect">Skip — paper only</button>'}
        <button class="btn primary" type="button" id="migSaveProtect">${restoreOnly ? 'Encrypt & save' : 'Encrypt & continue'}</button>
      </div>
    </div>`;
  const skip = $('migSkipProtect');
  if (skip) skip.onclick = () => migRender('sign');
  $('migSaveProtect').onclick = async () => {
    const btn = $('migSaveProtect');
    const pw1 = $('migPw1').value;
    const pw2 = $('migPw2').value;
    if (pw1.length < MIG_MIN_PASSWORD) return migSetHint(`Use at least ${MIG_MIN_PASSWORD} characters.`, true);
    if (pw1 !== pw2) return migSetHint('The two passwords differ.', true);
    migBusy(btn, true, 'Encrypting…');
    try {
      const sdk = await migSdk();
      const id = migKeystoreId(migState.wallet.address);
      const vault = new sdk.WalletVault(new sdk.WebCryptoStore(), migState.network, { id, hdPath: migState.wallet.hdPath });
      if (await vault.exists()) await vault.wipe();   // same address ⇒ same phrase: replacing is safe
      const w = await vault.restore(migState.mnemonic, pw1);
      migState.wallet.destroy();
      migState.wallet = w;
      $('migPw1').value = '';
      $('migPw2').value = '';
      if (restoreOnly) {
        migSavePath(w.address, w.hdPath);
        toast('Encrypted phrase saved on this phone', { tone: 'success' });
        closeMigrationModal();
        renderMigrationCard();
        return;
      }
      migRender('sign');
    } catch (e) {
      migSetHint(e.message || 'Could not encrypt the phrase.', true);
      migBusy(btn, false);
    }
  };
}

async function migRequestChallenge() {
  const ch = await api('POST', '/migration-claims/challenge', { address: migState.wallet.address });
  migState.challenge = ch;
  const pre = $('migMessage');
  if (pre) pre.textContent = ch.message;
  const exp = $('migExpires');
  if (exp) exp.textContent = new Date(ch.expiresAt).toLocaleTimeString(undefined, { timeStyle: 'short' });
}

function migRenderSign(host) {
  const c = migState.status.claims;
  host.innerHTML = `
    <div class="mig-step">
      <h4>Link the address to your account</h4>
      <p>You sign the message below with the new wallet. The signature proves you control <code>${escapeHtml(migShort(migState.wallet.address))}</code>; it is not a transaction and cannot move anything.</p>
      <div class="mig-kv">
        <div><span>Address</span><span>${escapeHtml(migState.wallet.address)}</span></div>
        <div><span>Phrase slot</span><span>${escapeHtml(migSlotLabel(migState.wallet.hdPath))}</span></div>
        <div><span>Chain</span><span>${escapeHtml(c.chainId)}</span></div>
        <div><span>Valid until</span><span id="migExpires">…</span></div>
      </div>
      <pre class="mig-message" id="migMessage">Preparing the message…</pre>
      <label class="check-row" for="migAck"><input type="checkbox" id="migAck" /><span>I understand this links my Deltix account to the address above, that it cannot be changed from the app, and that only my recovery phrase controls it.</span></label>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migCancelSign">Cancel</button>
        <button class="btn primary" type="button" id="migSignBtn" disabled>Sign &amp; link</button>
      </div>
    </div>`;
  $('migAck').onchange = (e) => { $('migSignBtn').disabled = !e.target.checked || !migState.challenge; };
  $('migCancelSign').onclick = () => closeMigrationModal();
  migRequestChallenge().then(() => { $('migSignBtn').disabled = !$('migAck').checked; }).catch((e) => migSetHint(e.message, true));
  $('migSignBtn').onclick = migSubmitClaim;
}

async function migSubmitClaim() {
  if (migState.busy) return;
  const btn = $('migSignBtn');
  migBusy(btn, true, 'Signing…');
  try {
    if (!migState.challenge) await migRequestChallenge();
    const ch = migState.challenge;
    if (Date.now() > new Date(ch.expiresAt).getTime() - 5000) {
      await migRequestChallenge();   // expired while the member was reading: fetch a fresh one, sign that
    }
    const sig = await migState.wallet.signArbitrary(migState.challenge.message);
    const out = await api('POST', '/migration-claims/claim', {
      address: migState.wallet.address,
      nonce: migState.challenge.nonce,
      signature: sig.signature,
      pubkey: sig.pub_key.value,
    });
    migState.claim = { address: out.address, chainId: out.chainId, createdAt: out.createdAt, status: out.status };
    migSavePath(out.address, migState.wallet.hdPath);
    migRender('done');
    migResetSecrets();
    renderMigrationCard();
    if (migState.status && migState.status.l1 && migState.status.l1.live) loadNativeBalance();
  } catch (e) {
    if (e.code === 'NONCE_EXPIRED' || e.code === 'NONCE_USED' || e.code === 'NONCE_UNKNOWN') {
      migState.challenge = null;
      migSetHint('The message expired. A new one was prepared — tap Sign & link again.', true);
      migRequestChallenge().catch((err) => migSetHint(err.message, true));
    } else if (e.code === 'ADDRESS_ALREADY_CLAIMED') {
      // The same slot of a shared phrase is already linked to another Deltix account: pick another slot.
      const used = migState.slot + 1;
      migState.challenge = null;
      if (migState.wallet) { migState.wallet.destroy(); migState.wallet = null; }
      migState.slot = Math.min(migState.slot + 1, MIG_SLOTS - 1);
      migRender('import');
      migSetHint(`That address (wallet slot ${used}) is already linked to another Deltix account. Pick a different slot for this account.`, true);
      return;
    } else if (e.code === 'USER_ALREADY_CLAIMED') {
      migSetHint('This account already has a linked address.', true);
      loadMigrationStatus();
    } else {
      migSetHint(e.message || 'The claim could not be recorded.', true);
    }
    migBusy(btn, false);
  }
}

function migRenderDone(host) {
  const claim = migState.claim;
  const savedPath = migSavedPath(claim.address);
  host.innerHTML = `
    <div class="mig-step">
      <div class="mig-done">
        <div class="big">✅</div>
        <h4>Address linked</h4>
        <p>Your account is now bound to <code>${escapeHtml(migShort(claim.address))}</code>${savedPath ? ` (${escapeHtml(migSlotLabel(savedPath))})` : ''}. At genesis, your legacy balance is allocated to this address.</p>
      </div>
      <ul class="disclosure">
        <li>Nothing has moved. Your in-app balance keeps working until the migration date is announced.</li>
        <li>Your recovery phrase is the only key. ${migHasKeystore(claim.address) ? 'An encrypted copy is on this phone; the written copy is still the real backup.' : 'No copy was kept on this phone — keep the written phrase safe.'}</li>
        <li>Other Deltix accounts? Link each one with the <b>same phrase</b> and a <b>different slot</b> ("I already have a recovery phrase").</li>
        <li>Questions? The Deltix assistant and support can see that a claim exists, never the key.</li>
      </ul>
      <button class="btn primary" type="button" id="migDoneBtn">Done</button>
    </div>`;
  $('migDoneBtn').onclick = () => closeMigrationModal();
}

function migRenderReveal(host) {
  const claim = migState.claim;
  host.innerHTML = `
    <div class="mig-step">
      <h4>Show the recovery phrase</h4>
      <p>Enter the password you chose when the encrypted copy was saved on this phone. Make sure nobody can see your screen.</p>
      <label for="migRevealPw">Password</label>
      <input id="migRevealPw" type="password" autocomplete="current-password" />
      <div id="migRevealOut"></div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migRevealClose">Close</button>
        <button class="btn primary" type="button" id="migRevealGo">Unlock</button>
      </div>
    </div>`;
  $('migRevealClose').onclick = () => closeMigrationModal();
  $('migRevealGo').onclick = async () => {
    const btn = $('migRevealGo');
    migBusy(btn, true, 'Decrypting…');
    try {
      const sdk = await migSdk();
      const network = migNetwork(sdk);
      const vault = new sdk.WalletVault(new sdk.WebCryptoStore(), network, { id: migKeystoreId(claim.address), hdPath: migSavedPath(claim.address) || undefined });
      const phrase = await vault.revealMnemonic($('migRevealPw').value);
      $('migRevealPw').value = '';
      const words = phrase.split(' ');
      $('migRevealOut').innerHTML = `
        <div class="mig-warn"><span>⚠️</span><div><b>Do not screenshot.</b> Anyone with these words owns the wallet.</div></div>
        ${migWordsHtml(words, 'Tap to reveal')}`;
      $('migRevealWords').onclick = () => $('migWords').classList.remove('covered');
      btn.hidden = true;
    } catch (e) {
      migSetHint(e && e.name === 'DecryptionError' ? 'Wrong password (or the stored copy is damaged).' : (e.message || 'Could not decrypt.'), true);
      migBusy(btn, false);
    }
  };
}

// ---------- native wallet: send / receive / history (W2) ----------
// Signing happens on the phone with the wallet SDK; the backend only relays the finished bytes
// (POST /api/l1/tx/broadcast) and answers reads (GET /api/l1/account, /api/l1/transfers). The unlocked
// wallet exists only between "Unlock" and the broadcast and is destroyed right after (or on cancel/Back).

function migNativeNetwork(sdk) {
  const l1 = migState.status.l1;
  const chainId = l1.chainId || migState.status.claims.chainId;
  const kind = /(test|dev|local|wallet-test|sandbox)/i.test(chainId) ? 'testnet' : 'mainnet';
  return sdk.defineNetwork({ kind, chainId, prefix: migState.status.claims.prefix || 'dltx', approved: true });
}

function migRenderSend(host) {
  const d = migState.send || {};
  const chainId = migState.status.l1.chainId || migState.status.claims.chainId;
  host.innerHTML = `
    <div class="mig-step">
      <h4>Send native DLTX</h4>
      <p>From <code>${escapeHtml(migShort(migState.claim.address))}</code> · on chain: <b>${escapeHtml((migState.native && migState.native.amount) || '0')} DLTX</b></p>
      <label for="migSendTo">Recipient address</label>
      <input id="migSendTo" type="text" placeholder="dltx1…" autocomplete="off" autocapitalize="off" spellcheck="false" value="${escapeHtml(d.to || '')}" />
      <label for="migSendAmount">Amount (DLTX)</label>
      <div class="bot-input-row">
        <input id="migSendAmount" type="text" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${d.max ? '' : escapeHtml(d.amountText || '')}" ${d.max ? 'disabled' : ''} />
        <button class="btn ghost${d.max ? ' active' : ''}" type="button" id="migSendMax" title="Everything minus the network fee">${d.max ? 'Max ✓' : 'Max'}</button>
      </div>
      <p class="hint" id="migSendMaxHint" ${d.max ? '' : 'hidden'}>Whole balance minus the network fee — the exact amount is shown on the next screen.</p>
      <label for="migSendMemo">Memo (optional — some exchanges require one)</label>
      <input id="migSendMemo" type="text" maxlength="256" autocomplete="off" value="${escapeHtml(d.memo || '')}" />
      <ul class="disclosure">
        <li>Native transfers are final and leave the Deltix app entirely. Check the address twice.</li>
        <li>Only <code>dltx1…</code> addresses on chain <code>${escapeHtml(chainId)}</code> — never a <code>0x…</code> address, never a wDLTX contract.</li>
        <li>The network fee is paid in DLTX to the chain, not to Deltix.</li>
      </ul>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migSendCancel">Cancel</button>
        <button class="btn primary" type="button" id="migSendNext">Continue</button>
      </div>
    </div>`;
  $('migSendCancel').onclick = () => closeMigrationModal();
  $('migSendMax').onclick = () => {
    const on = !($('migSendAmount').disabled);
    $('migSendAmount').disabled = on;
    if (on) $('migSendAmount').value = '';
    $('migSendMax').textContent = on ? 'Max ✓' : 'Max';
    $('migSendMax').classList.toggle('active', on);
    $('migSendMaxHint').hidden = !on;
  };
  $('migSendNext').onclick = async () => {
    try {
      const sdk = await migSdk();
      const prefix = migState.status.claims.prefix || 'dltx';
      const to = $('migSendTo').value.trim();
      if (!sdk.isValidAddress(to, prefix)) throw new Error(`Enter a valid ${prefix}1… address.`);
      if (to === migState.claim.address) throw new Error('That is your own address.');
      const max = $('migSendAmount').disabled;
      let amount = null;
      const amountText = $('migSendAmount').value.trim();
      if (!max) {
        try { amount = sdk.parsePositiveDltx(amountText); } catch { throw new Error('Enter an amount greater than zero with at most 8 decimals.'); }
      }
      const memo = $('migSendMemo').value;
      if (new TextEncoder().encode(memo).length > 256) throw new Error('The memo is too long (256 bytes).');
      migState.send = { to, amount, amountText, max, memo };
      migRender('unlock');
    } catch (e) {
      migSetHint(e.message, true);
    }
  };
}

/** Opens the wallet of the linked address from the encrypted copy (password) or from the typed phrase; verifies the address. */
async function migOpenLinkedWallet({ password, phrase }) {
  const sdk = await migSdk();
  const network = migNativeNetwork(sdk);
  const claim = migState.claim;
  const prefix = network.prefix;
  const savedPath = migSavedPath(claim.address);
  let mnemonic;
  if (password !== undefined) {
    const vault = new sdk.WalletVault(new sdk.WebCryptoStore(), network, { id: migKeystoreId(claim.address) });
    mnemonic = await vault.revealMnemonic(password);
  } else {
    if (!sdk.validateMnemonic(phrase)) throw new Error('That is not a valid recovery phrase.');
    mnemonic = sdk.normalizeMnemonic(phrase);
  }
  let hdPath = savedPath;
  if (!hdPath || (await sdk.deriveAddresses(mnemonic, { prefix, hdPaths: [hdPath] }))[0].address !== claim.address) {
    const paths = Array.from({ length: MIG_SCAN_SLOTS }, (_, i) => sdk.hdPathForAccount(i));
    const hit = (await sdk.deriveAddresses(mnemonic, { prefix, hdPaths: paths })).find((x) => x.address === claim.address);
    if (!hit) throw new Error(`This phrase does not open your linked address ${migShort(claim.address)}.`);
    hdPath = hit.hdPath;
    migSavePath(claim.address, hdPath);
  }
  const wallet = await sdk.Wallet.fromMnemonic(mnemonic, network, { hdPath });
  if (wallet.address !== claim.address) { wallet.destroy(); throw new Error('Derived address does not match the linked address.'); }
  return { sdk, wallet, network };
}

function migRenderUnlock(host) {
  const stored = migHasKeystore(migState.claim.address);
  host.innerHTML = `
    <div class="mig-step">
      <h4>Unlock to sign</h4>
      <p>${stored
    ? 'Enter the password of the encrypted copy on this phone. The key is used once, on this phone, and discarded.'
    : 'No encrypted copy is on this phone: enter the recovery phrase of your linked address. It is used once, on this phone, and discarded.'}</p>
      ${stored
    ? '<label for="migUnlockPw">Password</label><input id="migUnlockPw" type="password" autocomplete="current-password" />'
    : '<textarea id="migUnlockPhrase" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="word1 word2 word3 …"></textarea>'}
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migUnlockBack">Back</button>
        <button class="btn primary" type="button" id="migUnlockGo">Unlock &amp; review</button>
      </div>
    </div>`;
  $('migUnlockBack').onclick = () => migRender('send');
  $('migUnlockGo').onclick = async () => {
    const btn = $('migUnlockGo');
    migBusy(btn, true, 'Unlocking…');
    try {
      const creds = stored ? { password: $('migUnlockPw').value } : { phrase: $('migUnlockPhrase').value };
      const { sdk, wallet, network } = await migOpenLinkedWallet(creds);
      if (stored) $('migUnlockPw').value = ''; else $('migUnlockPhrase').value = '';
      migState.wallet = wallet;
      migState.network = network;
      // fresh account state right before signing: sequence, account number, spendable balance
      const acc = await api('GET', '/l1/account');
      if (!acc.exists) throw new Error('This address has never received DLTX on chain; there is nothing to send yet.');
      const d = migState.send;
      const probeMsg = sdk.buildMsgSend({ from: wallet.address, to: d.to, amount: d.max ? 1n : d.amount, network });
      const sim = await api('POST', '/l1/tx/simulate', { txBytes: sdk.makeSimulationTx({ wallet, messages: [probeMsg], memo: d.memo, sequence: acc.sequence }).base64 });
      const fee = BigInt(sim.fee);
      const gasLimit = BigInt(sim.gasLimit);
      const balance = BigInt(acc.balance);
      const amount = d.max ? balance - fee : d.amount;
      if (amount <= 0n) throw new Error('The balance does not cover the network fee.');
      if (amount + fee > balance) throw new Error(`Not enough DLTX: ${sdk.formatDltx(amount)} + fee ${sdk.formatDltx(fee)} exceeds the balance of ${sdk.formatDltx(balance)}.`);
      migState.send.review = { amount, fee, gasLimit, accountNumber: acc.accountNumber, sequence: acc.sequence, balance };
      migRender('review');
    } catch (e) {
      if (migState.wallet) { migState.wallet.destroy(); migState.wallet = null; }
      const msg = e && e.name === 'DecryptionError' ? 'Wrong password (or the stored copy is damaged).' : (e.message || 'Could not unlock.');
      migSetHint(msg, true);
      migBusy(btn, false);
    }
  };
}

function migRenderReview(host) {
  const d = migState.send;
  const r = d.review;
  const sdkFmt = (v) => window.DeltixWalletSdk.formatDltx(v);
  host.innerHTML = `
    <div class="mig-step">
      <h4>Review the transfer</h4>
      <div class="mig-kv">
        <div><span>From</span><span>${escapeHtml(migState.claim.address)}</span></div>
        <div><span>To</span><span>${escapeHtml(d.to)}</span></div>
        <div><span>Amount</span><span>${escapeHtml(sdkFmt(r.amount))} DLTX</span></div>
        <div><span>Network fee</span><span>${escapeHtml(sdkFmt(r.fee))} DLTX (gas ${escapeHtml(r.gasLimit.toString())})</span></div>
        <div><span>Total debit</span><span>${escapeHtml(sdkFmt(r.amount + r.fee))} DLTX</span></div>
        <div><span>Remaining</span><span>${escapeHtml(sdkFmt(r.balance - r.amount - r.fee))} DLTX</span></div>
        ${d.memo ? `<div><span>Memo</span><span>${escapeHtml(d.memo)}</span></div>` : ''}
        <div><span>Chain</span><span>${escapeHtml(migState.network.chainId)}</span></div>
      </div>
      <div class="mig-warn"><span>⚠️</span><div><b>Final.</b> Native transfers cannot be reversed by Deltix or anyone else. Make sure the address is exactly right.</div></div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migReviewCancel">Cancel</button>
        <button class="btn primary" type="button" id="migReviewSend">Sign &amp; send</button>
      </div>
    </div>`;
  $('migReviewCancel').onclick = () => closeMigrationModal();
  $('migReviewSend').onclick = async () => {
    const btn = $('migReviewSend');
    migBusy(btn, true, 'Signing…');
    try {
      const sdk = await migSdk();
      const wallet = migState.wallet;
      if (!wallet || wallet.destroyed) throw new Error('The wallet is no longer unlocked. Start again.');
      const msg = sdk.buildMsgSend({ from: wallet.address, to: d.to, amount: r.amount, network: migState.network });
      const signed = await sdk.signTx({ wallet, messages: [msg], memo: d.memo, accountNumber: r.accountNumber, sequence: r.sequence, gasLimit: r.gasLimit, fee: r.fee });
      wallet.destroy();
      migState.wallet = null;
      btn.textContent = 'Broadcasting…';
      let out;
      try {
        out = await api('POST', '/l1/tx/broadcast', { txBytes: signed.base64 });
      } catch (e) {
        out = e.data && e.data.accepted === false ? e.data : { accepted: false, code: null, log: e.message };
      }
      migState.send.result = { ...out, hash: out.hash || signed.hash, amount: r.amount, fee: r.fee, to: d.to };
      migRender('result');
      migState.native = null;
      loadNativeBalance();
    } catch (e) {
      if (migState.wallet) { migState.wallet.destroy(); migState.wallet = null; }
      migSetHint(e.message || 'The transfer could not be signed.', true);
      migBusy(btn, false);
    }
  };
}

function migRenderResult(host) {
  const res = migState.send.result;
  const sdkFmt = (v) => window.DeltixWalletSdk.formatDltx(v);
  const l1 = migState.status.l1;
  const explorer = l1.explorerUrl && res.hash ? `<a class="btn ghost" href="${escapeHtml(l1.explorerUrl)}/#/tx/${escapeHtml(res.hash)}" target="_blank" rel="noopener" style="text-align:center">View in explorer ↗</a>` : '';
  let head;
  let body;
  if (res.accepted && res.committed && res.code === 0) {
    head = '<div class="big">✅</div><h4>Sent</h4>';
    body = `<p><b>${escapeHtml(sdkFmt(res.amount))} DLTX</b> to <code>${escapeHtml(migShort(res.to))}</code> is in block ${escapeHtml(String(res.height))}. Fee ${escapeHtml(sdkFmt(res.fee))} DLTX.</p>`;
  } else if (res.accepted && !res.committed) {
    head = '<div class="big">⏳</div><h4>Submitted</h4>';
    body = '<p>The network accepted the transfer but it was not yet in a block when we stopped waiting. It will appear in your activity shortly.</p>';
  } else if (res.accepted && res.code !== 0) {
    head = '<div class="big">❌</div><h4>Failed on chain</h4>';
    body = `<p>The transfer was included but failed: <code>${escapeHtml(res.log || `code ${res.code}`)}</code>. The fee was charged; the amount was not moved.</p>`;
  } else {
    head = '<div class="big">⛔</div><h4>Not accepted</h4>';
    body = `<p>The network refused the transfer: <code>${escapeHtml(res.log || `code ${res.code}`)}</code>. Nothing moved and no fee was charged.</p>`;
  }
  host.innerHTML = `
    <div class="mig-step">
      <div class="mig-done">${head}${body}</div>
      ${res.hash ? `<div class="mig-kv"><div><span>Transaction</span><span>${escapeHtml(res.hash)}</span></div></div>` : ''}
      <div class="modal-actions">
        ${explorer}
        <button class="btn primary" type="button" id="migResultDone">Done</button>
      </div>
    </div>`;
  $('migResultDone').onclick = () => closeMigrationModal();
}

async function migRenderReceive(host) {
  const addr = migState.claim.address;
  const chainId = migState.status.l1.chainId || migState.status.claims.chainId;
  host.innerHTML = `
    <div class="mig-step">
      <h4>Receive native DLTX</h4>
      <p>Share this address, or let the sender scan the code. Only native DLTX on chain <code>${escapeHtml(chainId)}</code> can be sent here — not wDLTX (BEP-20) and not in-app DLTX.</p>
      <div class="qr-box" id="migQr" role="img" aria-label="QR code of your native address"><p class="chat-hint">Preparing your code…</p></div>
      <div class="qr-addr">${escapeHtml(addr)}</div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migReceiveCopy">Copy address</button>
        <button class="btn primary" type="button" id="migReceiveClose">Close</button>
      </div>
    </div>`;
  $('migReceiveCopy').onclick = async () => { const ok = await copyText(addr); toast(ok ? 'Native address copied' : 'Could not copy automatically.', { tone: ok ? 'success' : 'error' }); };
  $('migReceiveClose').onclick = () => closeMigrationModal();
  try {
    await loadScriptOnce('vendor/qrcode.js');
    const qr = qrcode(0, 'M');
    qr.addData(addr);
    qr.make();
    const box = $('migQr');
    if (box) {
      box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
      const svg = box.querySelector('svg');
      if (svg) { svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('shape-rendering', 'crispEdges'); }
    }
  } catch {
    const box = $('migQr');
    if (box) box.innerHTML = '<p class="chat-hint">The code could not be drawn. You can still copy your address.</p>';
  }
}

/** Last native transfers of the linked address (through the backend adapter), rendered inside the card. */
async function renderMigHistory() {
  const host = $('migHistory');
  if (!host) return;
  host.innerHTML = '<p class="mig-note">Loading native activity…</p>';
  try {
    const sdk = await migSdk();
    const res = await api('GET', '/l1/transfers?limit=5');
    const me = migState.claim.address;
    if (!res.items.length) { host.innerHTML = '<p class="mig-note">No native activity yet.</p>'; return; }
    host.innerHTML = `<h4 class="mig-history-title">Native activity</h4>` + res.items.map((t) => {
      const out = t.from === me;
      const other = out ? t.to : t.from;
      const when = t.time ? new Date(t.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : (t.height ? `block ${t.height}` : '');
      return `<div class="mig-tx ${out ? 'out' : 'in'}${t.success === false ? ' failed' : ''}">
        <span class="mig-tx-ic">${out ? '↑' : '↓'}</span>
        <span class="mig-tx-txt"><b>${out ? 'Sent to' : 'Received from'} ${escapeHtml(migShort(other || ''))}</b><small>${escapeHtml(when)}${t.memo ? ' · ' + escapeHtml(t.memo) : ''}${t.success === false ? ' · failed' : ''}</small></span>
        <span class="mig-tx-amt">${out ? '−' : '+'}${escapeHtml(sdk.formatDltx(BigInt(t.amount || '0')))}</span>
      </div>`;
    }).join('');
  } catch (e) {
    host.innerHTML = `<p class="mig-note">Native activity unavailable right now.</p>`;
  }
}
$('migrationClose')?.addEventListener('click', () => closeMigrationModal());
$('migrationModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget && !['create', 'review', 'unlock'].includes(migState.step)) closeMigrationModal(); });
