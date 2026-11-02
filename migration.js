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
const MIG_REST_TIMEOUT_MS = 12000;

const migState = {
  status: null,      // last /migration/status payload
  claim: null,       // the account's active claim { address, chainId, createdAt } or null
  native: null,      // { amount: string (DLTX), at } | { error: true } | null
  step: null,
  mnemonic: null,    // only while the flow is open; cleared on close
  wallet: null,      // unlocked SDK wallet while the flow is open; destroy()ed on close
  network: null,
  challenge: null,   // { nonce, message, expiresAt } for the sign step
  expectAddress: null, // restore flow: the phrase must derive this address
  busy: false,
};

const migShort = (a) => (a && a.length > 20 ? `${a.slice(0, 11)}…${a.slice(-6)}` : a || '');
const migKeystoreId = (address) => `claim-${address}`;
const migHasKeystore = (address) => !!address && localStorage.getItem(MIG_KEYSTORE_PREFIX + migKeystoreId(address)) !== null;

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
    pill.textContent = 'Open';
    pill.className = 'mig-pill';
    sub.textContent = 'Link one native Deltix address to receive your balance on the Deltix chain at genesis. Nothing moves now.';
    body.innerHTML = `
      <div class="mig-row"><span class="k">Chain</span><span class="v mono">${chainId}</span></div>
      <div class="mig-row"><span class="k">Your linked address</span><span class="v">none yet</span></div>
      <div class="mig-actions">
        <button class="btn primary" type="button" id="migStartBtn">Link a native address →</button>
      </div>
      <p class="mig-note">You create (or import) a native wallet on this phone, write down its 24-word recovery phrase and sign a short message that proves the address is yours. Deltix never sees the phrase or the key.</p>`;
    $('migStartBtn').onclick = () => openMigrationModal('intro');
    return;
  }
  pill.textContent = 'Linked';
  pill.className = 'mig-pill linked';
  sub.textContent = 'Your legacy balance will be allocated to this address at genesis. Keep the recovery phrase safe — it is the only key.';
  const address = escapeHtml(claim.address);
  const stored = migHasKeystore(claim.address);
  let balance;
  if (!l1.live) balance = '<span class="v">chain not live yet</span>';
  else if (!migState.native) balance = '<span class="v">loading…</span>';
  else if (migState.native.error) balance = '<span class="v">unavailable right now</span>';
  else balance = `<span class="v">${escapeHtml(migState.native.amount)} DLTX</span>`;
  body.innerHTML = `
    <div class="mig-row"><span class="k">Chain</span><span class="v mono">${escapeHtml(claim.chainId || claims.chainId)}</span></div>
    <div class="mig-row"><span class="k">Linked address</span><span class="v mono" title="${address}">${escapeHtml(migShort(claim.address))}</span></div>
    <div class="mig-row"><span class="k">Native balance</span>${balance}</div>
    <div class="mig-row"><span class="k">Recovery phrase on this phone</span><span class="v">${stored ? 'encrypted copy saved' : 'not stored'}</span></div>
    <div class="mig-actions">
      <button class="btn ghost" type="button" id="migCopyAddr">Copy address</button>
      ${stored
    ? '<button class="btn ghost" type="button" id="migRevealBtn">Show phrase</button><button class="btn ghost" type="button" id="migForgetBtn">Remove from phone</button>'
    : '<button class="btn ghost" type="button" id="migRestoreBtn">Restore wallet here</button>'}
      ${l1.live ? '<button class="btn ghost" type="button" id="migRefreshBal">Refresh balance</button>' : ''}
      ${l1.explorerUrl ? `<a class="btn ghost" href="${escapeHtml(l1.explorerUrl)}/#/account/${address}" target="_blank" rel="noopener" style="text-align:center">Explorer ↗</a>` : ''}
    </div>
    <p class="mig-note">Linked on ${escapeHtml(new Date(claim.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' }))}. A linked address cannot be changed from the app; if you lost the phrase, contact support <b>before</b> genesis.</p>`;
  $('migCopyAddr').onclick = async () => {
    const ok = await copyText(claim.address);
    toast(ok ? 'Native address copied' : 'Could not copy automatically. Press and hold the address to copy it.', { tone: ok ? 'success' : 'error' });
  };
  const reveal = $('migRevealBtn');
  if (reveal) reveal.onclick = () => openMigrationModal('reveal');
  const forget = $('migForgetBtn');
  if (forget) forget.onclick = migForgetKeystore;
  const restore = $('migRestoreBtn');
  if (restore) restore.onclick = () => { migState.expectAddress = claim.address; openMigrationModal('import'); };
  const refresh = $('migRefreshBal');
  if (refresh) refresh.onclick = () => { migState.native = null; renderMigrationCard(); loadNativeBalance(); };
}

/** Reads the native balance from the chain's public REST endpoint (read-only, no key involved). */
async function loadNativeBalance() {
  const l1 = migState.status && migState.status.l1;
  const claim = migState.claim;
  if (!l1 || !l1.restUrl || !claim) return;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), MIG_REST_TIMEOUT_MS) : null;
  try {
    const res = await fetch(`${l1.restUrl}/cosmos/bank/v1beta1/balances/${encodeURIComponent(claim.address)}/by_denom?denom=sdltx`, { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const raw = json && json.balance && /^[0-9]+$/.test(String(json.balance.amount)) ? String(json.balance.amount) : '0';
    const sdk = await migSdk();
    migState.native = { amount: sdk.formatDltx(BigInt(raw)), at: Date.now() };
  } catch (e) {
    console.warn('native balance:', e.message);
    migState.native = { error: true };
  } finally {
    if (timer) clearTimeout(timer);
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

const MIG_PROGRESS = { intro: 0, create: 1, confirm: 1, import: 1, protect: 2, sign: 3, done: 4, reveal: -1 };

function openMigrationModal(step) {
  migResetSecrets();
  migState.challenge = null;
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
        <li>Chain: <code>${escapeHtml(c.chainId)}</code> · derivation path <code>${escapeHtml(c.hdPath || "m/44'/118'/0'/0/0")}</code></li>
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
    migState.mnemonic = sdk.generateMnemonic();
    migState.wallet = await sdk.Wallet.fromMnemonic(migState.mnemonic, migState.network);
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
        <div><span>Path</span><span>${escapeHtml(migState.wallet.hdPath)}</span></div>
      </div>
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
  host.innerHTML = `
    <div class="mig-step">
      <h4>${expect ? 'Restore your linked wallet' : 'Import a recovery phrase'}</h4>
      <p>${expect
    ? `Enter the recovery phrase of your linked address <code>${escapeHtml(migShort(expect))}</code> to keep an encrypted copy on this phone.`
    : 'Enter the 12–24 words separated by spaces. The phrase is processed on this phone only and never sent anywhere.'}</p>
      <textarea id="migPhrase" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="word1 word2 word3 …"></textarea>
      <div class="mig-kv" id="migImportPreview" hidden><div><span>Address</span><span id="migImportAddr"></span></div><div><span>Path</span><span id="migImportPath"></span></div></div>
      <div class="modal-actions">
        <button class="btn ghost" type="button" id="migBackIntro2">${expect ? 'Cancel' : 'Back'}</button>
        <button class="btn primary" type="button" id="migImportBtn">Continue</button>
      </div>
    </div>`;
  $('migBackIntro2').onclick = () => { if (expect) closeMigrationModal(); else migRender('intro'); };
  const ta = $('migPhrase');
  const preview = async () => {
    const sdk = await migSdk().catch(() => null);
    if (!sdk) return;
    const text = ta.value;
    if (!sdk.validateMnemonic(text)) { $('migImportPreview').hidden = true; return; }
    try {
      const acc = await sdk.deriveAccount(sdk.normalizeMnemonic(text), { prefix: (migState.status.claims.prefix || 'dltx') });
      acc.privkey.fill(0);
      $('migImportAddr').textContent = acc.address;
      $('migImportPath').textContent = acc.hdPath;
      $('migImportPreview').hidden = false;
    } catch { $('migImportPreview').hidden = true; }
  };
  let t = 0;
  ta.oninput = () => { clearTimeout(t); t = setTimeout(preview, 350); };
  $('migImportBtn').onclick = async () => {
    const btn = $('migImportBtn');
    migBusy(btn, true, 'Checking…');
    try {
      const sdk = await migSdk();
      const text = ta.value;
      if (!sdk.validateMnemonic(text)) throw new Error('That is not a valid recovery phrase. Check the spelling and the word order (12, 15, 18, 21 or 24 words).');
      migState.network = migNetwork(sdk);
      migState.mnemonic = sdk.normalizeMnemonic(text);
      const w = await sdk.Wallet.fromMnemonic(migState.mnemonic, migState.network);
      if (expect && w.address !== expect) {
        w.destroy();
        migState.mnemonic = null;
        throw new Error(`This phrase opens ${migShort(w.address)}, not your linked address ${migShort(expect)}. Only the phrase of the linked address can be restored here.`);
      }
      migState.wallet = w;
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
      const vault = new sdk.WalletVault(new sdk.WebCryptoStore(), migState.network, { id });
      if (await vault.exists()) await vault.wipe();   // same address ⇒ same phrase: replacing is safe
      const w = await vault.restore(migState.mnemonic, pw1);
      migState.wallet.destroy();
      migState.wallet = w;
      $('migPw1').value = '';
      $('migPw2').value = '';
      if (restoreOnly) {
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
    migRender('done');
    migResetSecrets();
    renderMigrationCard();
    if (migState.status && migState.status.l1 && migState.status.l1.live) loadNativeBalance();
  } catch (e) {
    if (e.code === 'NONCE_EXPIRED' || e.code === 'NONCE_USED' || e.code === 'NONCE_UNKNOWN') {
      migState.challenge = null;
      migSetHint('The message expired. A new one was prepared — tap Sign & link again.', true);
      migRequestChallenge().catch((err) => migSetHint(err.message, true));
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
  host.innerHTML = `
    <div class="mig-step">
      <div class="mig-done">
        <div class="big">✅</div>
        <h4>Address linked</h4>
        <p>Your account is now bound to <code>${escapeHtml(migShort(claim.address))}</code>. At genesis, your legacy balance is allocated to this address.</p>
      </div>
      <ul class="disclosure">
        <li>Nothing has moved. Your in-app balance keeps working until the migration date is announced.</li>
        <li>Your recovery phrase is the only key. ${migHasKeystore(claim.address) ? 'An encrypted copy is on this phone; the written copy is still the real backup.' : 'No copy was kept on this phone — keep the written phrase safe.'}</li>
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
      const vault = new sdk.WalletVault(new sdk.WebCryptoStore(), network, { id: migKeystoreId(claim.address) });
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

$('migrationClose')?.addEventListener('click', () => closeMigrationModal());
$('migrationModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget && migState.step !== 'create') closeMigrationModal(); });
