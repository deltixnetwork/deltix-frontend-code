'use strict';

/**
 * Deltix Arcade — ten original games built from classic, public-domain game
 * concepts (tic-tac-toe, memory pairs, snake, tile-merge, sudoku, mine
 * clearing, 15-puzzle, reversi, sequence recall, reaction tap).
 * All code, visuals and names are original Deltix work — no third-party
 * assets. Rewards are settled server-side against a play session.
 */

const gel = (id) => document.getElementById(id);

const ARCADE_ICONS = {
  tictactoe: '◍', memory: '❖', snake: '➰', merge: '⬚', sudoku: '▦',
  minehunt: '☄', slide: '⇄', reversi: '◐', recall: '◌', reaction: '⚡',
  ludo: '⛃', chess: '♞', threecard: 'Δ', carom: '⬤', slicer: '◈', soccer: '◎', racing: '»',
  connect4: '◉', breaker: '▬', tower: '▮', blocks: '▤', flyer: '➤',
};

// One emoji per game — the community asked for more personality on the cards.
const ARCADE_EMOJI = {
  tictactoe: '❌', memory: '🧠', snake: '🐍', merge: '🔢', sudoku: '🔡',
  minehunt: '💣', slide: '🧩', reversi: '⚫', recall: '🎼', reaction: '⚡',
  ludo: '🎲', chess: '♟️', threecard: '🃏', carom: '🎱', slicer: '🍉', soccer: '⚽', racing: '🏎️',
  connect4: '🔴', breaker: '🧱', tower: '🏗️', blocks: '🟦', flyer: '🚀',
};

// The rival personas players meet across the arcade.
const ARCADE_CREW = [
  { emoji: '🧑‍🎤', name: 'Maya', role: 'Tic-Tac-Toe' },
  { emoji: '🧠', name: 'Iris', role: 'Memory Match' },
  { emoji: '🐍', name: 'Rex', role: 'Delta Snake' },
  { emoji: '🎩', name: 'Victor', role: 'Reversi' },
  { emoji: '♟️', name: 'Elena', role: 'Chess' },
  { emoji: '🃏', name: 'Rio', role: 'Card Draw' },
  { emoji: '🧤', name: 'Dario', role: 'Penalty Kicks' },
  { emoji: '🤖', name: 'Nova', role: 'Delta Four' },
  { emoji: '🌞', name: 'Sunny', role: 'Delta Ludo' },
  { emoji: '💧', name: 'Aqua', role: 'Delta Ludo' },
  { emoji: '❤️', name: 'Ruby', role: 'Delta Ludo' },
];

const ARCADE_3D_IMAGES = {
  tictactoe: 'assets/game-tictactoe.svg',
  memory: 'assets/game-memory.svg',
  snake: 'assets/game-snake.svg',
  merge: 'assets/game-2048.svg',
  sudoku: 'assets/game-sudoku.svg',
  minehunt: 'assets/game-minehunt.svg',
  slide: 'assets/game-slide.svg',
  reversi: 'assets/game-reversi.svg',
  recall: 'assets/game-recall.svg',
  reaction: 'assets/icon-rewards-trophy.svg',
  ludo: 'assets/game-ludo.svg',
  chess: 'assets/game-chess.svg',
  threecard: 'assets/game-cards.svg',
  carom: 'assets/game-carom.svg',
  slicer: 'assets/game-slicer.svg',
  soccer: 'assets/game-soccer.svg',
  racing: 'assets/game-racing.svg',
  connect4: 'assets/game-connect4.svg',
  breaker: 'assets/game-breaker.svg',
  tower: 'assets/game-tower.svg',
  blocks: 'assets/game-blocks.svg',
  flyer: 'assets/game-flyer.svg',
};

const arcadeState = { games: [], sessionId: null, currentGame: null, difficulty: 'easy', cleanup: null };

const ArcadeSound = (() => {
  let ctx = null;
  let musicTimer = null;
  let musicStep = 0;
  let unlocked = false;
  // Global mute — remembered per device so the choice survives reloads.
  let muted = (() => { try { return localStorage.getItem('dltx_muted') === '1'; } catch { return false; } })();
  const melody = [262, 330, 392, 523, 440, 392, 330, 294];
  function context() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  // WebView/mobile block audio until a user gesture. Resume the context and
  // play a silent buffer inside the gesture so later programmatic sounds work.
  function unlock() {
    try {
      const audio = context();
      if (audio.state === 'suspended') audio.resume().catch(() => {});
      if (!unlocked) {
        const buf = audio.createBuffer(1, 1, 22050);
        const src = audio.createBufferSource();
        src.buffer = buf;
        src.connect(audio.destination);
        src.start(0);
        unlocked = true;
      }
    } catch { /* audio is optional */ }
  }
  function tone(freq, duration, type = 'sine', gain = 0.045, delay = 0) {
    if (muted) return;
    try {
      const audio = context();
      const start = audio.currentTime + delay;
      const osc = audio.createOscillator();
      const vol = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      vol.gain.setValueAtTime(0.0001, start);
      vol.gain.exponentialRampToValueAtTime(gain, start + 0.012);
      vol.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(vol).connect(audio.destination);
      osc.start(start);
      osc.stop(start + duration + 0.02);
    } catch {
      /* sound is optional */
    }
  }
  function startMusic() {
    if (musicTimer) return;
    if (muted) return;
    musicStep = 0;
    musicTimer = setInterval(() => {
      const root = melody[musicStep % melody.length];
      const harmony = musicStep % 2 === 0 ? root * 1.5 : root * 1.25;
      tone(root, 0.16, 'triangle', 0.012);
      tone(harmony, 0.12, 'sine', 0.007, 0.03);
      musicStep++;
    }, 420);
  }
  function stopMusic() {
    if (!musicTimer) return;
    clearInterval(musicTimer);
    musicTimer = null;
  }
  function setMuted(v) {
    muted = !!v;
    try { localStorage.setItem('dltx_muted', muted ? '1' : '0'); } catch { /* storage optional */ }
    if (muted) stopMusic();
  }
  return {
    unlock,
    setMuted,
    isMuted: () => muted,
    tap: () => tone(520, 0.055, 'triangle', 0.028),
    start: () => { tone(392, 0.08, 'triangle'); tone(588, 0.1, 'triangle', 0.045, 0.08); },
    win: () => { tone(523, 0.09, 'sine'); tone(659, 0.09, 'sine', 0.045, 0.09); tone(784, 0.16, 'sine', 0.05, 0.18); },
    lose: () => { tone(330, 0.1, 'sawtooth', 0.028); tone(247, 0.16, 'sawtooth', 0.025, 0.1); },
    // Celebratory rising arpeggio for claims, spins, chests and box wins.
    reward: () => {
      tone(659, 0.1, 'sine', 0.05);
      tone(784, 0.1, 'sine', 0.05, 0.09);
      tone(988, 0.16, 'sine', 0.055, 0.18);
      tone(1319, 0.24, 'sine', 0.05, 0.28);
    },
    // Quick two-note coin blip for smaller rewards.
    coin: () => { tone(988, 0.06, 'square', 0.035); tone(1319, 0.12, 'square', 0.035, 0.05); },
    startMusic,
    stopMusic,
  };
})();
// Expose for the wallet/rewards flow (app.js) and unlock audio on first gesture.
window.ArcadeSound = ArcadeSound;
['pointerdown', 'touchstart', 'click', 'keydown'].forEach((ev) =>
  document.addEventListener(ev, () => ArcadeSound.unlock(), { passive: true })
);

// ---------- Deltix Hour (Mystery Hour) ----------
// One unpredictable 60-minute window per day when arcade wins pay a multiplier.
let mhAnnouncedFor = null;
let mhTimer = null;
function updateMhCountdown(endsAt) {
  const sub = gel('mysteryHourSub');
  if (!sub || !endsAt) return;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) { applyMysteryHour({ active: false }); return; }
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  sub.textContent = `2× game rewards · ends in ${m}:${String(s).padStart(2, '0')}`;
}
function applyMysteryHour(mh) {
  const banner = gel('mysteryHourBanner');
  const title = gel('mysteryHourTitle');
  const sub = gel('mysteryHourSub');
  if (!banner) return;
  if (!mh || !mh.active) {
    // Idle teaser — always visible so the feature is discoverable.
    banner.classList.add('idle');
    if (title) title.textContent = 'Deltix Hour';
    if (sub) sub.textContent = '2× rewards strike at a surprise time each day';
    if (mhTimer) { clearInterval(mhTimer); mhTimer = null; }
    mhAnnouncedFor = null;
    return;
  }
  banner.classList.remove('idle');
  if (title) title.textContent = 'DELTIX HOUR IS LIVE';
  updateMhCountdown(mh.endsAt);
  if (mhTimer) clearInterval(mhTimer);
  mhTimer = setInterval(() => updateMhCountdown(mh.endsAt), 1000);
  // Announce once per live window.
  if (mhAnnouncedFor !== mh.endsAt) {
    mhAnnouncedFor = mh.endsAt;
    try { window.ArcadeSound?.reward?.(); } catch {}
    toast(`⏳ DELTIX HOUR IS LIVE — ${mh.multiplier}× game rewards for the next hour!`);
  }
}
async function checkMysteryHour() {
  if (typeof state === 'undefined' || !state.token) return;
  try { applyMysteryHour(await api('GET', '/arcade/mystery-hour')); } catch {}
}
window.checkMysteryHour = checkMysteryHour;

// ---------- Arcade tab ----------
function gameCardHtml(g) {
  const locked = g.energyUnlock && !(window.isGameUnlocked && window.isGameUnlocked(g.id));
  return `<button class="game-card game-card-${g.id} ${locked ? 'locked' : ''}" data-game="${g.id}">
      ${g.energyUnlock ? `<span class="g-energy-badge">${locked ? '🔒 ' + g.energyUnlock + ' ⚡' : '✅ Unlocked'}</span>` : ''}
      <div class="game-card-img-wrap"><img src="${ARCADE_3D_IMAGES[g.id] || 'assets/nav-arcade.svg'}" class="game-card-3d-img" alt="${g.name}" /></div>
      <div class="game-card-info">
        <span class="g-name"><span class="g-emoji">${ARCADE_EMOJI[g.id] || '🎮'}</span> ${g.name}</span>
        <span class="g-tag">${g.tagline}</span>
      </div>
    </button>`;
}

async function loadArcade() {
  try {
    const a = await api('GET', '/arcade');
    arcadeState.games = a.games;
    applyMysteryHour(a.mysteryHour);
    gel('arcadeMeta').innerHTML = [
      ['🏆 Reward per win', `${a.arcade.rewardEasyWin} (easy) / ${a.arcade.rewardHardWin} (hard) $DLTX`],
      ['💰 Earned today', `${fmt(a.earnedToday)} $DLTX`],
      ['⏳ Remaining today', `${fmt(a.remainingToday)} of ${fmt(a.arcade.dailyCap)} $DLTX`],
    ]
      .map(([k, v]) => `<div class="supply-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join('');
    const crew = gel('crewStrip');
    if (crew) {
      crew.innerHTML = ARCADE_CREW.map(
        (c) => `<div class="crew-chip"><span class="crew-emoji">${c.emoji}</span><span class="crew-name">${c.name}</span><span class="crew-role">${c.role}</span></div>`
      ).join('');
    }
    const bonus = a.games.filter((g) => g.energyUnlock);
    const core = a.games.filter((g) => !g.energyUnlock);
    gel('gamesGrid').innerHTML = core.map(gameCardHtml).join('');
    const bonusGrid = gel('bonusGamesGrid');
    if (bonusGrid) bonusGrid.innerHTML = bonus.map(gameCardHtml).join('');
    document.querySelectorAll('#gamesGrid .game-card, #bonusGamesGrid .game-card').forEach((c) =>
      c.addEventListener('click', () => openGame(c.dataset.game))
    );
    renderInstantGames();
  } catch (e) {
    if (gel('arcadeMeta')) gel('arcadeMeta').innerHTML = `<div class="supply-row"><span>${e.message}</span></div>`;
  }
}

// ---------- Game modal flow ----------
function openGame(id) {
  const g = arcadeState.games.find((x) => x.id === id);
  if (!g) return;
  arcadeState.currentGame = g;
  arcadeState.difficulty = 'easy';
  gel('gameTitle').textContent = `${ARCADE_EMOJI[g.id] || '🎮'} ${g.name}`;
  gel('gameTagline').textContent = g.tagline;
  updateRewardHint();
  gel('diffEasy').classList.add('active');
  gel('diffHard').classList.remove('active');
  renderGameLock();
  gel('gameSetup').hidden = false;
  gel('gameArea').hidden = true;
  gel('gameModal').hidden = false;
  if (window.updateTabAd) window.updateTabAd();
}

/** Bonus games stay behind an Energy paywall until the player spends Energy. */
function renderGameLock() {
  const g = arcadeState.currentGame;
  const locked = g.energyUnlock && !(window.isGameUnlocked && window.isGameUnlocked(g.id));
  gel('gameLocked').hidden = !locked;
  gel('gamePlayable').hidden = !!locked;
  if (!locked) return;
  const have = window.energyBalance ? window.energyBalance() : 0;
  gel('lockCost').textContent = `⚡ ${g.energyUnlock} Energy to unlock`;
  gel('lockBalance').textContent =
    have >= g.energyUnlock ? `You have ${have} ⚡ — ready to unlock!` : `You have ${have} ⚡ — ${g.energyUnlock - have} more needed`;
  gel('unlockGameBtn').disabled = have < g.energyUnlock;
}
gel('unlockGameBtn')?.addEventListener('click', async (ev) => {
  const g = arcadeState.currentGame;
  if (!g || !window.unlockGameWithEnergy) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  const r = await window.unlockGameWithEnergy(g.id);
  if (!r.ok) {
    toast(r.message || 'Could not unlock right now — please try again.');
    renderGameLock();
    return;
  }
  toast(r.already ? `${g.name} is already yours 🎮` : `${g.name} unlocked! 🎉`);
  renderGameLock();
  loadArcade().catch(() => {});
});
gel('getEnergyBtn')?.addEventListener('click', () => {
  closeGame();
  showTab('tab-energy');
});
function updateRewardHint() {
  const g = arcadeState.currentGame;
  if (!g) return;
  const r = arcadeState.difficulty === 'hard' ? g.rewardHard : g.rewardEasy;
  gel('gameRewardHint').textContent = `Win to earn ${r} $DLTX (daily cap applies).`;
}
document.querySelectorAll('.diff-btn').forEach((b) =>
  b.addEventListener('click', () => {
    arcadeState.difficulty = b.dataset.diff;
    document.querySelectorAll('.diff-btn').forEach((x) => x.classList.toggle('active', x === b));
    updateRewardHint();
  })
);
gel('quitGame').addEventListener('click', closeGame);
function closeGame() {
  ArcadeSound.stopMusic();
  if (arcadeState.cleanup) arcadeState.cleanup();
  arcadeState.cleanup = null;
  arcadeState.sessionId = null;
  gel('gameMount').innerHTML = '';
  gel('gameModal').hidden = true;
  if (window.hideGameOverAd) window.hideGameOverAd();
  if (window.updateTabAd) window.updateTabAd();
}
// Exposed so app.js can close an open game (back button, or a session that
// expired mid-game) without both files depending on each other's internals.
window.closeGame = closeGame;

gel('startGameBtn').addEventListener('click', async () => {
  gel('startGameBtn').disabled = true;
  ArcadeSound.unlock(); // unlock inside the gesture before the awaited session call
  try {
    await startSession();
  } catch (e) {
    toast(e.message);
  } finally {
    gel('startGameBtn').disabled = false;
  }
});

async function startSession() {
  const g = arcadeState.currentGame;
  if (!g) return; // modal was never opened for a game (defensive)
  const r = await api('POST', '/arcade/session/start', { game: g.id, difficulty: arcadeState.difficulty });
  arcadeState.sessionId = r.sessionId;
  gel('gameSetup').hidden = true;
  gel('gameArea').hidden = false;
  const mount = gel('gameMount');
  mount.innerHTML = '';
  ArcadeSound.start();
  ArcadeSound.startMusic();
  const tapSound = (e) => {
    if (e.target.closest('button, canvas, .cell')) ArcadeSound.tap();
  };
  mount.addEventListener('pointerdown', tapSound, { passive: true });
  const gameCleanup = GAME_IMPL[g.id](mount, arcadeState.difficulty, finishGame, setGameStatus);
  arcadeState.cleanup = () => {
    mount.removeEventListener('pointerdown', tapSound);
    if (gameCleanup) gameCleanup();
  };
}

/** End-of-game actions — always give a way to replay or leave without scrolling hunts. */
function showEndActions() {
  const mount = gel('gameMount');
  mount.querySelector('.game-end-actions')?.remove();
  const row = document.createElement('div');
  row.className = 'game-end-actions';
  const again = document.createElement('button');
  again.className = 'btn primary';
  again.textContent = '↻ Play again';
  again.addEventListener('click', async () => {
    again.disabled = true;
    try {
      if (window.hideGameOverAd) window.hideGameOverAd();
      if (arcadeState.cleanup) arcadeState.cleanup();
      arcadeState.cleanup = null;
      await startSession();
    } catch (e) {
      toast(e.message);
      again.disabled = false;
    }
  });
  const quit = document.createElement('button');
  quit.className = 'btn ghost';
  quit.textContent = '✕ Quit game';
  quit.addEventListener('click', closeGame);
  row.append(again, quit);
  mount.appendChild(row);
  // Scroll only after the MREC (and #gameMount's ad padding) exist — otherwise
  // tall games leave the buttons exactly under the native ad overlay.
  const adShown = window.showGameOverAd ? window.showGameOverAd() : Promise.resolve();
  Promise.resolve(adShown).then(() =>
    row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  );
}

function setGameStatus(text) {
  gel('gameStatus').textContent = text;
}

async function finishGame(won, score) {
  if (!arcadeState.sessionId) return;
  ArcadeSound.stopMusic();
  if (won) ArcadeSound.win();
  else ArcadeSound.lose();
  const sessionId = arcadeState.sessionId;
  arcadeState.sessionId = null;
  try {
    // Wins pay $DLTX directly — rewarded ads never gate rewards (AdMob policy:
    // ad rewards must be non-transferable; $DLTX is transferable P2P).
    const payload = { won, score, ...(won ? await getIntegrityPayload() : {}) };
    const r = await api('POST', `/arcade/session/${sessionId}/complete`, payload);
    if (r.won && r.tooFast) {
      setGameStatus('You won — but too fast to count. Play a full game to earn.');
    } else if (r.won && r.reward > 0) {
      const boosted = r.mysteryHour && r.mysteryHour.active;
      setGameStatus(`You won! +${fmt(r.reward)} $DLTX earned 🏆`);
      (window.celebrate || toast)({
        amount: r.reward,
        title: boosted ? 'Double Reward! ⏳' : 'Victory Reward!',
        subtitle: boosted ? 'Deltix Hour 2× applied — added to your wallet!' : 'Game winnings added to your wallet.',
        icon: '🏆',
      });
      Promise.all([loadWallet(), loadTx(), loadArcade()]).catch(() => {});
    } else if (r.won && r.capped) {
      setGameStatus('You won — but today\u2019s reward cap is reached. Come back tomorrow!');
    } else {
      setGameStatus('Game over — no reward this time. Try again!');
    }
  } catch (e) {
    // A 401/expired session already closed the game modal and sent the user
    // back to sign-in (see api()'s staleSession handling) — don't paint a raw
    // server error into a modal that's no longer visible.
    if (e.status === 401) return;
    setGameStatus(e.message);
  }
  showEndActions();
  maybeShowInterstitial();
}

// NOTE: rewarded ads were removed from the arcade (2026-08-21). AdMob's
// rewarded-ad policy requires rewards to be non-transferable, and $DLTX is
// P2P-transferable — so wins now pay directly and no ad ever grants $DLTX.
// Banner + interstitial formats remain (they carry no reward).

// ---------- Interstitial (native only, frequency-capped) ----------
// Shown at most every 2nd completed game AND never sooner than 45s apart —
// conservative enough to stay well inside AdMob's policy limits.
function maybeShowInterstitial() {
  if (window.ADS_ENABLED === false) return;
  const cap = window.Capacitor;
  const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !AdMob) return;
  gamesSinceInterstitial++;
  const cooledDown = Date.now() - lastInterstitialAt > 45000;
  if (gamesSinceInterstitial < 2 || !cooledDown) return;
  gamesSinceInterstitial = 0;
  lastInterstitialAt = Date.now();
  AdMob.prepareInterstitial({ adId: ADMOB_INTERSTITIAL_ID, isTesting: ADMOB_TESTING })
    .then(() => AdMob.showInterstitial())
    .catch(() => {});
}

// ---------- shared helpers ----------
function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/** Human-like AI: variable "thinking" pause so opponents never reply instantly. */
function humanPause(min = 450, max = 1200) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}
/** A casual, human-sounding "thinking" status line for a named opponent. */
function aiThinkLine(name) {
  const lines = ['is thinking…', 'is studying the board…', 'takes a moment…', 'is planning a move…', 'hmm… deciding…'];
  return `${name} ${lines[Math.floor(Math.random() * lines.length)]}`;
}
function makeGrid(mount, cols, cls) {
  const g = document.createElement('div');
  g.className = 'board ' + cls;
  g.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  mount.appendChild(g);
  return g;
}
/** Swipe + arrow-key direction input. Returns cleanup fn. */
function directionInput(mount, onDir) {
  const keyMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const onKey = (e) => {
    if (keyMap[e.key]) {
      e.preventDefault();
      onDir(keyMap[e.key]);
    }
  };
  document.addEventListener('keydown', onKey);
  let sx = 0, sy = 0;
  const ts = (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; };
  const te = (e) => {
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    onDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
  };
  mount.addEventListener('touchstart', ts, { passive: true });
  mount.addEventListener('touchend', te, { passive: true });
  const pad = document.createElement('div');
  pad.className = 'dpad';
  pad.innerHTML = `<button data-d="up">▲</button><div class="dpad-mid"><button data-d="left">◀</button><button data-d="right">▶</button></div><button data-d="down">▼</button>`;
  pad.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onDir(b.dataset.d)));
  mount.appendChild(pad);
  return () => {
    document.removeEventListener('keydown', onKey);
    mount.removeEventListener('touchstart', ts);
    mount.removeEventListener('touchend', te);
  };
}

// ═════════════════════════ GAMES ═════════════════════════
const GAME_IMPL = {};

// ---- 1. Tic-Tac-Toe (vs AI: easy random, hard minimax) ----
GAME_IMPL.tictactoe = (mount, diff, finish, status) => {
  const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  let board = Array(9).fill(null);
  let over = false;
  const winner = (b) => {
    for (const [a, c, d] of LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
    return b.every(Boolean) ? 'draw' : null;
  };
  const minimax = (b, player) => {
    const w = winner(b);
    if (w === 'O') return { score: 1 };
    if (w === 'X') return { score: -1 };
    if (w === 'draw') return { score: 0 };
    let best = null;
    for (let i = 0; i < 9; i++) {
      if (b[i]) continue;
      b[i] = player;
      const s = minimax(b, player === 'O' ? 'X' : 'O').score;
      b[i] = null;
      if (!best || (player === 'O' ? s > best.score : s < best.score)) best = { score: s, move: i };
    }
    return best;
  };
  const grid = makeGrid(mount, 3, 'ttt');
  const cells = [];
  for (let i = 0; i < 9; i++) {
    const c = document.createElement('button');
    c.className = 'cell';
    c.addEventListener('click', () => play(i));
    grid.appendChild(c);
    cells.push(c);
  }
  let aiBusy = false;
  const winLine = (b) => LINES.find(([a, c, d]) => b[a] && b[a] === b[c] && b[a] === b[d]) || null;
  function render(placed) {
    board.forEach((v, i) => {
      cells[i].textContent = v === 'X' ? '◆' : v === 'O' ? '○' : '';
      cells[i].classList.toggle('p1', v === 'X');
      cells[i].classList.toggle('p2', v === 'O');
    });
    if (placed != null) {
      cells[placed].classList.remove('pop');
      void cells[placed].offsetWidth; // restart the pop animation
      cells[placed].classList.add('pop');
    }
  }
  function end(w) {
    over = true;
    const L = winLine(board);
    if (L) L.forEach((i) => cells[i].classList.add('win'));
    if (w === 'X') { status('You beat Maya! 🏆'); finish(true, 1); }
    else { status(w === 'draw' ? 'Draw — Maya defends well. No reward, play again!' : 'Maya takes this one!'); finish(false, 0); }
  }
  function mayaMove() {
    aiBusy = true;
    status(aiThinkLine('Maya'));
    setTimeout(() => {
      if (over) return;
      const empty = board.map((v, j) => (v ? null : j)).filter((v) => v !== null);
      if (!empty.length) return;
      // Maya is strong but human — she slips sometimes, more often on easy.
      const slip = Math.random() < (diff === 'hard' ? 0.12 : 0.42);
      const move = slip ? empty[Math.floor(Math.random() * empty.length)] : minimax(board.slice(), 'O').move;
      board[move] = 'O';
      render(move);
      aiBusy = false;
      const w = winner(board);
      if (w) end(w);
      else status(['Your move — you are ◆', 'Maya waits… your turn.', 'Your turn — pick a square.'][Math.floor(Math.random() * 3)]);
    }, 500 + Math.random() * 900);
  }
  function play(i) {
    if (over || board[i] || aiBusy) return;
    board[i] = 'X';
    render(i);
    const w = winner(board);
    if (w) return end(w);
    mayaMove();
  }
  // Coin toss for the opening move — like a real opponent.
  if (Math.random() < 0.5) {
    status('Maya won the toss — she opens.');
    mayaMove();
  } else {
    status('You won the toss — you are ◆, Maya plays ○.');
  }
  return () => {};
};

// ---- 2. Memory Match (duel vs Iris — near-photographic recall) ----
GAME_IMPL.memory = (mount, diff, finish, status) => {
  const glyphs = ['◆','●','▲','■','★','✚','☾','⬟','✿','⬢'];
  const pairs = diff === 'hard' ? 10 : 6;
  const recall = diff === 'hard' ? 0.9 : 0.5; // chance Iris memorizes a revealed card
  const deck = shuffleArr(glyphs.slice(0, pairs).flatMap((g) => [g, g]));
  const grid = makeGrid(mount, 4, 'memory');
  const cells = [];
  let open = [], pairsMe = 0, pairsIris = 0, lock = false, stopped = false;
  const done = new Set();
  const irisMem = new Map(); // index -> glyph
  deck.forEach((glyph, i) => {
    const c = document.createElement('button');
    c.className = 'cell face-down';
    c.addEventListener('click', () => playerFlip(i));
    grid.appendChild(c);
    cells.push(c);
  });
  const score = () => `You ${pairsMe} · Iris ${pairsIris} — first to more pairs wins`;
  function reveal(i) {
    cells[i].textContent = deck[i];
    cells[i].classList.remove('face-down');
    if (Math.random() < recall) irisMem.set(i, deck[i]); // Iris watches every flip
  }
  function hide(i) {
    cells[i].textContent = '';
    cells[i].classList.add('face-down');
  }
  function settle(a, b, who) {
    if (deck[a] !== deck[b]) return false;
    cells[a].classList.add('done', who);
    cells[b].classList.add('done', who);
    done.add(a); done.add(b);
    irisMem.delete(a); irisMem.delete(b);
    if (who === 'iris') pairsIris++; else pairsMe++;
    return true;
  }
  function maybeEnd() {
    if (pairsMe + pairsIris < pairs) return false;
    if (pairsMe > pairsIris) { status(`You out-remembered Iris ${pairsMe}–${pairsIris}! 🏆`); finish(true, pairsMe); }
    else { status(pairsMe === pairsIris ? `Draw ${pairsMe}–${pairsIris} — no reward. Rematch?` : `Iris wins ${pairsIris}–${pairsMe}. She never forgets!`); finish(false, pairsMe); }
    return true;
  }
  function playerFlip(i) {
    if (lock || stopped || done.has(i) || open.includes(i)) return;
    reveal(i);
    open.push(i);
    if (open.length < 2) return;
    const [a, b] = open;
    open = [];
    if (settle(a, b, 'me')) {
      if (maybeEnd()) return;
      status(`Pair! Go again · ${score()}`);
    } else {
      lock = true;
      setTimeout(() => {
        if (stopped) return;
        hide(a); hide(b);
        irisTurn();
      }, 750);
    }
  }
  const alive = () => deck.map((_, i) => i).filter((i) => !done.has(i));
  function knownPair() {
    const byGlyph = {};
    for (const [i, g] of irisMem) {
      if (byGlyph[g] != null) return [byGlyph[g], i];
      byGlyph[g] = i;
    }
    return null;
  }
  function irisPick() {
    const pair = knownPair();
    if (pair) return pair;
    const unknown = alive().filter((i) => !irisMem.has(i));
    const first = unknown.length ? unknown[Math.floor(Math.random() * unknown.length)] : alive()[0];
    return [first, null];
  }
  function irisTurn() {
    lock = true;
    status(aiThinkLine('Iris'));
    setTimeout(() => {
      if (stopped) return;
      let [a, b] = irisPick();
      reveal(a);
      irisMem.set(a, deck[a]); // she certainly remembers her own flip
      setTimeout(() => {
        if (stopped) return;
        if (b == null) {
          // partner of the card just revealed, if she remembers it
          for (const [j, g] of irisMem) if (j !== a && g === deck[a] && !done.has(j)) { b = j; break; }
          if (b == null) {
            const rest = alive().filter((i) => i !== a);
            const unknown = rest.filter((i) => !irisMem.has(i));
            b = (unknown.length ? unknown : rest)[Math.floor(Math.random() * (unknown.length ? unknown.length : rest.length))];
          }
        }
        reveal(b);
        irisMem.set(b, deck[b]);
        setTimeout(() => {
          if (stopped) return;
          if (settle(a, b, 'iris')) {
            if (maybeEnd()) return;
            status(`Iris pairs up and goes again · ${score()}`);
            irisTurn();
          } else {
            hide(a); hide(b);
            lock = false;
            status(`Your turn · ${score()}`);
          }
        }, 800);
      }, 550 + Math.random() * 450);
    }, 600 + Math.random() * 700);
  }
  // Coin toss for the opening turn
  if (Math.random() < 0.5) {
    status('Iris won the toss — she flips first.');
    irisTurn();
  } else {
    status(`You flip first · find pairs to keep your turn`);
  }
  return () => { stopped = true; };
};

// ---- 3. Delta Snake (food race vs Rex — a rival snake with pathfinding) ----
GAME_IMPL.snake = (mount, diff, finish, status) => {
  const N = 15, C = 20;
  const target = diff === 'hard' ? 8 : 5;
  const wander = diff === 'hard' ? 0.24 : 0.55; // how often Rex drifts off the optimal path
  let speed = diff === 'hard' ? 125 : 175;
  const minSpeed = diff === 'hard' ? 90 : 135;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N * C;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  let snake = [{ x: 3, y: 7 }], dir = 'right', nextDir = 'right', eaten = 0;
  let rex = [{ x: 11, y: 7 }], rexEaten = 0, food = null, timer = null, over = false, pulse = 0;
  const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const cleanupInput = directionInput(mount, (d) => { if (d !== opposite[dir]) nextDir = d; });
  const occupied = (x, y) => snake.some((s) => s.x === x && s.y === y) || rex.some((s) => s.x === x && s.y === y);
  function placeFood() {
    do { food = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) }; }
    while (occupied(food.x, food.y));
  }
  placeFood();
  const score = () => `You ${eaten} · Rex ${rexEaten} — first to ${target} wins`;
  status(`Race Rex to the deltas! ${score()}`);
  function drawSnake(body, headColor, bodyColor, d) {
    body.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? headColor : bodyColor;
      ctx.beginPath();
      ctx.roundRect(s.x * C + 1.5, s.y * C + 1.5, C - 3, C - 3, i === 0 ? 7 : 5);
      ctx.fill();
    });
    // eyes on the head, offset toward travel direction
    const h = body[0];
    const off = { up: [0, -3], down: [0, 3], left: [-3, 0], right: [3, 0] }[d] || [3, 0];
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(h.x * C + 7 + off[0], h.y * C + 8 + off[1], 2.6, 0, 7);
    ctx.arc(h.x * C + 13 + off[0], h.y * C + 8 + off[1], 2.6, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(h.x * C + 7 + off[0], h.y * C + 8 + off[1], 1.2, 0, 7);
    ctx.arc(h.x * C + 13 + off[0], h.y * C + 8 + off[1], 1.2, 0, 7);
    ctx.fill();
  }
  function rexDir() {
    const h = rex[0], prev = rex[1];
    return prev ? (h.x > prev.x ? 'right' : h.x < prev.x ? 'left' : h.y > prev.y ? 'down' : 'up') : 'left';
  }
  function draw() {
    ctx.fillStyle = '#f4f7ff'; ctx.fillRect(0, 0, N * C, N * C);
    ctx.fillStyle = '#e9efff';
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if ((r + c) % 2) ctx.fillRect(c * C, r * C, C, C);
    // pulsing delta food
    const g = 2 + Math.sin(pulse * 0.35) * 1.5;
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.moveTo(food.x * C + 10, food.y * C + 3 - g * 0.4);
    ctx.lineTo(food.x * C + 17 + g * 0.4, food.y * C + 10);
    ctx.lineTo(food.x * C + 10, food.y * C + 17 + g * 0.4);
    ctx.lineTo(food.x * C + 3 - g * 0.4, food.y * C + 10);
    ctx.fill();
    drawSnake(rex, '#b45309', '#f59e0b', rexDir());
    drawSnake(snake, '#1244b8', '#1f66f2', dir);
  }
  function respawnRex() {
    const corners = [{ x: 0, y: 0 }, { x: N - 1, y: 0 }, { x: 0, y: N - 1 }, { x: N - 1, y: N - 1 }];
    const spot = corners.find((c) => !occupied(c.x, c.y)) || { x: N - 1, y: 0 };
    rex = [spot];
    status(`Rex crashed and respawns! ${score()}`);
  }
  function rexMove() {
    const h = rex[0];
    const dirs = [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }];
    const options = dirs
      .map((d) => ({ x: h.x + d.x, y: h.y + d.y }))
      .filter((o) => o.x >= 0 && o.y >= 0 && o.x < N && o.y < N && !occupied(o.x, o.y));
    if (!options.length) return respawnRex();
    let pick;
    if (Math.random() < wander) pick = options[Math.floor(Math.random() * options.length)];
    else {
      options.sort((a, b) => (Math.abs(a.x - food.x) + Math.abs(a.y - food.y)) - (Math.abs(b.x - food.x) + Math.abs(b.y - food.y)));
      pick = options[0];
    }
    rex.unshift(pick);
    if (pick.x === food.x && pick.y === food.y) {
      rexEaten++;
      if (rexEaten >= target) { stop(); draw(); status(`Rex hits ${target} first — he takes it! 🐍`); return finish(false, eaten); }
      status(`Rex snatched that one! ${score()}`);
      placeFood();
    } else rex.pop();
  }
  function stop() { over = true; clearInterval(timer); }
  function tick() {
    if (over) return;
    pulse++;
    dir = nextDir;
    const h = { ...snake[0] };
    if (dir === 'up') h.y--; if (dir === 'down') h.y++;
    if (dir === 'left') h.x--; if (dir === 'right') h.x++;
    if (h.x < 0 || h.y < 0 || h.x >= N || h.y >= N || occupied(h.x, h.y)) {
      stop();
      status(rex.some((s) => s.x === h.x && s.y === h.y) ? 'You ran into Rex! Game over.' : 'Crashed! Game over.');
      return finish(false, eaten);
    }
    snake.unshift(h);
    if (h.x === food.x && h.y === food.y) {
      eaten++;
      if (eaten >= target) { stop(); draw(); status(`You beat Rex to ${target}! 🏆`); return finish(true, eaten); }
      status(`Delta! ${score()}`);
      placeFood();
      // speed ramps up with every delta you eat
      if (speed > minSpeed) {
        speed -= 5;
        clearInterval(timer);
        timer = setInterval(tick, speed);
      }
    } else snake.pop();
    if (!over) rexMove();
    if (!over) draw();
  }
  draw();
  timer = setInterval(tick, speed);
  return () => { stop(); cleanupInput(); };
};

// ---- 4. Merge 2048 (slide & merge — with Δ blocker crystals) ----
GAME_IMPL.merge = (mount, diff, finish, status) => {
  const target = diff === 'hard' ? 512 : 128;
  const blockerEvery = diff === 'hard' ? 12 : 20;  // moves between Δ crystal spawns
  const blockerTtl = diff === 'hard' ? 16 : 10;   // moves before a crystal dissolves
  let grid = Array.from({ length: 4 }, () => Array(4).fill(0));
  let score = 0, over = false, moves = 0, blockerSeq = 0;
  const blockers = new Map(); // negative id -> moves remaining
  const board = makeGrid(mount, 4, 'merge');
  const cells = [];
  for (let i = 0; i < 16; i++) {
    const c = document.createElement('div');
    c.className = 'cell tile';
    board.appendChild(c);
    cells.push(c);
  }
  const emptySpots = () => {
    const empty = [];
    grid.forEach((row, r) => row.forEach((v, c) => { if (!v) empty.push([r, c]); }));
    return empty;
  };
  function addTile() {
    const empty = emptySpots();
    if (!empty.length) return;
    const [r, c] = empty[Math.floor(Math.random() * empty.length)];
    grid[r][c] = Math.random() < 0.9 ? 2 : 4;
  }
  function addBlocker() {
    const empty = emptySpots();
    if (!empty.length || blockers.size >= 3) return false;
    const [r, c] = empty[Math.floor(Math.random() * empty.length)];
    const id = -(++blockerSeq);
    grid[r][c] = id;
    blockers.set(id, blockerTtl);
    return true;
  }
  const best = () => Math.max(0, ...grid.flat().filter((v) => v > 0));
  function render(prev) {
    grid.forEach((row, r) => row.forEach((v, c) => {
      const el = cells[r * 4 + c];
      el.textContent = v < 0 ? 'Δ' : v || '';
      el.dataset.v = v < 0 ? 'blocker' : v > 2048 ? 'max' : v;
      if (prev && v && v !== prev[r][c]) {
        el.classList.remove('pop');
        void el.offsetWidth;
        el.classList.add('pop');
      }
    }));
  }
  const baseline = () => `Reach ${target} · score ${score} · best ${best()}`;
  function slideRow(row) {
    const vals = row.filter(Boolean);
    const out = [];
    let moved = false;
    for (let i = 0; i < vals.length; i++) {
      // Δ crystals have unique negative values, so they can never merge
      if (vals[i] > 0 && vals[i] === vals[i + 1]) { out.push(vals[i] * 2); score += vals[i] * 2; i++; }
      else out.push(vals[i]);
    }
    while (out.length < 4) out.push(0);
    if (out.some((v, i) => v !== row[i])) moved = true;
    return { out, moved };
  }
  function move(d) {
    if (over) return;
    let moved = false;
    const rotate = (g) => g[0].map((_, c) => g.map((row) => row[c]).reverse());
    // rotate() is clockwise: 1 turn aligns "down" with the leftward slide, 3 turns align "up".
    let turns = { left: 0, down: 1, right: 2, up: 3 }[d];
    let g = grid;
    for (let i = 0; i < turns; i++) g = rotate(g);
    g = g.map((row) => {
      const r = slideRow(row);
      if (r.moved) moved = true;
      return r.out;
    });
    for (let i = 0; i < (4 - turns) % 4; i++) g = rotate(g);
    if (!moved) return;
    const prev = grid.map((row) => row.slice());
    grid = g;
    moves++;
    let note = '';
    // dissolve expired crystals
    for (const [id, left] of [...blockers]) {
      if (left - 1 <= 0) {
        blockers.delete(id);
        grid.forEach((row, r) => row.forEach((v, c) => { if (v === id) grid[r][c] = 0; }));
        note = ' · a Δ crystal dissolved';
      } else blockers.set(id, left - 1);
    }
    if (moves % blockerEvery === 0 && addBlocker()) {
      note = ` · Δ crystal! Dissolves in ${blockerTtl} moves`;
    } else {
      addTile();
    }
    render(prev);
    status(baseline() + note);
    if (grid.flat().some((v) => v >= target)) { over = true; status(`${target} reached — you win! 🏆`); return finish(true, score); }
    const stuck = !grid.flat().includes(0) &&
      !grid.some((row, r) => row.some((v, c) =>
        (v > 0 && c < 3 && v === grid[r][c + 1]) || (v > 0 && r < 3 && v === grid[r + 1][c])));
    if (stuck) { over = true; status('No moves left — the crystals locked you in.'); finish(false, score); }
  }
  const cleanupInput = directionInput(mount, move);
  addTile(); addTile(); render();
  status(baseline() + ` · beware the Δ crystals`);
  return () => cleanupInput();
};

// ---- 5. Sudoku (strikes — three mistakes and you're out) ----
GAME_IMPL.sudoku = (mount, diff, finish, status) => {
  // Valid full grid from a shuffled base pattern.
  const digits = shuffleArr([1,2,3,4,5,6,7,8,9]);
  const seq = () => shuffleArr([0,1,2]);
  const rows = seq().flatMap((b) => seq().map((r) => b * 3 + r));
  const cols = seq().flatMap((b) => seq().map((c) => b * 3 + c));
  const pattern = (r, c) => (3 * (r % 3) + Math.floor(r / 3) + c) % 9;
  const solved = rows.map((r) => cols.map((c) => digits[pattern(r, c)]));
  const blanks = diff === 'hard' ? 46 : 30;
  const maxStrikes = diff === 'hard' ? 3 : 5;
  const puzzle = solved.map((row) => row.slice());
  shuffleArr(Array.from({ length: 81 }, (_, i) => i)).slice(0, blanks)
    .forEach((i) => (puzzle[Math.floor(i / 9)][i % 9] = 0));

  const board = makeGrid(mount, 9, 'sudoku');
  let selected = null, strikes = 0, over = false;
  const cellEls = [];
  const strikeBar = () => '✖'.repeat(strikes) + '○'.repeat(maxStrikes - strikes);
  const baseline = () => `${puzzle.flat().filter((v) => !v).length} left · mistakes ${strikeBar()}`;
  function highlight() {
    cellEls.forEach((el, i) => {
      const r = Math.floor(i / 9), c = i % 9;
      el.classList.remove('peer', 'same');
      if (!selected) return;
      const sameBox = Math.floor(r / 3) === Math.floor(selected.r / 3) && Math.floor(c / 3) === Math.floor(selected.c / 3);
      if (r === selected.r || c === selected.c || sameBox) el.classList.add('peer');
      const sv = puzzle[selected.r][selected.c];
      if (sv && puzzle[r][c] === sv) el.classList.add('same');
    });
  }
  puzzle.forEach((row, r) => row.forEach((v, c) => {
    const el = document.createElement('button');
    el.className = 'cell s-cell' + (v ? ' given' : '');
    el.textContent = v || '';
    if ((c + 1) % 3 === 0 && c < 8) el.classList.add('bx');
    if ((r + 1) % 3 === 0 && r < 8) el.classList.add('by');
    el.addEventListener('click', () => {
      if (over) return;
      cellEls.forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      selected = { r, c, el };
      highlight();
    });
    board.appendChild(el);
    cellEls.push(el);
  }));
  const pad = document.createElement('div');
  pad.className = 'numpad';
  const padBtns = {};
  for (let n = 1; n <= 9; n++) {
    const b = document.createElement('button');
    b.textContent = n;
    b.addEventListener('click', () => enter(n));
    pad.appendChild(b);
    padBtns[n] = b;
  }
  const erase = document.createElement('button');
  erase.textContent = '⌫';
  erase.addEventListener('click', () => enter(0));
  pad.appendChild(erase);
  mount.appendChild(pad);
  status(`Tap a cell, then a number · ${maxStrikes} mistakes allowed`);
  function retireDigits() {
    for (let n = 1; n <= 9; n++) {
      const count = puzzle.flat().filter((v) => v === n).length;
      padBtns[n].disabled = count >= 9;
      padBtns[n].classList.toggle('used-up', count >= 9);
    }
  }
  const okAt = (b, r, c, n) => {
    for (let i = 0; i < 9; i++) if (b[r][i] === n || b[i][c] === n) return false;
    const br = Math.floor(r / 3) * 3, bc = Math.floor(c / 3) * 3;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (b[br + i][bc + j] === n) return false;
    return true;
  };
  const solvable = (b) => {
    for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) if (!b[r][c]) {
      for (let n = 1; n <= 9; n++) if (okAt(b, r, c, n)) {
        b[r][c] = n;
        if (solvable(b)) { b[r][c] = 0; return true; }
        b[r][c] = 0;
      }
      return false;
    }
    return true;
  };
  // wrong = conflicts with the board, or leaves it unsolvable (valid alternate solutions are accepted)
  const isWrong = (r, c, n) => {
    if (!okAt(puzzle, r, c, n)) return true;
    puzzle[r][c] = n;
    const ok = solvable(puzzle);
    puzzle[r][c] = 0;
    return !ok;
  };
  function enter(n) {
    if (!selected || over || selected.el.classList.contains('given') || selected.el.classList.contains('ok')) return;
    const { r, c, el } = selected;
    if (n === 0) {
      puzzle[r][c] = 0;
      el.textContent = '';
      el.classList.remove('bad');
      status(baseline());
      highlight();
      return;
    }
    if (isWrong(r, c, n)) {
      strikes++;
      el.textContent = n;
      el.classList.add('bad');
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
      setTimeout(() => { if (!over && puzzle[r][c] === 0) { el.textContent = ''; el.classList.remove('bad'); } }, 650);
      if (strikes >= maxStrikes) {
        over = true;
        status(`${strikeBar()} — too many mistakes!`);
        return finish(false, 81 - blanks - puzzle.flat().filter((v) => !v).length);
      }
      status(`Wrong — ${strikeBar()} · careful now`);
      return;
    }
    puzzle[r][c] = n;
    el.textContent = n;
    el.classList.add('ok');
    el.classList.remove('bad', 'pop');
    void el.offsetWidth;
    el.classList.add('pop');
    retireDigits();
    highlight();
    const remaining = puzzle.flat().filter((v) => !v).length;
    if (!remaining) { over = true; status('Solved — flawless logic! 🏆'); return finish(true, blanks); }
    status(baseline());
  }
  return () => {};
};

// ---- 6. Mine Hunt ----
GAME_IMPL.minehunt = (mount, diff, finish, status) => {
  const N = diff === 'hard' ? 10 : 8;
  const mines = diff === 'hard' ? 18 : 9;
  const board = makeGrid(mount, N, 'mines');
  let isMine = new Set(shuffleArr(Array.from({ length: N * N }, (_, i) => i)).slice(0, mines));
  const revealed = new Set(), flagged = new Set();
  let flagMode = false, over = false, firstClick = true;
  const cells = [];
  const neighbors = (i) => {
    const r = Math.floor(i / N), c = i % N, out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nc >= 0 && nr < N && nc < N) out.push(nr * N + nc);
    }
    return out;
  };
  const count = (i) => neighbors(i).filter((n) => isMine.has(n)).length;
  const baseline = () => `${N * N - mines - revealed.size} safe left · ⚑ ${flagged.size}/${mines}`;
  function ensureSafeStart(i) {
    // relocate mines out of the first click and its ring — no luck-based instant losses
    const safeZone = new Set([i, ...neighbors(i)]);
    const moved = [...isMine].filter((m) => safeZone.has(m));
    if (!moved.length) return;
    const free = shuffleArr(Array.from({ length: N * N }, (_, k) => k)
      .filter((k) => !isMine.has(k) && !safeZone.has(k)));
    moved.forEach((m, idx) => { isMine.delete(m); isMine.add(free[idx]); });
  }
  function boom(i) {
    over = true;
    cells[i].textContent = '◆'; cells[i].classList.add('open', 'boom');
    isMine.forEach((m) => { cells[m].textContent = '◆'; cells[m].classList.add('open', 'boom'); });
    flagged.forEach((f) => { if (!isMine.has(f)) { cells[f].textContent = '✖'; cells[f].classList.add('open'); } });
    status('Boom! That was a mine.');
    finish(false, revealed.size);
  }
  function reveal(i) {
    if (revealed.has(i) || flagged.has(i) || over) return;
    if (firstClick) { firstClick = false; ensureSafeStart(i); }
    if (isMine.has(i)) return boom(i);
    revealed.add(i);
    const el = cells[i];
    el.classList.add('open');
    const n = count(i);
    el.textContent = n || '';
    el.dataset.n = n;
    if (!n) neighbors(i).forEach(reveal);
    if (over) return;
    if (revealed.size === N * N - mines) {
      over = true;
      isMine.forEach((m) => { if (!flagged.has(m)) { cells[m].textContent = '⚑'; } });
      status('Field cleared — every mine dodged! 🏆');
      finish(true, revealed.size);
    } else status(baseline());
  }
  function chord(i) {
    // tap an open number with all its flags placed to sweep the rest of its ring
    const n = count(i);
    if (!n) return;
    const around = neighbors(i);
    if (around.filter((k) => flagged.has(k)).length !== n) return;
    around.forEach((k) => { if (!flagged.has(k) && !revealed.has(k) && !over) {
      if (isMine.has(k)) return boom(k);
      reveal(k);
    } });
  }
  for (let i = 0; i < N * N; i++) {
    const el = document.createElement('button');
    el.className = 'cell m-cell';
    el.addEventListener('click', () => {
      if (over) return;
      if (revealed.has(i)) return chord(i);
      if (flagMode) {
        if (flagged.has(i)) { flagged.delete(i); el.textContent = ''; }
        else { flagged.add(i); el.textContent = '⚑'; }
        status(baseline());
      } else reveal(i);
    });
    board.appendChild(el);
    cells.push(el);
  }
  const toggle = document.createElement('button');
  toggle.className = 'btn ghost small';
  toggle.textContent = '⚑ Flag mode: off';
  toggle.addEventListener('click', () => {
    flagMode = !flagMode;
    toggle.textContent = `⚑ Flag mode: ${flagMode ? 'on' : 'off'}`;
  });
  mount.appendChild(toggle);
  status(`${N * N - mines} safe cells · ${mines} mines · first tap is always safe`);
  return () => {};
};

// ---- 7. Slide Puzzle (15-puzzle) ----
GAME_IMPL.slide = (mount, diff, finish, status) => {
  const N = diff === 'hard' ? 5 : 4;
  let tiles = Array.from({ length: N * N }, (_, i) => (i + 1) % (N * N)); // 0 = blank
  // Shuffle with random valid moves so the puzzle is always solvable.
  let blank = N * N - 1;
  for (let k = 0; k < N * N * 80; k++) {
    const r = Math.floor(blank / N), c = blank % N;
    const opts = [];
    if (r > 0) opts.push(blank - N);
    if (r < N - 1) opts.push(blank + N);
    if (c > 0) opts.push(blank - 1);
    if (c < N - 1) opts.push(blank + 1);
    const pick = opts[Math.floor(Math.random() * opts.length)];
    [tiles[blank], tiles[pick]] = [tiles[pick], tiles[blank]];
    blank = pick;
  }
  const budget = diff === 'hard' ? 520 : 320;
  const board = makeGrid(mount, N, 'slide');
  const cells = [];
  for (let i = 0; i < N * N; i++) {
    const el = document.createElement('button');
    el.className = 'cell';
    el.addEventListener('click', () => clickTile(i));
    board.appendChild(el);
    cells.push(el);
  }
  let moves = 0, over = false;
  const solved = () => tiles.every((v, i) => v === (i + 1) % (N * N));
  const placedCount = () => tiles.reduce((n, v, i) => n + (v && v === i + 1 ? 1 : 0), 0);
  function render(changed) {
    tiles.forEach((v, i) => {
      const el = cells[i];
      el.textContent = v || '';
      el.classList.toggle('blank', !v);
      el.classList.toggle('placed', Boolean(v) && v === i + 1);
      el.classList.remove('pop');
      if (changed && changed.includes(i) && v) {
        void el.offsetWidth;
        el.classList.add('pop');
      }
    });
    status(`Moves ${moves}/${budget} · placed ${placedCount()}/${N * N - 1}`);
  }
  function clickTile(i) {
    if (over) return;
    const bi = tiles.indexOf(0);
    const r = Math.floor(i / N), c = i % N, br = Math.floor(bi / N), bc = bi % N;
    if (i === bi || (r !== br && c !== bc)) return;
    // Shift every tile between the clicked one and the blank toward the blank.
    const step = r === br ? (c < bc ? 1 : -1) : (r < br ? N : -N);
    const changed = [];
    let cur = bi;
    while (cur !== i) {
      const next = cur - step;
      tiles[cur] = tiles[next];
      changed.push(cur);
      moves++;
      cur = next;
    }
    tiles[i] = 0;
    render(changed);
    if (solved()) { over = true; finish(true, budget - moves); return; }
    if (moves >= budget) { over = true; finish(false, moves); }
  }
  status(`Order 1 → ${N * N - 1} within ${budget} moves`);
  render();
  return () => {};
};

// ---- 8. Reversi (vs AI) ----
GAME_IMPL.reversi = (mount, diff, finish, status) => {
  const DIRS = [-9, -8, -7, -1, 1, 7, 8, 9];
  let b = Array(64).fill(0); // 1 = you (blue), 2 = AI (white)
  b[27] = 2; b[28] = 1; b[35] = 1; b[36] = 2;
  const W = [ // positional weights for hard AI
    100,-20,10,5,5,10,-20,100, -20,-40,1,1,1,1,-40,-20, 10,1,5,2,2,5,1,10, 5,1,2,1,1,2,1,5,
    5,1,2,1,1,2,1,5, 10,1,5,2,2,5,1,10, -20,-40,1,1,1,1,-40,-20, 100,-20,10,5,5,10,-20,100];
  function flips(board, i, player) {
    if (board[i]) return [];
    const opp = player === 1 ? 2 : 1;
    const out = [];
    for (const d of DIRS) {
      const line = [];
      let j = i;
      for (;;) {
        const pc = j % 8;
        j += d;
        const nc = j % 8;
        if (j < 0 || j >= 64 || Math.abs(nc - pc) > 1) break;
        if (board[j] === opp) line.push(j);
        else if (board[j] === player) { out.push(...line); break; }
        else break;
      }
    }
    return out;
  }
  const movesFor = (board, p) =>
    Array.from({ length: 64 }, (_, i) => i).filter((i) => flips(board, i, p).length);
  const applyMove = (board, i, p) => {
    const nb = board.slice();
    flips(board, i, p).forEach((j) => (nb[j] = p));
    nb[i] = p;
    return nb;
  };
  const discDiff = (board) => board.filter((v) => v === 2).length - board.filter((v) => v === 1).length;
  function evalBoard(board) {
    let s = 0;
    for (let i = 0; i < 64; i++) {
      if (board[i] === 2) s += W[i];
      else if (board[i] === 1) s -= W[i];
    }
    return s + 6 * (movesFor(board, 2).length - movesFor(board, 1).length);
  }
  const ordered = (board, p) =>
    movesFor(board, p).sort((x, y) => W[y] - W[x]);
  function search(board, depth, p, alpha, beta) {
    const opts = movesFor(board, p);
    if (!opts.length) {
      if (!movesFor(board, p === 1 ? 2 : 1).length) {
        const d = discDiff(board);
        return d > 0 ? 10000 + d : d < 0 ? -10000 + d : 0;
      }
      return search(board, depth, p === 1 ? 2 : 1, alpha, beta);
    }
    if (depth === 0) return evalBoard(board);
    if (p === 2) {
      let best = -Infinity;
      for (const m of ordered(board, 2)) {
        best = Math.max(best, search(applyMove(board, m, 2), depth - 1, 1, alpha, beta));
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      return best;
    }
    let best = Infinity;
    for (const m of ordered(board, 1)) {
      best = Math.min(best, search(applyMove(board, m, 1), depth - 1, 2, alpha, beta));
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  // Exact solve of the final empties: maximizes Victor's true disc margin.
  function solveExact(board, p, alpha, beta) {
    const opts = movesFor(board, p);
    if (!opts.length) {
      if (!movesFor(board, p === 1 ? 2 : 1).length) return discDiff(board);
      return solveExact(board, p === 1 ? 2 : 1, alpha, beta);
    }
    if (p === 2) {
      let best = -Infinity;
      for (const m of ordered(board, 2)) {
        best = Math.max(best, solveExact(applyMove(board, m, 2), 1, alpha, beta));
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      return best;
    }
    let best = Infinity;
    for (const m of ordered(board, 1)) {
      best = Math.min(best, solveExact(applyMove(board, m, 1), 2, alpha, beta));
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  const board = makeGrid(mount, 8, 'reversi');
  const cells = [];
  for (let i = 0; i < 64; i++) {
    const el = document.createElement('button');
    el.className = 'cell r-cell';
    el.addEventListener('click', () => play(i));
    board.appendChild(el);
    cells.push(el);
  }
  let stopped = false, myTurn = true, over = false;
  function render(hints, changed, lastMove) {
    b.forEach((v, i) => {
      const flip = changed && changed.includes(i);
      cells[i].innerHTML = v ? `<span class="disc ${v === 1 ? 'you' : 'ai'}${flip ? ' flip' : ''}"></span>` : '';
      cells[i].classList.toggle('hint', Boolean(hints && hints.includes(i)));
      cells[i].classList.toggle('last', i === lastMove);
    });
    const you = b.filter((v) => v === 1).length, ai = b.filter((v) => v === 2).length;
    const empty = 64 - you - ai;
    status(`You ${you} · Victor ${ai} · ${empty} empty${myTurn && !over ? ' · your move' : ''}`);
  }
  function gameEnd() {
    over = true;
    const you = b.filter((v) => v === 1).length, ai = b.filter((v) => v === 2).length;
    finish(you > ai, you);
  }
  function aiTurn() {
    if (stopped || over) return;
    const opts = movesFor(b, 2);
    if (!opts.length) {
      if (!movesFor(b, 1).length) return gameEnd();
      myTurn = true;
      render(movesFor(b, 1));
      return; // Victor passes
    }
    const empties = b.filter((v) => !v).length;
    const exactAt = diff === 'hard' ? 9 : 4;
    const depth = diff === 'hard' ? 3 : 1;
    const scoreMove = (m) => {
      const nb = applyMove(b, m, 2);
      return empties <= exactAt
        ? solveExact(nb, 1, -Infinity, Infinity)
        : search(nb, depth - 1, 1, -Infinity, Infinity);
    };
    const rankedMoves = ordered(b, 2).map((m) => [m, scoreMove(m)]).sort((x, y) => y[1] - x[1]);
    let pick = rankedMoves[0][0];
    if (diff !== 'hard' && rankedMoves.length > 1 && Math.random() < 0.5) {
      pick = rankedMoves[1 + Math.floor(Math.random() * Math.min(2, rankedMoves.length - 1))][0];
    }
    const f = flips(b, pick, 2);
    b = applyMove(b, pick, 2);
    const yours = movesFor(b, 1);
    myTurn = true;
    render(yours, f, pick);
    if (!yours.length) {
      if (!movesFor(b, 2).length) return gameEnd();
      myTurn = false;
      status('No move for you — Victor plays again…');
      setTimeout(aiTurn, 700 + Math.random() * 600); // you pass
    }
  }
  function play(i) {
    if (stopped || over || !myTurn) return;
    const f = flips(b, i, 1);
    if (!f.length) return;
    b = applyMove(b, i, 1);
    myTurn = false;
    render(null, f, i);
    if (!b.includes(0)) return gameEnd();
    const empties = b.filter((v) => !v).length;
    status(diff === 'hard' && empties <= 11 ? 'Victor reads the position to the very end…' : aiThinkLine('Victor'));
    setTimeout(aiTurn, 500 + Math.random() * 800);
  }
  render(movesFor(b, 1));
  return () => { stopped = true; };
};

// ---- 9. Pattern Recall ----
GAME_IMPL.recall = (mount, diff, finish, status) => {
  const target = diff === 'hard' ? 10 : 6;
  const startSpeed = diff === 'hard' ? 480 : 700;
  const minSpeed = diff === 'hard' ? 300 : 430;
  const stepTime = diff === 'hard' ? 2500 : 3800;
  // Hard reverses every 4th round; easy saves one reverse for the finale.
  const reverseRound = (n) => (diff === 'hard' ? n % 5 === 0 : n === target);
  const pads = ['#1f66f2', '#16a34a', '#f59e0b', '#dc2626'];
  const padName = ['blue', 'green', 'amber', 'red'];
  const grid = makeGrid(mount, 2, 'recall');
  const els = pads.map((color, i) => {
    const el = document.createElement('button');
    el.className = 'cell pad';
    el.style.setProperty('--pad', color);
    el.addEventListener('click', () => tap(i));
    grid.appendChild(el);
    return el;
  });
  let seq = [], pos = 0, accepting = false, reversed = false, timers = [], stepTimer = null;
  const speedNow = () => Math.max(minSpeed, startSpeed - (seq.length - 1) * 25);
  function flash(i, ms) {
    els[i].classList.add('lit');
    timers.push(setTimeout(() => els[i].classList.remove('lit'), ms));
  }
  function armStepTimer() {
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      if (!accepting) return;
      accepting = false;
      status(`Too slow — ${stepTime / 1000}s per step. You reached round ${seq.length - 1}.`);
      timers.push(setTimeout(() => finish(false, seq.length - 1), 1000));
    }, stepTime);
    timers.push(stepTimer);
  }
  function playback() {
    accepting = false;
    reversed = reverseRound(seq.length);
    const sp = speedNow();
    status(`Watch… round ${seq.length}/${target}${reversed ? ' · ⟲ REVERSE round!' : ''}`);
    seq.forEach((p, k) => timers.push(setTimeout(() => flash(p, sp * 0.6), k * sp + 300)));
    timers.push(setTimeout(() => {
      accepting = true;
      pos = 0;
      status(reversed
        ? `Your turn — ${seq.length} steps BACKWARD ⟲`
        : `Your turn — repeat ${seq.length} steps`);
      armStepTimer();
    }, seq.length * sp + 400));
  }
  function nextRound() {
    seq.push(Math.floor(Math.random() * 4));
    playback();
  }
  const expected = () => (reversed ? seq[seq.length - 1 - pos] : seq[pos]);
  function tap(i) {
    if (!accepting) return;
    flash(i, 180);
    if (i !== expected()) {
      accepting = false;
      clearTimeout(stepTimer);
      const right = expected();
      els[right].classList.add('lit');
      status(`Step ${pos + 1} was the ${padName[right]} pad — round ${seq.length} got you`);
      timers.push(setTimeout(() => {
        els[right].classList.remove('lit');
        finish(false, seq.length - 1);
      }, 1000));
      return;
    }
    pos++;
    if (pos === seq.length) {
      accepting = false;
      clearTimeout(stepTimer);
      if (seq.length >= target) return finish(true, seq.length);
      status(`Round ${seq.length} clear ✓`);
      timers.push(setTimeout(nextRound, 750));
    } else {
      armStepTimer();
    }
  }
  nextRound();
  return () => { timers.forEach(clearTimeout); clearTimeout(stepTimer); };
};

// ---- 10. Reaction Rush ----
GAME_IMPL.reaction = (mount, diff, finish, status) => {
  const N = diff === 'hard' ? 4 : 3;
  const goal = diff === 'hard' ? 22 : 12;
  const baseWindow = diff === 'hard' ? 1050 : 1600;
  const minWindow = diff === 'hard' ? 650 : 1000;
  const decoyP = diff === 'hard' ? 0.45 : 0.2;
  const grid = makeGrid(mount, N, 'reaction');
  const cells = [];
  for (let i = 0; i < N * N; i++) {
    const el = document.createElement('button');
    el.className = 'cell rx-cell';
    el.addEventListener('click', () => tap(i));
    grid.appendChild(el);
    cells.push(el);
  }
  let lit = -1, decoy = -1, hits = 0, streak = 0, left = 30, over = false, moveTimer = null;
  const windowNow = () => Math.max(minWindow, baseWindow - hits * 25);
  function clearMarks() {
    if (lit >= 0) cells[lit].classList.remove('lit');
    if (decoy >= 0) cells[decoy].classList.remove('decoy');
    decoy = -1;
  }
  function light() {
    clearTimeout(moveTimer);
    const prev = lit;
    clearMarks();
    do { lit = Math.floor(Math.random() * N * N); } while (lit === prev);
    cells[lit].classList.add('lit');
    if (Math.random() < decoyP) {
      do { decoy = Math.floor(Math.random() * N * N); } while (decoy === lit);
      cells[decoy].classList.add('decoy');
    }
    // Unclaimed diamonds relocate — the window shrinks as you score.
    moveTimer = setTimeout(() => {
      if (over) return;
      streak = 0;
      light();
      update('it moved!');
    }, windowNow());
  }
  function update(note) {
    status(`◆ ${hits}/${goal} · ${left}s${streak >= 5 ? ` · 🔥 x${streak}` : ''}${note ? ' · ' + note : ''}`);
  }
  function end(won) {
    if (over) return;
    over = true;
    clearInterval(clock);
    clearTimeout(moveTimer);
    clearMarks();
    if (lit >= 0) cells[lit].classList.remove('lit');
    finish(won, hits);
  }
  function tap(i) {
    if (over) return;
    if (i === lit) {
      hits++;
      streak++;
      update();
      if (hits >= goal) return end(true);
      light();
    } else {
      const wasDecoy = i === decoy;
      hits = Math.max(0, hits - 1);
      streak = 0;
      cells[i].classList.add('bad');
      setTimeout(() => cells[i].classList.remove('bad'), 300);
      update(wasDecoy ? '✕ decoy −1' : 'miss −1');
    }
  }
  light();
  update();
  const clock = setInterval(() => {
    left--;
    update();
    if (left <= 0) end(hits >= goal);
  }, 1000);
  return () => { over = true; clearInterval(clock); clearTimeout(moveTimer); };
};

// ---- 11. Delta Ludo (vs 3 AI, simplified classic race-to-home) ----
// ---- 11. Delta Ludo — classic cross-shaped board, vs 3 human-like AI ----
GAME_IMPL.ludo = (mount, diff, finish, status) => {
  // Verified 56-cell shared ring (every consecutive pair is grid-adjacent —
  // no diagonal "jumps"), tracing the classic plus-shaped board clockwise.
  const RING = [
    [6,1],[6,2],[6,3],[6,4],[6,5],[6,6],
    [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],
    [0,7],
    [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,8],
    [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
    [7,14],
    [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[8,8],
    [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],
    [14,7],
    [14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,6],
    [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],
    [7,0],
  ];
  const HOME_COLS = [
    [[7,1],[7,2],[7,3],[7,4],[7,5],[7,6]],       // green
    [[1,7],[2,7],[3,7],[4,7],[5,7],[6,7]],       // yellow
    [[7,13],[7,12],[7,11],[7,10],[7,9],[7,8]],   // blue
    [[13,7],[12,7],[11,7],[10,7],[9,7],[8,7]],   // red
  ];
  const YARD_QUAD = [[0,0],[0,9],[9,9],[9,0]]; // green, yellow, blue, red top-left corner of each 6x6 yard
  const START = [0, 14, 28, 42];
  const SAFE = new Set([0, 14, 28, 42, 6, 12, 19, 26, 33, 40, 47, 54]);
  const CENTER = [7, 7];
  const players = 4;
  const target = diff === 'hard' ? 4 : 3; // tokens that must reach home to win
  const colors = ['#16a34a', '#f59e0b', '#1f66f2', '#dc2626'];
  const names = ['You', 'Sunny', 'Aqua', 'Ruby'];
  // token position: -1 = base, 1..55 = ring step, 56..61 = home column cell, 62 = finished
  const tokens = Array.from({ length: players }, () => [-1, -1, -1, -1]);
  let turn = 0, rolling = false, over = false;

  const cellOf = (p, pos) => {
    if (pos <= 0) return null;
    if (pos <= 55) return RING[(START[p] + pos - 1) % 56];
    if (pos <= 61) return HOME_COLS[p][pos - 56];
    return CENTER;
  };

  // ---------- board ----------
  const wrap = document.createElement('div');
  wrap.className = 'ludo-wrap2';
  mount.appendChild(wrap);
  const boardWrap = document.createElement('div');
  boardWrap.className = 'ludo-board';
  wrap.appendChild(boardWrap);
  const cellEls = {}; // "r,c" -> el
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const el = document.createElement('div');
      el.className = 'lb-cell';
      el.style.gridRow = r + 1;
      el.style.gridColumn = c + 1;
      boardWrap.appendChild(el);
      cellEls[`${r},${c}`] = el;
    }
  }
  const yardColorClass = ['yard-g', 'yard-y', 'yard-b', 'yard-r'];
  YARD_QUAD.forEach(([r0, c0], p) => {
    for (let r = r0; r < r0 + 6; r++) for (let c = c0; c < c0 + 6; c++) cellEls[`${r},${c}`].classList.add(yardColorClass[p]);
  });
  RING.forEach(([r, c], i) => {
    const el = cellEls[`${r},${c}`];
    el.classList.add('lb-path');
    if (START.includes(i)) el.classList.add('lb-start', yardColorClass[START.indexOf(i)]);
    else if (SAFE.has(i)) el.classList.add('lb-safe');
  });
  HOME_COLS.forEach((cells, p) => cells.forEach(([r, c]) => cellEls[`${r},${c}`].classList.add('lb-home', yardColorClass[p])));
  cellEls['7,7'].classList.add('lb-center');
  // yard token-slot dots (visual only, decorative)
  YARD_QUAD.forEach(([r0, c0], p) => {
    const box = document.createElement('div');
    box.className = 'ludo-yardbox ' + yardColorClass[p];
    box.style.gridRow = `${r0 + 2} / ${r0 + 4}`;
    box.style.gridColumn = `${c0 + 2} / ${c0 + 4}`;
    boardWrap.appendChild(box);
  });

  // ---------- player bar + dice ----------
  const bar = document.createElement('div');
  bar.className = 'ludo-bar';
  wrap.appendChild(bar);
  const avatars = names.map((n, i) => {
    const a = document.createElement('div');
    a.className = 'ludo-avatar';
    a.style.setProperty('--c', colors[i]);
    a.innerHTML = `<span class="dot"></span>${n}<b class="cnt"></b>`;
    bar.appendChild(a);
    return a;
  });
  const dice_el = document.createElement('button');
  dice_el.className = 'ludo-dice2';
  dice_el.textContent = '⚄';
  wrap.appendChild(dice_el);
  const rollBtn = document.createElement('button');
  rollBtn.className = 'btn primary';
  rollBtn.textContent = 'Roll';
  wrap.appendChild(rollBtn);

  function render() {
    boardWrap.querySelectorAll('.ludo-token').forEach((t) => t.remove());
    tokens.forEach((toks, p) => {
      toks.forEach((pos, i) => {
        if (pos > 61) return;
        let r, c;
        if (pos === -1) {
          const [r0, c0] = YARD_QUAD[p];
          r = r0 + 2 + Math.floor(i / 2);
          c = c0 + 2 + (i % 2);
        } else {
          [r, c] = cellOf(p, pos);
        }
        const t = document.createElement('div');
        t.className = 'ludo-token';
        t.style.setProperty('--c', colors[p]);
        t.style.gridRow = r + 1;
        t.style.gridColumn = c + 1;
        if (p === 0 && awaiting && awaiting.opts.includes(i)) {
          t.classList.add('pick');
          t.addEventListener('click', () => tokenClicked(i));
        }
        boardWrap.appendChild(t);
      });
    });
    const homeCount = tokens.map((t) => t.filter((p) => p === 62).length);
    avatars.forEach((a, i) => {
      a.classList.toggle('active', i === turn && !over);
      a.querySelector('.cnt').textContent = `${homeCount[i]}/${players}`;
    });
  }
  function movable(p, roll) {
    return tokens[p]
      .map((_, i) => i)
      .filter((i) => {
        const pos = tokens[p][i];
        if (pos === -1) return roll === 6;
        if (pos === 62) return false;
        return pos + roll <= 62;
      });
  }
  /** Would this move land on and capture an opponent token (non-safe cell)? Pure — no mutation. */
  function wouldCapture(p, i, roll) {
    const pos = tokens[p][i];
    const next = pos === -1 ? 1 : pos + roll;
    if (next < 1 || next > 55) return false;
    const ringIdx = (START[p] + next - 1) % 56;
    if (SAFE.has(ringIdx)) return false;
    return tokens.some((toks, op) => op !== p && toks.some((opos) => opos >= 1 && opos <= 55 && (START[op] + opos - 1) % 56 === ringIdx));
  }
  const ringIdxOf = (p, pos) => (pos >= 1 && pos <= 55 ? (START[p] + pos - 1) % 56 : -1);
  /** Is a token of player p at ring position pos capturable within one enemy roll? */
  function threatened(p, pos) {
    const ri = ringIdxOf(p, pos);
    if (ri < 0 || SAFE.has(ri)) return false;
    for (let op = 0; op < players; op++) {
      if (op === p) continue;
      for (const opos of tokens[op]) {
        const ori = ringIdxOf(op, opos);
        if (ori < 0) continue;
        const dist = (ri - ori + 56) % 56;
        if (dist >= 1 && dist <= 6) return true;
      }
    }
    return false;
  }
  function moveToken(p, i, roll) {
    const pos = tokens[p][i];
    const next = pos === -1 ? 1 : pos + roll;
    tokens[p][i] = next;
    let captured = null;
    if (next >= 1 && next <= 55) {
      const ringIdx = (START[p] + next - 1) % 56;
      if (!SAFE.has(ringIdx)) {
        for (let op = 0; op < players; op++) {
          if (op === p) continue;
          tokens[op].forEach((opos, oi) => {
            if (opos >= 1 && opos <= 55 && (START[op] + opos - 1) % 56 === ringIdx) {
              tokens[op][oi] = -1;
              captured = names[op];
            }
          });
        }
      }
    }
    return captured;
  }
  function endCheck(p) {
    if (tokens[p].filter((pos) => pos === 62).length >= target) {
      over = true;
      render();
      status(`${names[p]} got ${target} tokens home first!`);
      finish(p === 0, tokens[0].filter((pos) => pos === 62).length);
      return true;
    }
    return false;
  }
  function rollDice() {
    return new Promise((resolve) => {
      dice_el.classList.add('rolling');
      let n = 0;
      const spin = setInterval(() => { dice_el.textContent = '⚀⚁⚂⚃⚄⚅'[Math.floor(Math.random() * 6)]; }, 70);
      setTimeout(() => {
        clearInterval(spin);
        dice_el.classList.remove('rolling');
        n = 1 + Math.floor(Math.random() * 6);
        dice_el.textContent = '⚀⚁⚂⚃⚄⚅'[n - 1];
        resolve(n);
      }, 500);
    });
  }
  async function aiTurn() {
    if (over) return;
    rollBtn.disabled = true;
    status(`${names[turn]} is rolling…`);
    const roll = await rollDice();
    const opts = movable(turn, roll);
    if (opts.length) {
      status(`${names[turn]} rolled ${roll} — thinking…`);
      await new Promise((r) => setTimeout(r, 450 + Math.random() * 750));
      // The AI players know the rules: capture first, then finish a token,
      // then rescue one that is about to be eaten, then a safe square, then
      // (hard) an advance that does not walk into danger. Easy still plays a
      // casual move 30% of the time, like a relaxed human.
      const destOf = (i) => (tokens[turn][i] === -1 ? 1 : tokens[turn][i] + roll);
      const capture = opts.find((i) => wouldCapture(turn, i, roll));
      const finisher = opts.find((i) => destOf(i) === 62);
      const escape = opts.find((i) => threatened(turn, tokens[turn][i]) && !threatened(turn, destOf(i)));
      const safeLanding = opts.find((i) => {
        const next = destOf(i);
        return next >= 1 && next <= 55 && SAFE.has((START[turn] + next - 1) % 56);
      });
      const noDanger = diff === 'hard' ? opts.filter((i) => !threatened(turn, destOf(i))) : [];
      const advanceFrom = (list) => list.reduce((best, i) => (tokens[turn][i] > tokens[turn][best] ? i : best), list[0]);
      const smart = capture ?? finisher ?? escape ?? safeLanding ?? (noDanger.length ? advanceFrom(noDanger) : advanceFrom(opts));
      const pick = diff === 'hard' || Math.random() < 0.4
        ? smart
        : opts[Math.floor(Math.random() * opts.length)];
      const captured = moveToken(turn, pick, roll);
      render();
      status(captured ? `${names[turn]} captured ${captured}'s token!` : `${names[turn]} rolled ${roll} and moved.`);
      if (endCheck(turn)) return;
    } else {
      status(`${names[turn]} rolled ${roll} — no valid move.`);
    }
    await new Promise((r) => setTimeout(r, 600));
    if (roll !== 6) turn = (turn + 1) % players;
    if (turn === 0) updateHuman(); else aiTurn();
  }
  function updateHuman() {
    render();
    rollBtn.disabled = false;
    status('Your turn — roll the dice');
  }
  let awaiting = null; // {roll, opts} while waiting for the player to tap a token
  function tokenClicked(i) {
    if (over || !awaiting || !awaiting.opts.includes(i)) return;
    const { roll } = awaiting;
    awaiting = null;
    doHumanMove(i, roll);
  }
  async function doHumanMove(i, roll) {
    const captured = moveToken(0, i, roll);
    render();
    status(captured ? `You captured ${captured}'s token! 🎯` : `You rolled ${roll} and moved.`);
    if (endCheck(0)) return;
    await new Promise((r) => setTimeout(r, 400));
    if (over) return;
    if (roll !== 6) turn = 1;
    if (turn === 0) updateHuman(); else aiTurn();
  }
  rollBtn.addEventListener('click', async () => {
    if (over || turn !== 0 || rolling || awaiting) return;
    rolling = true;
    rollBtn.disabled = true;
    const roll = await rollDice();
    const opts = movable(0, roll);
    rolling = false;
    if (!opts.length) {
      status(`You rolled ${roll} — no valid move.`);
      await new Promise((r) => setTimeout(r, 500));
      if (roll !== 6) turn = 1;
      aiTurn();
      return;
    }
    if (opts.length === 1) return doHumanMove(opts[0], roll);
    awaiting = { roll, opts };
    render();
    status(`You rolled ${roll} — tap a glowing token`);
  });
  render();
  updateHuman();
  return () => { over = true; };
};

// ---- 12. Chess (simplified rules, vs AI) ----
GAME_IMPL.chess = (mount, diff, finish, status) => {
  const P = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' };
  const p2 = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
  let board = [
    ['r','n','b','q','k','b','n','r'],
    ['p','p','p','p','p','p','p','p'],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null,null],
    ['P','P','P','P','P','P','P','P'],
    ['R','N','B','Q','K','B','N','R'],
  ];
  let sel = null, over = false, human = 'w', myTurn = true, lastMove = null, aiTimer = null; // uppercase = white = human
  // Castling rights (revoked when the king or a rook leaves home, or a home rook is captured).
  let castling = { wK: true, wQ: true, bK: true, bQ: true };
  const grid = makeGrid(mount, 8, 'chess');
  const cells = [];
  for (let i = 0; i < 64; i++) {
    const el = document.createElement('button');
    el.className = 'cell ch-cell' + ((Math.floor(i / 8) + i) % 2 ? ' dark' : '');
    el.addEventListener('click', () => onCell(Math.floor(i / 8), i % 8));
    grid.appendChild(el);
    cells.push(el);
  }
  const isWhite = (c) => c && c === c.toUpperCase();
  const isBlack = (c) => c && c === c.toLowerCase();
  function pseudoMoves(r, c, b = board) {
    const piece = b[r][c];
    if (!piece) return [];
    const white = isWhite(piece);
    const type = piece.toUpperCase();
    const out = [];
    const push = (nr, nc, captureOnly, noCaptureOnly) => {
      if (nr < 0 || nr > 7 || nc < 0 || nc > 7) return false;
      const t = b[nr][nc];
      if (t && (white ? isWhite(t) : isBlack(t))) return false;
      if (captureOnly && !t) return false;
      if (noCaptureOnly && t) return false;
      out.push([nr, nc]);
      return !t;
    };
    if (type === 'P') {
      const dir = white ? -1 : 1;
      const startRow = white ? 6 : 1;
      push(r + dir, c, false, true);
      if (r === startRow && !b[r + dir][c]) push(r + 2 * dir, c, false, true);
      push(r + dir, c - 1, true, false);
      push(r + dir, c + 1, true, false);
    } else if (type === 'N') {
      [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]].forEach(([dr,dc]) => push(r+dr, c+dc));
    } else if (type === 'K') {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) push(r+dr, c+dc);
    } else {
      const dirs = type === 'R' ? [[1,0],[-1,0],[0,1],[0,-1]]
        : type === 'B' ? [[1,1],[1,-1],[-1,1],[-1,-1]]
        : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      for (const [dr, dc] of dirs) {
        let nr = r + dr, nc = c + dc;
        while (push(nr, nc)) { nr += dr; nc += dc; }
      }
    }
    return out;
  }
  function allMoves(white, b = board) {
    const moves = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const piece = b[r][c];
      if (piece && (white ? isWhite(piece) : isBlack(piece))) {
        pseudoMoves(r, c, b).forEach(([nr, nc]) => moves.push({ from: [r, c], to: [nr, nc] }));
      }
    }
    return moves;
  }
  function apply(b, m) {
    const nb = b.map((row) => row.slice());
    const piece = nb[m.from[0]][m.from[1]];
    nb[m.to[0]][m.to[1]] = piece;
    nb[m.from[0]][m.from[1]] = null;
    // Castling: the king moves two files — bring its rook to the other side.
    if (piece && piece.toUpperCase() === 'K' && Math.abs(m.to[1] - m.from[1]) === 2) {
      const row = m.from[0];
      if (m.to[1] === 6) { nb[row][5] = nb[row][7]; nb[row][7] = null; }      // kingside O-O
      else if (m.to[1] === 2) { nb[row][3] = nb[row][0]; nb[row][0] = null; } // queenside O-O-O
    }
    // auto-queen promotion
    if (nb[m.to[0]][m.to[1]] === 'P' && m.to[0] === 0) nb[m.to[0]][m.to[1]] = 'Q';
    if (nb[m.to[0]][m.to[1]] === 'p' && m.to[0] === 7) nb[m.to[0]][m.to[1]] = 'q';
    return nb;
  }
  const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 100 };
  // Piece-square tables (white's perspective; mirrored by row for black).
  const PST = {
    P: [[0,0,0,0,0,0,0,0],[50,50,50,50,50,50,50,50],[10,10,20,30,30,20,10,10],[5,5,10,25,25,10,5,5],[0,0,0,20,20,0,0,0],[5,-5,-10,0,0,-10,-5,5],[5,10,10,-20,-20,10,10,5],[0,0,0,0,0,0,0,0]],
    N: [[-50,-40,-30,-30,-30,-30,-40,-50],[-40,-20,0,0,0,0,-20,-40],[-30,0,10,15,15,10,0,-30],[-30,5,15,20,20,15,5,-30],[-30,0,15,20,20,15,0,-30],[-30,5,10,15,15,10,5,-30],[-40,-20,0,5,5,0,-20,-40],[-50,-40,-30,-30,-30,-30,-40,-50]],
    B: [[-20,-10,-10,-10,-10,-10,-10,-20],[-10,0,0,0,0,0,0,-10],[-10,0,5,10,10,5,0,-10],[-10,5,5,10,10,5,5,-10],[-10,0,10,10,10,10,0,-10],[-10,10,10,10,10,10,10,-10],[-10,5,0,0,0,0,5,-10],[-20,-10,-10,-10,-10,-10,-10,-20]],
    R: [[0,0,0,0,0,0,0,0],[5,10,10,10,10,10,10,5],[-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],[-5,0,0,0,0,0,0,-5],[0,0,0,5,5,0,0,0]],
    Q: [[-20,-10,-10,-5,-5,-10,-10,-20],[-10,0,0,0,0,0,0,-10],[-10,0,5,5,5,5,0,-10],[-5,0,5,5,5,5,0,-5],[0,0,5,5,5,5,0,-5],[-10,5,5,5,5,5,0,-10],[-10,0,5,0,0,0,0,-10],[-20,-10,-10,-5,-5,-10,-10,-20]],
    K: [[-30,-40,-40,-50,-50,-40,-40,-30],[-30,-40,-40,-50,-50,-40,-40,-30],[-30,-40,-40,-50,-50,-40,-40,-30],[-30,-40,-40,-50,-50,-40,-40,-30],[-20,-30,-30,-40,-40,-30,-30,-20],[-10,-20,-20,-20,-20,-20,-20,-10],[20,20,0,0,0,0,20,20],[20,30,10,0,0,10,30,20]],
  };
  function evalBoard(b) {
    // > 0 favours white; material ×100 plus placement bonus.
    let s = 0;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = b[r][c];
      if (!p) continue;
      const t = p.toUpperCase();
      const w = isWhite(p);
      s += (VAL[t] * 100 + PST[t][w ? r : 7 - r][c]) * (w ? 1 : -1);
    }
    return s;
  }
  const INF = 1e9;
  function orderMoves(b, moves) {
    // Captures first, most valuable victim / least valuable attacker.
    return moves.map((m) => {
      const t = b[m.to[0]][m.to[1]];
      return { m, s: t ? VAL[t.toUpperCase()] * 10 - VAL[b[m.from[0]][m.from[1]].toUpperCase()] : 0 };
    }).sort((a, z) => z.s - a.s).map((x) => x.m);
  }
  function search(b, depth, alpha, beta, whiteToMove) {
    if (depth === 0) return evalBoard(b);
    const moves = orderMoves(b, allMoves(whiteToMove, b));
    if (!moves.length) return evalBoard(b);
    if (whiteToMove) {
      let best = -INF;
      for (const m of moves) {
        if (b[m.to[0]][m.to[1]] === 'k') return INF - depth;
        best = Math.max(best, search(apply(b, m), depth - 1, alpha, beta, false));
        alpha = Math.max(alpha, best);
        if (beta <= alpha) break;
      }
      return best;
    }
    let best = INF;
    for (const m of moves) {
      if (b[m.to[0]][m.to[1]] === 'K') return -INF + depth;
      best = Math.min(best, search(apply(b, m), depth - 1, alpha, beta, true));
      beta = Math.min(beta, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  function kingPos(b, white) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      if (b[r][c] === (white ? 'K' : 'k')) return [r, c];
    }
    return null;
  }
  function inCheck(b, white) {
    const kp = kingPos(b, white);
    if (!kp) return false; // king already gone (shouldn't happen once checkmate is enforced)
    return allMoves(!white, b).some(({ to }) => to[0] === kp[0] && to[1] === kp[1]);
  }
  /** Legal moves = pseudo-legal moves that don't leave your own king in check. */
  function legalMoves(white, b = board) {
    return allMoves(white, b).filter((m) => !inCheck(apply(b, m), white));
  }
  function legalMovesFrom(r, c, b = board) {
    const white = isWhite(b[r][c]);
    const moves = pseudoMoves(r, c, b).filter(([nr, nc]) => !inCheck(apply(b, { from: [r, c], to: [nr, nc] }), white));
    if (b[r][c] && b[r][c].toUpperCase() === 'K') moves.push(...castleMoves(white, b));
    return moves;
  }
  /** True if square (r,c) is attacked by `byWhite`'s pieces (pawns handled correctly on empty squares). */
  function isAttacked(b, r, c, byWhite) {
    const opp = byWhite ? isWhite : isBlack;
    // Pawns attack diagonally forward — an attacker pawn sits one rank toward its own side.
    const pr = byWhite ? r + 1 : r - 1;
    const pawnCh = byWhite ? 'P' : 'p';
    if (b[pr] && (b[pr][c - 1] === pawnCh || b[pr][c + 1] === pawnCh)) return true;
    for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr][nc] && b[nr][nc].toUpperCase() === 'N' && opp(b[nr][nc])) return true;
    }
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && b[nr][nc] && b[nr][nc].toUpperCase() === 'K' && opp(b[nr][nc])) return true;
    }
    const scan = (dirs, types) => {
      for (const [dr, dc] of dirs) {
        let nr = r + dr, nc = c + dc;
        while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
          const p = b[nr][nc];
          if (p) { if (opp(p) && types.includes(p.toUpperCase())) return true; break; }
          nr += dr; nc += dc;
        }
      }
      return false;
    };
    if (scan([[1,0],[-1,0],[0,1],[0,-1]], ['R', 'Q'])) return true;
    if (scan([[1,1],[1,-1],[-1,1],[-1,-1]], ['B', 'Q'])) return true;
    return false;
  }
  /** Legal castling king-destinations for `white` on board `b`, given current rights. */
  function castleMoves(white, b = board) {
    const out = [];
    const row = white ? 7 : 0;
    const king = white ? 'K' : 'k';
    const rook = white ? 'R' : 'r';
    if (b[row][4] !== king) return out;
    if (isAttacked(b, row, 4, !white)) return out; // may not castle out of check
    const kSide = white ? castling.wK : castling.bK;
    const qSide = white ? castling.wQ : castling.bQ;
    if (kSide && b[row][7] === rook && !b[row][5] && !b[row][6]
        && !isAttacked(b, row, 5, !white) && !isAttacked(b, row, 6, !white)) out.push([row, 6]);
    if (qSide && b[row][0] === rook && !b[row][1] && !b[row][2] && !b[row][3]
        && !isAttacked(b, row, 3, !white) && !isAttacked(b, row, 2, !white)) out.push([row, 2]);
    return out;
  }
  /** Revoke castling rights whenever a king/rook leaves home or a home rook is captured. */
  function updateRights(b, m) {
    const p = b[m.from[0]][m.from[1]];
    if (p === 'K') { castling.wK = false; castling.wQ = false; }
    if (p === 'k') { castling.bK = false; castling.bQ = false; }
    for (const [rr, cc, side] of [[7,0,'wQ'],[7,7,'wK'],[0,0,'bQ'],[0,7,'bK']]) {
      if ((m.from[0] === rr && m.from[1] === cc) || (m.to[0] === rr && m.to[1] === cc)) castling[side] = false;
    }
  }
  function render(hints, changed) {
    const hs = hints || [];
    const checkW = inCheck(board, true);
    const checkB = inCheck(board, false);
    board.forEach((row, r) => row.forEach((c, ci) => {
      const el = cells[r * 8 + ci];
      el.textContent = c ? (isWhite(c) ? P[c] : p2[c.toUpperCase()]) : '';
      el.classList.toggle('sel', !!sel && sel[0] === r && sel[1] === ci);
      const isHint = hs.some(([hr, hc]) => hr === r && hc === ci);
      el.classList.toggle('hint', isHint && !c);
      el.classList.toggle('cap', isHint && !!c);
      el.classList.toggle('last', !!lastMove && ((lastMove.from[0] === r && lastMove.from[1] === ci) || (lastMove.to[0] === r && lastMove.to[1] === ci)));
      el.classList.toggle('check', (c === 'K' && checkW) || (c === 'k' && checkB));
      if (changed && changed[0] === r && changed[1] === ci) {
        el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
      }
    }));
  }
  function matText() {
    let d = 0;
    for (const row of board) for (const c of row) if (c && c.toUpperCase() !== 'K') d += VAL[c.toUpperCase()] * (isWhite(c) ? 1 : -1);
    return d === 0 ? 'material even' : d > 0 ? `You +${d}` : `Elena +${-d}`;
  }
  function kingCaptured(b) {
    let wk = false, bk = false;
    for (const row of b) for (const c of row) { if (c === 'K') wk = true; if (c === 'k') bk = true; }
    return !wk ? 'black' : !bk ? 'white' : null;
  }
  /** Real chess ending: checkmate (win/loss) or stalemate (draw, no reward). */
  function gameEndFor(white) {
    if (legalMoves(white).length) return null;
    return inCheck(board, white) ? 'checkmate' : 'stalemate';
  }
  function aiMove() {
    if (over) return;
    const castle = castleMoves(false, board).map((to) => ({ from: kingPos(board, false), to }));
    const moves = legalMoves(false).concat(castle);
    if (!moves.length) {
      over = true;
      const end = gameEndFor(false);
      status(end === 'checkmate' ? 'Checkmate — you win! ♔' : 'Stalemate — a draw.');
      return finish(end === 'checkmate', 1);
    }
    // Mate in 1 is always taken.
    let pick = moves.find((m) => {
      const b1 = apply(board, m);
      return inCheck(b1, true) && !legalMoves(true, b1).length;
    });
    if (!pick) {
      if (diff === 'hard') {
        // Alpha-beta, 4 plies total — always sees the player's recapture.
        let best = INF, beta = INF;
        pick = moves[0];
        for (const m of orderMoves(board, moves)) {
          const s = search(apply(board, m), 3, -INF, beta, true);
          if (s < best) { best = s; pick = m; }
          beta = Math.min(beta, best);
        }
      } else {
        // Easy: 2-ply search like a solid club player, with occasional slips.
        const scored = moves.map((m) => ({ m, s: search(apply(board, m), 1, -INF, INF, true) }))
          .sort((a, z) => a.s - z.s);
        const slip = Math.random() < 0.4 && scored.length > 1
          ? 1 + Math.floor(Math.random() * Math.min(3, scored.length - 1))
          : 0;
        pick = scored[slip].m;
      }
    }
    lastMove = { from: pick.from.slice(), to: pick.to.slice() };
    updateRights(board, pick);
    board = apply(board, pick);
    render(null, pick.to);
    const winner = kingCaptured(board);
    if (winner) { over = true; return finish(winner === 'white', 1); }
    const end = gameEndFor(true);
    if (end) {
      over = true;
      status(end === 'checkmate' ? 'Checkmate — Elena wins.' : 'Stalemate — a draw.');
      return finish(false, 1);
    }
    myTurn = true;
    status(`${inCheck(board, true) ? 'Check! ' : ''}Your move · ${matText()}`);
  }
  function onCell(r, c) {
    if (over || !myTurn) return;
    const piece = board[r][c];
    if (sel) {
      const legal = legalMovesFrom(sel[0], sel[1]).some(([nr, nc]) => nr === r && nc === c);
      if (legal) {
        lastMove = { from: sel.slice(), to: [r, c] };
        updateRights(board, lastMove);
        board = apply(board, lastMove);
        sel = null;
        myTurn = false;
        render(null, [r, c]);
        const winner = kingCaptured(board);
        if (winner) { over = true; return finish(winner === 'white', 1); }
        const end = gameEndFor(false);
        if (end) {
          over = true;
          status(end === 'checkmate' ? 'Checkmate — you win! ♔' : 'Stalemate — a draw.');
          return finish(end === 'checkmate', 1);
        }
        status(inCheck(board, false) ? `Check! ${aiThinkLine('Elena')}` : aiThinkLine('Elena'));
        aiTimer = setTimeout(aiMove, 450 + Math.random() * 700);
        return;
      }
      sel = isWhite(piece) ? [r, c] : null;
      render(sel ? legalMovesFrom(r, c) : null);
      return;
    }
    if (isWhite(piece)) { sel = [r, c]; render(legalMovesFrom(r, c)); }
  }
  status(`You are White vs Elena — tap a piece to see its moves. · ${matText()}`);
  render();
  return () => { over = true; clearTimeout(aiTimer); };
};

// ---- 13. Delta Card Draw (Deltix original suits — hold, draw, best hand, no wagering) ----
GAME_IMPL.threecard = (mount, diff, finish, status) => {
  const rounds = diff === 'hard' ? 7 : 5;
  const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  // Deltix original suits: Delta Δ, Gem ◆, Node ●, Peak ▲ — no third-party card faces.
  const SUITS = ['Δ','◆','●','▲'];
  const RED = new Set(['◆','▲']);
  const TIER_NAME = { 6: 'Trail', 5: 'Straight flush', 4: 'Straight', 3: 'Flush', 2: 'Pair', 1: 'High card' };
  let wins = 0, losses = 0, round = 0, over = false;
  let deck = [], deckPos = 0, you = [], rio = [], swap = [false, false, false], phase = 'idle';
  const table = document.createElement('div');
  table.className = 'card-table';
  mount.appendChild(table);
  const dealBtn = document.createElement('button');
  dealBtn.className = 'btn primary';
  dealBtn.textContent = 'Deal';
  mount.appendChild(dealBtn);

  function newDeck() {
    deck = [];
    for (const r of RANKS) for (const s of SUITS) deck.push({ r, s });
    shuffleArr(deck);
    deckPos = 0;
  }
  const next = () => deck[deckPos++];
  function handScore(hand) {
    const vals = hand.map((c) => RANKS.indexOf(c.r) + 2).sort((a, b) => b - a);
    const counts = {};
    vals.forEach((v) => (counts[v] = (counts[v] || 0) + 1));
    const pairVal = Object.entries(counts).find(([, n]) => n >= 2);
    const trail = Object.entries(counts).find(([, n]) => n === 3);
    const isSeq = vals[0] - vals[1] === 1 && vals[1] - vals[2] === 1;
    const isFlush = hand.every((c) => c.s === hand[0].s);
    let tier = 0;
    if (trail) tier = 6;
    else if (isSeq && isFlush) tier = 5;
    else if (isSeq) tier = 4;
    else if (isFlush) tier = 3;
    else if (pairVal) tier = 2;
    else tier = 1;
    return { tier, high: vals };
  }
  function compare(a, b) {
    if (a.tier !== b.tier) return a.tier - b.tier;
    for (let i = 0; i < 3; i++) if (a.high[i] !== b.high[i]) return a.high[i] - b.high[i];
    return 0;
  }
  function nameOf(hand) {
    const s = handScore(hand);
    if (s.tier === 2 || s.tier === 6) {
      const counts = {};
      hand.forEach((c) => (counts[c.r] = (counts[c.r] || 0) + 1));
      const r = Object.entries(counts).find(([, n]) => n >= 2)[0];
      return `${TIER_NAME[s.tier]} of ${r}s`;
    }
    if (s.tier === 1) return `${RANKS[s.high[0] - 2]}-high`;
    return TIER_NAME[s.tier];
  }
  /** Rio's draw strategy — keeps made hands, chases pairs/flush/straight draws correctly. */
  function rioSwaps(hand) {
    const s = handScore(hand);
    if (s.tier >= 3) return []; // flush or better: stand pat
    const vals = hand.map((c) => RANKS.indexOf(c.r) + 2);
    if (Math.random() < (diff === 'hard' ? 0.15 : 0.62)) {
      // Easy Rio sometimes plays casually: keeps only his highest card.
      const hi = vals.indexOf(Math.max(...vals));
      return [0, 1, 2].filter((i) => i !== hi);
    }
    if (s.tier === 2) {
      const pairVal = vals.find((v) => vals.filter((x) => x === v).length >= 2);
      return [0, 1, 2].filter((i) => vals[i] !== pairVal); // swap the kicker
    }
    // two suited → chase the flush
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      if (hand[i].s === hand[j].s) return [0, 1, 2].filter((k) => k !== i && k !== j);
    }
    // two connected → chase the straight
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if (i !== j && vals[i] - vals[j] === 1) return [0, 1, 2].filter((k) => k !== i && k !== j);
    }
    // keep Q or better, redraw the rest
    const keep = [0, 1, 2].filter((i) => vals[i] >= 12);
    return [0, 1, 2].filter((i) => !keep.includes(i));
  }
  function renderHands(reveal, verdict) {
    const fmt = (hand, hide, swappable) =>
      hand.map((c, i) => hide
        ? '<span class="pcard back">Δ</span>'
        : `<button class="pcard ${RED.has(c.s) ? 'red' : ''}${swappable && swap[i] ? ' swap' : ''}" data-i="${i}" ${swappable ? '' : 'disabled'}>${c.r}<i class="suit">${c.s}</i></button>`).join('');
    const holdPhase = phase === 'hold';
    table.innerHTML = `
      <div class="hand-row${reveal && verdict < 0 ? ' won-row' : ''}"><div class="hand-label">Dealer Rio</div><div class="hand">${fmt(rio, !reveal, false)}</div>${reveal ? `<div class="hand-name">${nameOf(rio)}</div>` : ''}</div>
      <div class="hand-row${reveal && verdict > 0 ? ' won-row' : ''}"><div class="hand-label">You</div><div class="hand">${fmt(you, false, holdPhase)}</div>${reveal ? `<div class="hand-name">${nameOf(you)}</div>` : ''}</div>`;
    if (holdPhase) {
      table.querySelectorAll('.pcard[data-i]').forEach((el) => {
        el.addEventListener('click', () => {
          const i = Number(el.dataset.i);
          swap[i] = !swap[i];
          renderHands(false);
          const n = swap.filter(Boolean).length;
          dealBtn.textContent = n ? `Draw ${n} card${n > 1 ? 's' : ''} ▸` : 'Stand pat ▸';
        });
      });
    }
  }
  function settle() {
    const cmp = compare(handScore(you), handScore(rio));
    if (cmp > 0) wins++;
    else if (cmp < 0) losses++;
    renderHands(true, cmp);
    status(`${cmp > 0 ? 'You win the round! 🎉' : cmp < 0 ? 'Rio takes it.' : 'Push — no one scores.'} · You ${wins} – Rio ${losses}`);
    phase = 'done';
    if (round >= rounds) {
      setTimeout(() => { if (!over) { over = true; finish(wins > losses, wins); } }, 1100);
    } else {
      dealBtn.disabled = false;
      dealBtn.textContent = 'Deal next round';
    }
  }
  dealBtn.addEventListener('click', () => {
    if (over) return;
    if (phase === 'hold') {
      // player draws, then Rio
      you = you.map((c, i) => (swap[i] ? next() : c));
      const rs = rioSwaps(rio);
      rio = rio.map((c, i) => (rs.includes(i) ? next() : c));
      phase = 'reveal';
      renderHands(false);
      dealBtn.disabled = true;
      status(rs.length ? `Rio swaps ${rs.length} card${rs.length > 1 ? 's' : ''}…` : 'Rio stands pat…');
      setTimeout(settle, 950);
      return;
    }
    round++;
    newDeck();
    you = [next(), next(), next()];
    rio = [next(), next(), next()];
    swap = [false, false, false];
    phase = 'hold';
    renderHands(false);
    dealBtn.textContent = 'Stand pat ▸';
    status(`Round ${round}/${rounds} — you hold ${nameOf(you)}. Tap cards to swap them.`);
  });
  status(`Best of ${rounds} vs Dealer Rio — tap cards to swap once per round. Suits Δ ◆ ● ▲, no wagering.`);
  return () => { over = true; };
};

// ---- 14. Carom Strike (2D physics flick-to-pot) ----
GAME_IMPL.carom = (mount, diff, finish, status) => {
  const W = 300, H = 300, R = 8;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  // Balance (simulated vs ghost-ball aim bot): easy ≈ 50%+ win, hard demands real accuracy.
  const pocketR = diff === 'hard' ? 19 : 24;
  const pockets = [[0,0],[W/2,0],[W,0],[0,H],[W/2,H],[W,H]];
  const target = diff === 'hard' ? 4 : 2;
  const maxShots = diff === 'hard' ? 13 : 14;
  let pucks = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    pucks.push({ x: W/2 + Math.cos(ang) * 40, y: H/2 + Math.sin(ang) * 40, vx: 0, vy: 0, out: false });
  }
  const striker = { x: W/2, y: H - 30, vx: 0, vy: 0, out: false };
  let potted = 0, shots = 0, dragging = false, sx = 0, sy = 0, moving = false, over = false;
  let flashes = []; // pocket flash rings {x, y, t}

  function placeStriker() {
    // Return the striker to the baseline in a clear spot.
    striker.out = false;
    striker.vx = 0; striker.vy = 0;
    striker.y = H - 30;
    const clearAt = (x) => pucks.every((p) => p.out || Math.hypot(p.x - x, p.y - striker.y) > R * 2 + 2);
    for (const off of [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100]) {
      if (clearAt(W / 2 + off)) { striker.x = W / 2 + off; return; }
    }
    striker.x = W / 2;
  }
  function draw() {
    ctx.fillStyle = '#0f7a3d'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#0a5c2c'; ctx.lineWidth = 10; ctx.strokeRect(5, 5, W - 10, H - 10);
    // baseline guide
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(30, H - 30); ctx.lineTo(W - 30, H - 30); ctx.stroke();
    pockets.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, pocketR, 0, 7); ctx.fillStyle = '#0a0a0a'; ctx.fill(); });
    flashes = flashes.filter((f) => f.t < 18);
    flashes.forEach((f) => {
      ctx.beginPath(); ctx.arc(f.x, f.y, pocketR + f.t, 0, 7);
      ctx.strokeStyle = `rgba(245, 208, 66, ${1 - f.t / 18})`; ctx.lineWidth = 3; ctx.stroke();
      f.t++;
    });
    pucks.forEach((p) => { if (p.out) return; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 7); ctx.fillStyle = '#f1f5f9'; ctx.fill(); ctx.strokeStyle = '#94a3b8'; ctx.stroke(); });
    if (!striker.out) { ctx.beginPath(); ctx.arc(striker.x, striker.y, R + 1, 0, 7); ctx.fillStyle = '#1f66f2'; ctx.fill(); }
    if (dragging) {
      const dx = striker.x - sx, dy = striker.y - sy;
      const power = Math.min(14, Math.hypot(dx, dy) / 8);
      const ang = Math.atan2(dy, dx);
      // pull-back line
      ctx.beginPath(); ctx.moveTo(striker.x, striker.y); ctx.lineTo(sx, sy);
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.stroke();
      // shot projection (dashed, length ∝ power)
      ctx.beginPath(); ctx.setLineDash([5, 5]);
      ctx.moveTo(striker.x, striker.y);
      ctx.lineTo(striker.x + Math.cos(ang) * power * 12, striker.y + Math.sin(ang) * power * 12);
      ctx.strokeStyle = 'rgba(245, 208, 66, .9)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.setLineDash([]);
      // power bar
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(20, 14, 80, 8);
      ctx.fillStyle = power > 11 ? '#dc2626' : power > 7 ? '#f59e0b' : '#4ade80';
      ctx.fillRect(20, 14, 80 * (power / 14), 8);
    }
  }
  function physicsStep() {
    let anyMoving = false;
    const all = [striker, ...pucks];
    all.forEach((p) => {
      if (p.out) return;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.985; p.vy *= 0.985;
      // pocket check BEFORE wall clamp — otherwise corner pockets are unreachable
      for (const [px, py] of pockets) {
        if (Math.hypot(p.x - px, p.y - py) < pocketR) {
          p.out = true; p.vx = 0; p.vy = 0;
          flashes.push({ x: px, y: py, t: 0 });
          if (p !== striker) potted++;
          return;
        }
      }
      if (p.x < 12) { p.x = 12; p.vx *= -0.8; } if (p.x > W - 12) { p.x = W - 12; p.vx *= -0.8; }
      if (p.y < 12) { p.y = 12; p.vy *= -0.8; } if (p.y > H - 12) { p.y = H - 12; p.vy *= -0.8; }
      if (Math.hypot(p.vx, p.vy) > 0.05) anyMoving = true;
    });
    // impulse collision — exchanges only the velocity component along the contact normal
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.out || b.out) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d < R * 2 && d > 0) {
        const nx = dx / d, ny = dy / d, overlap = R * 2 - d;
        a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2; b.y += ny * overlap / 2;
        const jn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (jn > 0) {
          a.vx -= jn * nx; a.vy -= jn * ny;
          b.vx += jn * nx; b.vy += jn * ny;
        }
      }
    }
    return anyMoving;
  }
  let raf;
  function flashLoop() {
    if (over || !flashes.length) return;
    draw();
    raf = requestAnimationFrame(flashLoop);
  }
  function loop() {
    if (over) return;
    const anyMoving = physicsStep();
    draw();
    if (anyMoving) { moving = true; raf = requestAnimationFrame(loop); return; }
    moving = false;
    if (potted >= target) { over = true; return finish(true, shots); }
    let note = '';
    if (striker.out) {
      shots = Math.min(shots + 1, maxShots); // foul penalty
      note = ' · Foul! Striker potted (+1 shot)';
    }
    placeStriker(); // striker always returns to the baseline
    draw();
    if (flashes.length) raf = requestAnimationFrame(flashLoop);
    if (shots >= maxShots) { over = true; return finish(false, shots); }
    status(`Potted ${potted}/${target} · shot ${shots}/${maxShots}${note}`);
  }
  cv.addEventListener('pointerdown', (e) => {
    if (moving || over) return;
    dragging = true;
    const rect = cv.getBoundingClientRect();
    sx = (e.clientX - rect.left) * (W / rect.width); sy = (e.clientY - rect.top) * (H / rect.height);
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = cv.getBoundingClientRect();
    sx = (e.clientX - rect.left) * (W / rect.width); sy = (e.clientY - rect.top) * (H / rect.height);
    draw();
  });
  cv.addEventListener('pointerup', () => {
    if (!dragging || over) return;
    dragging = false;
    const dx = striker.x - sx, dy = striker.y - sy;
    const power = Math.min(14, Math.hypot(dx, dy) / 8);
    if (power < 0.8) { draw(); return; } // too soft — not a shot
    const ang = Math.atan2(dy, dx);
    striker.vx = Math.cos(ang) * power; striker.vy = Math.sin(ang) * power;
    shots++;
    moving = true;
    loop();
  });
  status(`Drag back from the striker to aim, release to flick · pot ${target} in ${maxShots} shots`);
  draw();
  return () => { over = true; cancelAnimationFrame(raf); };
};

// ---- 15. Delta Slicer (swipe-to-slice Deltix gems, dodge dark orbs) ----
GAME_IMPL.slicer = (mount, diff, finish, status) => {
  const W = 300, H = 380;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  const target = diff === 'hard' ? 22 : 12;
  const baseSpawn = diff === 'hard' ? 520 : 800;
  const minSpawn = diff === 'hard' ? 380 : 540;
  const missLimit = diff === 'hard' ? 6 : 10;
  const bombP = diff === 'hard' ? 0.16 : 0.06;
  // Deltix original gems — drawn in brand colours, no third-party art.
  const GEMS = ['#1f66f2', '#16a34a', '#f59e0b', '#dc2626', '#8b5cf6'];
  let items = [], parts = [], score = 0, misses = 0, over = false, trail = [];
  let spawnTimer, raf, note = '', noteT = 0, recent = [], deadAt = 0;
  function launch(gemOnly) {
    items.push({
      x: 30 + Math.random() * (W - 60), y: H + 20,
      vy: -(6 + Math.random() * 2.5), vx: (Math.random() - 0.5) * 2,
      g: 0.14, bomb: !gemOnly && Math.random() < bombP,
      color: GEMS[Math.floor(Math.random() * GEMS.length)],
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.1,
      sliced: false, r: 16,
    });
  }
  function spawn() {
    if (over || deadAt) return;
    launch(false);
    if (Math.random() < (diff === 'hard' ? 0.3 : 0.22)) launch(true); // paired gem = combo chance
    spawnTimer = setTimeout(spawn, Math.max(minSpawn, baseSpawn - score * 8));
  }
  function drawGem(x, y, r, color, rot) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.85, -r * 0.15);
    ctx.lineTo(0, r);
    ctx.lineTo(-r * 0.85, -r * 0.15);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath(); // facet lines
    ctx.moveTo(-r * 0.85, -r * 0.15); ctx.lineTo(r * 0.85, -r * 0.15);
    ctx.moveTo(0, -r); ctx.lineTo(0, r);
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
  function drawOrb(x, y, r) {
    ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, 7);
    ctx.fillStyle = '#0f172a'; ctx.fill();
    ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); // warning cross
    ctx.moveTo(x - r * 0.35, y - r * 0.35); ctx.lineTo(x + r * 0.35, y + r * 0.35);
    ctx.moveTo(x + r * 0.35, y - r * 0.35); ctx.lineTo(x - r * 0.35, y + r * 0.35);
    ctx.strokeStyle = '#f87171'; ctx.lineWidth = 2.5; ctx.stroke();
  }
  function gemBurst(it) {
    for (const top of [true, false]) {
      parts.push({ kind: 'half', top, x: it.x, y: it.y, vx: it.vx + (top ? -2 : 2), vy: it.vy - 1,
        rot: it.rot, vr: top ? -0.25 : 0.25, color: it.color, r: it.r, life: 40 });
    }
    for (let i = 0; i < 6; i++) {
      parts.push({ kind: 'spark', x: it.x, y: it.y, vx: (Math.random() - 0.5) * 6,
        vy: (Math.random() - 0.5) * 6 - 1, color: it.color, life: 22 });
    }
  }
  function boom(it) {
    for (let i = 0; i < 14; i++) {
      parts.push({ kind: 'spark', x: it.x, y: it.y, vx: (Math.random() - 0.5) * 9,
        vy: (Math.random() - 0.5) * 9, color: i % 2 ? '#f87171' : '#fbbf24', life: 30 });
    }
    parts.push({ kind: 'ring', x: it.x, y: it.y, r: 10, life: 20 });
  }
  function draw() {
    ctx.fillStyle = '#eef3ff'; ctx.fillRect(0, 0, W, H);
    parts.forEach((p) => {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 24));
      if (p.kind === 'half') {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.beginPath();
        if (p.top) { ctx.moveTo(0, -p.r); ctx.lineTo(p.r * 0.85, -p.r * 0.15); ctx.lineTo(-p.r * 0.85, -p.r * 0.15); }
        else { ctx.moveTo(p.r * 0.85, -p.r * 0.15); ctx.lineTo(0, p.r); ctx.lineTo(-p.r * 0.85, -p.r * 0.15); }
        ctx.closePath(); ctx.fillStyle = p.color; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.restore();
      } else if (p.kind === 'ring') {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7);
        ctx.strokeStyle = '#f87171'; ctx.lineWidth = 3; ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
      }
    });
    ctx.globalAlpha = 1;
    items.forEach((it) => {
      if (it.sliced) return;
      if (it.bomb) drawOrb(it.x, it.y, it.r);
      else drawGem(it.x, it.y, it.r, it.color, it.rot);
    });
    if (trail.length > 1) {
      ctx.strokeStyle = 'rgba(31,102,242,.6)'; ctx.lineWidth = 4; ctx.beginPath();
      ctx.moveTo(trail[0].x, trail[0].y);
      trail.forEach((p) => ctx.lineTo(p.x, p.y));
      ctx.stroke();
    }
  }
  function loop() {
    if (over) return;
    items.forEach((it) => { it.vy += it.g; it.x += it.vx; it.y += it.vy; it.rot += it.vr; });
    parts.forEach((p) => {
      if (p.kind === 'ring') { p.r += 2.2; }
      else { p.vy += 0.18; p.x += p.vx; p.y += p.vy; if (p.kind === 'half') p.rot += p.vr; }
      p.life--;
    });
    parts = parts.filter((p) => p.life > 0);
    items = items.filter((it) => {
      if (it.sliced) return false;
      if (it.y > H + 40 && it.vy > 0) {
        if (!it.bomb && !deadAt) { misses++; note = 'missed a gem'; noteT = 50; }
        return false;
      }
      return true;
    });
    draw();
    if (deadAt) {
      if (performance.now() > deadAt) { over = true; return finish(false, score); }
      status('💥 Dark orb!');
      raf = requestAnimationFrame(loop);
      return;
    }
    if (noteT > 0) noteT--;
    status(`${score}/${target} gems · ${misses}/${missLimit} missed${noteT > 0 ? ' · ' + note : ''}`);
    if (score >= target) { over = true; clearTimeout(spawnTimer); return finish(true, score); }
    if (misses >= missLimit) { over = true; clearTimeout(spawnTimer); return finish(false, score); }
    raf = requestAnimationFrame(loop);
  }
  function pointAt(e) {
    const rect = cv.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (W / rect.width), y: (e.clientY - rect.top) * (H / rect.height) };
  }
  function trySlice(pt) {
    if (over || deadAt) return;
    items.forEach((it) => {
      if (it.sliced || deadAt) return;
      if (Math.hypot(it.x - pt.x, it.y - pt.y) < it.r + 10) {
        it.sliced = true;
        if (it.bomb) {
          boom(it);
          if (diff === 'hard') { clearTimeout(spawnTimer); deadAt = performance.now() + 650; }
          else { misses += 2; note = '💥 orb hit — 2 misses'; noteT = 90; }
          return;
        }
        gemBurst(it);
        score++;
        const now = performance.now();
        recent = recent.filter((t) => now - t < 400);
        recent.push(now);
        if (recent.length === 3) { score++; note = '⚡ combo +1'; noteT = 90; }
      }
    });
  }
  cv.addEventListener('pointerdown', (e) => { trail = [pointAt(e)]; }); // must swipe — taps don't slice
  cv.addEventListener('pointermove', (e) => {
    if (!e.buttons) return;
    const pt = pointAt(e);
    trail.push(pt);
    if (trail.length > 8) trail.shift();
    trySlice(pt);
  });
  cv.addEventListener('pointerup', () => (trail = []));
  status(`Swipe to slice ${target} gems · avoid the dark orbs`);
  spawn();
  loop();
  return () => { over = true; clearTimeout(spawnTimer); cancelAnimationFrame(raf); };
};

// ---- 16. Penalty Kicks (two-way shootout vs Dario: aim your shots, then guard your net) ----
GAME_IMPL.soccer = (mount, diff, finish, status) => {
  const rounds = 5;
  const W = 300, H = 250;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  const GL = 45, GR = 255, GT = 26, GB = 86; // goal mouth
  const zones = [GL + (GR - GL) / 6, (GL + GR) / 2, GR - (GR - GL) / 6];
  const zoneOf = (x) => (x < GL + (GR - GL) / 3 ? 0 : x > GR - (GR - GL) / 3 ? 2 : 1);
  // Dario the keeper studies your habits; as striker he disguises his run-up.
  const guessP = diff === 'hard' ? 0.5 : 0.25;
  const reach = diff === 'hard' ? 36 : 26;
  const aimNoise = diff === 'hard' ? 10 : 4;
  const cueHonest = diff === 'hard' ? 0.65 : 0.92;
  const saveP = diff === 'hard' ? 0.75 : 0.9;
  const darioWideP = diff === 'hard' ? 0.08 : 0.22;
  let round = 1, myGoals = 0, dGoals = 0, over = false;
  let phase = 'shoot'; // shoot | shootAnim | defend | defendAnim | between
  const history = [0, 0, 0];
  const results = []; // {me:'⚽|✕', dario:'⚽|✕'} per round
  let scene = { ball: null, keeper: { x: W / 2, tilt: 0 }, dario: null, cue: null, text: null, textCol: '#16a34a' };
  let raf, timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const noise = () => (Math.random() + Math.random() - 1) * aimNoise * 1.6;

  function drawKeeper(x, tilt, col) {
    ctx.save();
    ctx.translate(x, GB - 6);
    ctx.rotate(tilt);
    ctx.fillStyle = col;
    ctx.fillRect(-8, -34, 16, 30); // torso
    ctx.beginPath(); ctx.arc(0, -42, 7, 0, 7); ctx.fill(); // head
    ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-8, -30); ctx.lineTo(-18 - Math.abs(tilt) * 26, -38 - Math.abs(tilt) * 20); // arms out when diving
    ctx.moveTo(8, -30); ctx.lineTo(18 + Math.abs(tilt) * 26, -38 - Math.abs(tilt) * 20);
    ctx.stroke();
    ctx.restore();
  }
  function draw() {
    ctx.fillStyle = '#166534'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#15803d';
    for (let i = 0; i < 5; i++) ctx.fillRect(0, H - 30 - i * 44, W, 22); // mow stripes
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 4;
    ctx.strokeRect(GL, GT, GR - GL, GB - GT);
    ctx.strokeStyle = 'rgba(248,250,252,.35)'; ctx.lineWidth = 1; // net
    for (let x = GL + 14; x < GR; x += 14) { ctx.beginPath(); ctx.moveTo(x, GT); ctx.lineTo(x, GB); ctx.stroke(); }
    for (let y = GT + 12; y < GB; y += 12) { ctx.beginPath(); ctx.moveTo(GL, y); ctx.lineTo(GR, y); ctx.stroke(); }
    // shot pips (single row — you take every kick)
    for (let i = 0; i < rounds; i++) {
      const r = results[i];
      ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = r ? (r.me === '⚽' ? '#bbf7d0' : '#fecaca') : '#4b5563';
      ctx.fillText(r ? r.me : '·', 14 + i * 16, H - 6);
    }
    ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = '#f8fafc';
    ctx.fillText(`Goals ${myGoals}/${target}`, W - 8, 14);
    if (scene.keeper) drawKeeper(scene.keeper.x, scene.keeper.tilt, phase.startsWith('defend') ? '#1f66f2' : '#dc2626');
    if (scene.dario) { // striker figure at run-up
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(scene.dario.x - 7, scene.dario.y - 26, 14, 24);
      ctx.beginPath(); ctx.arc(scene.dario.x, scene.dario.y - 33, 6, 0, 7); ctx.fill();
    }
    if (scene.cue) { // run-up lean arrow
      ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#fbbf24';
      ctx.fillText(scene.cue === 0 ? '↖' : scene.cue === 2 ? '↗' : '↑', scene.dario ? scene.dario.x : W / 2, (scene.dario ? scene.dario.y : H - 40) - 46);
    }
    if (scene.ball) {
      ctx.beginPath(); ctx.arc(scene.ball.x, scene.ball.y, 8, 0, 7);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(scene.ball.x - 8, scene.ball.y); ctx.quadraticCurveTo(scene.ball.x, scene.ball.y - 4, scene.ball.x + 8, scene.ball.y);
      ctx.stroke();
    }
    if (scene.text) {
      ctx.font = 'bold 26px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = scene.textCol; ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 4;
      ctx.strokeText(scene.text, W / 2, H / 2 + 24); ctx.fillText(scene.text, W / 2, H / 2 + 24);
    }
  }
  function loop() { if (over) return; draw(); raf = requestAnimationFrame(loop); }

  const target = diff === 'hard' ? 4 : 3; // goals needed to win the shootout
  function roundLabel() { return `shot ${round}/${rounds}`; }
  function checkEnd() {
    const played = results.length;
    const left = rounds - played;
    if (myGoals >= target) return finishUp(true);
    if (myGoals + left < target) return finishUp(false);
    if (played >= rounds) return finishUp(myGoals >= target);
    round++;
    startShoot();
  }
  function finishUp(won) {
    over = true;
    cancelAnimationFrame(raf);
    scene.text = won ? 'YOU WIN!' : 'DARIO WINS';
    scene.textCol = won ? '#16a34a' : '#dc2626';
    draw();
    later(() => finish(won, myGoals), 900);
  }

  // --- your shot ---
  function startShoot() {
    phase = 'shoot';
    scene = { ball: { x: W / 2, y: H - 32 }, keeper: { x: W / 2, tilt: 0 }, dario: null, cue: null, text: null };
    status(`${roundLabel()} — tap inside the goal (need ${target} of ${rounds})`);
  }
  function takeShot(px, py) {
    phase = 'shootAnim';
    const aimX = Math.max(GL + 4, Math.min(GR - 4, px));
    const aimY = Math.max(GT + 4, Math.min(GB - 6, py));
    history[zoneOf(aimX)]++;
    const landX = aimX + noise(), landY = aimY + noise() * 0.6;
    const wide = landX < GL + 2 || landX > GR - 2 || landY < GT + 2;
    const favourite = history.indexOf(Math.max(...history));
    const guess = Math.random() < guessP ? favourite : Math.floor(Math.random() * 3);
    const keeperX = zones[guess] + (Math.random() - 0.5) * 16;
    const topStrip = landY < GT + 14; // top corners are near-unsavable
    const saved = !wide && Math.abs(landX - keeperX) <= (topStrip ? reach * 0.45 : reach) && Math.random() < (diff === 'hard' ? 0.85 : 0.9);
    const from = { x: W / 2, y: H - 32 };
    const t0 = performance.now(), dur = 420;
    (function fly() {
      if (over) return;
      const t = Math.min(1, (performance.now() - t0) / dur);
      scene.ball = { x: from.x + (landX - from.x) * t, y: from.y + (landY - from.y) * t - Math.sin(t * Math.PI) * 26 };
      scene.keeper = { x: W / 2 + (keeperX - W / 2) * Math.min(1, t * 1.3), tilt: (keeperX < W / 2 ? -1 : 1) * 0.9 * Math.min(1, t * 1.3) * (Math.abs(keeperX - W / 2) > 20 ? 1 : 0.1) };
      if (t < 1) return requestAnimationFrame(fly);
      const goal = !wide && !saved;
      scene.text = wide ? 'WIDE!' : saved ? 'SAVED!' : 'GOAL!';
      scene.textCol = goal ? '#16a34a' : '#f87171';
      if (goal) myGoals++;
      results[round - 1] = { me: goal ? '⚽' : '✕', dario: '·' };
      status(`${scene.text} — ${myGoals}/${target} goals`);
      later(checkEnd, 950);
    })();
  }

  // --- Dario's shot: read his lean, tap a side to dive ---
  let diveChoice = null, kicked = false;
  function startDefend() {
    phase = 'defend';
    diveChoice = null; kicked = false;
    const shotZone = Math.random() < 0.45 ? 0 : Math.random() < 0.82 ? 2 : 1; // corners favoured
    const honest = Math.random() < cueHonest;
    const cue = honest ? shotZone : [0, 1, 2].filter((z) => z !== shotZone)[Math.floor(Math.random() * 2)];
    scene = { ball: { x: W / 2, y: H - 46 }, keeper: { x: W / 2, tilt: 0 }, dario: { x: W / 2 + 46, y: H - 24 }, cue: null, text: null };
    status(`${roundLabel()} — Dario steps up… watch his lean, tap LEFT / MIDDLE / RIGHT to dive`);
    const t0 = performance.now(), runup = 1250;
    (function run() {
      if (over) return;
      const t = Math.min(1, (performance.now() - t0) / runup);
      scene.dario = { x: W / 2 + 46 * (1 - t), y: H - 24 };
      if (t > 0.25) scene.cue = cue;
      if (t < 1) return requestAnimationFrame(run);
      resolveDefend(shotZone);
    })();
  }
  function resolveDefend(shotZone) {
    phase = 'defendAnim';
    kicked = true;
    scene.cue = null;
    const dive = diveChoice; // null = stayed home (counts as middle)
    const diveZone = dive === null ? 1 : dive;
    const keeperX = zones[diveZone] + (Math.random() - 0.5) * 10;
    const wide = Math.random() < darioWideP;
    const landX = wide ? (shotZone === 0 ? GL - 16 : shotZone === 2 ? GR + 16 : W / 2) : zones[shotZone] + (Math.random() - 0.5) * 24;
    const landY = GT + 12 + Math.random() * (GB - GT - 22);
    const saved = !wide && diveZone === shotZone && Math.random() < (dive === null && shotZone === 1 ? 0.9 : saveP);
    const from = { x: W / 2, y: H - 46 };
    const t0 = performance.now(), dur = 380;
    (function fly() {
      if (over) return;
      const t = Math.min(1, (performance.now() - t0) / dur);
      scene.ball = { x: from.x + (landX - from.x) * t, y: from.y + (landY - from.y) * t - Math.sin(t * Math.PI) * 20 };
      scene.keeper = { x: W / 2 + (keeperX - W / 2) * Math.min(1, t * 1.4), tilt: (diveZone === 0 ? -1 : diveZone === 2 ? 1 : 0) * 0.9 * Math.min(1, t * 1.4) };
      if (t < 1) return requestAnimationFrame(fly);
      const goal = !wide && !saved;
      scene.text = wide ? 'WIDE!' : saved ? 'SAVED!' : 'GOAL…';
      scene.textCol = goal ? '#f87171' : '#4ade80';
      if (goal) dGoals++;
      if (results[round - 1]) results[round - 1].dario = goal ? '⚽' : '✕';
      status(`${scene.text} You ${myGoals} — ${dGoals} Dario`);
      later(checkEnd, 950);
    })();
  }

  cv.addEventListener('pointerdown', (e) => {
    if (over) return;
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    const y = (e.clientY - rect.top) * (H / rect.height);
    if (phase === 'shoot') {
      if (x > GL - 14 && x < GR + 14 && y > GT - 14 && y < GB + 20) takeShot(x, y);
      else status(`${roundLabel()} — tap inside the goal mouth to shoot`);
    } else if (phase === 'defend' && !kicked) {
      diveChoice = x < W / 3 ? 0 : x > (2 * W) / 3 ? 2 : 1;
      status(`Diving ${['LEFT', 'MIDDLE', 'RIGHT'][diveChoice]}…`);
    }
  });
  status(`Score ${target} of ${rounds} penalties to win — you take every kick`);
  startShoot();
  loop();
  return () => { over = true; cancelAnimationFrame(raf); timers.forEach(clearTimeout); };
};

// ---- 17. Delta Racer (lane-dodge endless runner) ----
GAME_IMPL.racing = (mount, diff, finish, status) => {
  const W = 260, H = 380, LANES = 3;
  const laneW = W / LANES;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  const target = diff === 'hard' ? 40 : 25; // seconds to survive
  const baseSpeed = diff === 'hard' ? 5.2 : 3.5;
  const maxSpeed = diff === 'hard' ? 7.8 : 5.2;
  let lane = 1, carX = 1 * laneW + laneW / 2, obstacles = [], t = 0, over = false, crashed = 0, dashOffset = 0;
  let safeLane = 1; // hidden always-clear corridor — guarantees a passable path
  const shiftP = diff === 'hard' ? 0.4 : 0.22;
  const cleanupInput = directionInput(mount, (d) => {
    if (over) return;
    if (d === 'left') lane = Math.max(0, lane - 1);
    if (d === 'right') lane = Math.min(LANES - 1, lane + 1);
  });
  const speed = () => Math.min(maxSpeed, baseSpeed + t * 0.055);
  const TRAFFIC = [
    { len: 30, col: '#dc2626' }, { len: 30, col: '#f59e0b' },
    { len: 30, col: '#8b5cf6' }, { len: 44, col: '#64748b' }, // grey = truck
  ];
  function spawnObstacle() {
    if (t > 4 && Math.random() < shiftP) {
      const ns = Math.max(0, Math.min(LANES - 1, safeLane + (Math.random() < 0.5 ? -1 : 1)));
      // corridor may only move into a lane that is genuinely open, else the path can pinch shut
      if (!obstacles.some((o) => o.lane === ns && o.y < 210)) safeLane = ns;
    }
    const options = [0, 1, 2].filter((l) => l !== safeLane && !obstacles.some((o) => o.lane === l && o.y < 110));
    if (!options.length) return;
    const l = options[Math.floor(Math.random() * options.length)];
    const kind = TRAFFIC[Math.floor(Math.random() * TRAFFIC.length)];
    obstacles.push({ lane: l, y: -50, len: kind.len, col: kind.col, dv: 0.72 + Math.random() * 0.28 });
  }
  function drawCar(x, y, len, col, tilt, mine) {
    ctx.save();
    ctx.translate(x, y + len / 2);
    ctx.rotate(tilt);
    ctx.fillStyle = '#0f172a'; // wheels
    ctx.fillRect(-15, -len / 2 + 3, 5, 9); ctx.fillRect(10, -len / 2 + 3, 5, 9);
    ctx.fillRect(-15, len / 2 - 12, 5, 9); ctx.fillRect(10, len / 2 - 12, 5, 9);
    ctx.fillStyle = col;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-12, -len / 2, 24, len, 7); else ctx.rect(-12, -len / 2, 24, len);
    ctx.fill();
    ctx.fillStyle = 'rgba(15,23,42,.55)'; // windows
    ctx.fillRect(-8, -len / 2 + (mine ? 7 : len - 17), 16, 8);
    ctx.fillStyle = mine ? '#93c5fd' : 'rgba(255,255,255,.35)';
    ctx.fillRect(-8, mine ? len / 2 - 10 : -len / 2 + 3, 16, 4); // lights
    ctx.restore();
  }
  let raf, spawnTimer;
  function draw() {
    ctx.fillStyle = '#1e293b'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#334155'; ctx.fillRect(0, 0, 7, H); ctx.fillRect(W - 7, 0, 7, H); // shoulders
    ctx.strokeStyle = '#475569'; ctx.setLineDash([16, 14]); ctx.lineDashOffset = -dashOffset; ctx.lineWidth = 2;
    for (let i = 1; i < LANES; i++) { ctx.beginPath(); ctx.moveTo(i * laneW, 0); ctx.lineTo(i * laneW, H); ctx.stroke(); }
    ctx.setLineDash([]);
    obstacles.forEach((o) => drawCar(o.lane * laneW + laneW / 2, o.y, o.len, o.col, 0, false));
    const targetX = lane * laneW + laneW / 2;
    const tilt = crashed ? (performance.now() % 600) / 600 * 6.28 : (targetX - carX) * 0.012;
    drawCar(carX, H - 62, 34, crashed ? '#f87171' : '#1f66f2', tilt, true);
    if (crashed) {
      ctx.fillStyle = 'rgba(220,38,38,.25)'; ctx.fillRect(0, 0, W, H);
      ctx.font = 'bold 26px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = '#fecaca'; ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 4;
      ctx.strokeText('CRASH!', W / 2, H / 2); ctx.fillText('CRASH!', W / 2, H / 2);
    }
    // progress bar
    ctx.fillStyle = 'rgba(15,23,42,.6)'; ctx.fillRect(10, 8, W - 20, 7);
    ctx.fillStyle = '#4ade80'; ctx.fillRect(10, 8, (W - 20) * Math.min(1, t / target), 7);
  }
  let lastTs = 0;
  function loop(ts) {
    if (over) return;
    if (crashed) {
      draw();
      if (performance.now() > crashed) { over = true; clearTimeout(spawnTimer); return finish(false, Math.floor(t)); }
      raf = requestAnimationFrame(loop);
      return;
    }
    const dt = lastTs ? Math.min(3, (ts - lastTs) / (1000 / 60)) : 1; // frame-rate independent (in 60fps units)
    lastTs = ts;
    t += dt / 60;
    const v = speed();
    dashOffset += v * dt;
    carX += (lane * laneW + laneW / 2 - carX) * Math.min(1, 0.22 * dt);
    obstacles.forEach((o) => (o.y += v * o.dv * dt)); // slower traffic = you overtake it
    obstacles = obstacles.filter((o) => o.y < H + 60);
    const hit = obstacles.some((o) => {
      const ox = o.lane * laneW + laneW / 2;
      return Math.abs(ox - carX) < 25 && o.y + o.len > H - 62 && o.y < H - 62 + 34;
    });
    if (hit) {
      crashed = performance.now() + 900;
      status(`💥 Crashed at ${Math.floor(t)}s — needed ${target}s`);
      draw();
      raf = requestAnimationFrame(loop);
      return;
    }
    draw();
    status(`Survive ${target}s · ${Math.floor(t)}s · speed ×${(v / baseSpeed).toFixed(1)}`);
    if (t >= target) { over = true; clearTimeout(spawnTimer); return finish(true, Math.floor(t)); }
    raf = requestAnimationFrame(loop);
  }
  function tickSpawn() {
    if (over || crashed) return;
    spawnObstacle();
    spawnTimer = setTimeout(tickSpawn, Math.max(diff === 'hard' ? 420 : 540, 850 - t * 14));
  }
  status(`Swipe or use the arrows to change lanes · survive ${target}s`);
  draw();
  tickSpawn();
  raf = requestAnimationFrame(loop);
  return () => {
    over = true;
    cancelAnimationFrame(raf);
    clearTimeout(spawnTimer);
    cleanupInput();
  };
};

// ═══════════ ENERGY BONUS GAMES (opened with Deltix Energy) ═══════════

// ---- 18. Delta Four — connect four in a row before Nova does ----
GAME_IMPL.connect4 = (mount, diff, finish, status) => {
  const COLS = 7, ROWS = 6, ME = 1, NOVA = 2;
  const DEPTH = diff === 'hard' ? 5 : 3;
  const slip = diff === 'hard' ? 0 : 0.3; // easy Nova sometimes plays a lazy column
  let board = new Int8Array(ROWS * COLS);
  let over = false, myTurn = true, lastIdx = -1;

  const grid = makeGrid(mount, COLS, 'c4');
  const cells = [];
  for (let i = 0; i < ROWS * COLS; i++) {
    const c = document.createElement('button');
    c.className = 'cell';
    c.addEventListener('click', () => human(i % COLS));
    grid.appendChild(c);
    cells.push(c);
  }
  const at = (b, r, c) => b[r * COLS + c];
  const lowest = (b, c) => { for (let r = ROWS - 1; r >= 0; r--) if (!at(b, r, c)) return r; return -1; };
  const moves = (b) => { const m = []; for (let c = 0; c < COLS; c++) if (lowest(b, c) >= 0) m.push(c); return m; };
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  function lineFor(b, p) {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (at(b, r, c) !== p) continue;
      for (const [dr, dc] of DIRS) {
        const idx = [];
        let ok = true;
        for (let k = 0; k < 4; k++) {
          const rr = r + dr * k, cc = c + dc * k;
          if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || at(b, rr, cc) !== p) { ok = false; break; }
          idx.push(rr * COLS + cc);
        }
        if (ok) return idx;
      }
    }
    return null;
  }
  function evaluate(b) {
    // Window scoring: 3-in-a-row with a free slot is worth chasing, centre files matter.
    let s = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      for (const [dr, dc] of DIRS) {
        const er = r + dr * 3, ec = c + dc * 3;
        if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
        let mine = 0, theirs = 0;
        for (let k = 0; k < 4; k++) {
          const v = at(b, r + dr * k, c + dc * k);
          if (v === NOVA) mine++; else if (v === ME) theirs++;
        }
        if (mine && theirs) continue;
        if (mine === 3) s += 50; else if (mine === 2) s += 8; else if (mine === 1) s += 1;
        if (theirs === 3) s -= 60; else if (theirs === 2) s -= 9; else if (theirs === 1) s -= 1;
      }
    }
    for (let r = 0; r < ROWS; r++) { const v = at(b, r, 3); if (v === NOVA) s += 6; else if (v === ME) s -= 6; }
    return s;
  }
  function search(b, depth, alpha, beta, player) {
    if (lineFor(b, NOVA)) return { score: 100000 + depth };
    if (lineFor(b, ME)) return { score: -100000 - depth };
    const list = moves(b);
    if (!list.length || depth === 0) return { score: evaluate(b) };
    list.sort((a, z) => Math.abs(3 - a) - Math.abs(3 - z)); // centre-first ordering prunes better
    let best = null;
    for (const c of list) {
      const r = lowest(b, c);
      b[r * COLS + c] = player;
      const s = search(b, depth - 1, alpha, beta, player === NOVA ? ME : NOVA).score;
      b[r * COLS + c] = 0;
      if (!best || (player === NOVA ? s > best.score : s < best.score)) best = { score: s, move: c };
      if (player === NOVA) alpha = Math.max(alpha, s); else beta = Math.min(beta, s);
      if (alpha >= beta) break;
    }
    return best;
  }
  function render(dropped) {
    for (let i = 0; i < board.length; i++) {
      const v = board[i];
      cells[i].textContent = v === ME ? '🔴' : v === NOVA ? '🔵' : '';
      cells[i].classList.toggle('p1', v === ME);
      cells[i].classList.toggle('p2', v === NOVA);
      cells[i].classList.toggle('last', i === lastIdx);
    }
    if (dropped != null) {
      cells[dropped].classList.remove('pop');
      void cells[dropped].offsetWidth;
      cells[dropped].classList.add('pop');
    }
  }
  function end(winner) {
    over = true;
    const L = lineFor(board, winner);
    if (L) L.forEach((i) => cells[i].classList.add('win'));
    render();
    if (winner === ME) { status('Four in a row — you beat Nova! 🏆'); finish(true, 1); }
    else { status('Nova connected four. 🤖'); finish(false, 0); }
  }
  function place(col, player) {
    const r = lowest(board, col);
    if (r < 0) return false;
    lastIdx = r * COLS + col;
    board[lastIdx] = player;
    render(lastIdx);
    return true;
  }
  function human(col) {
    if (over || !myTurn) return;
    if (!place(col, ME)) return;
    if (lineFor(board, ME)) return end(ME);
    if (!moves(board).length) { over = true; status('Board full — a draw. No reward.'); return finish(false, 0); }
    myTurn = false;
    status(aiThinkLine('Nova'));
    novaTurn();
  }
  async function novaTurn() {
    await humanPause(500, 1300);
    if (over) return;
    const list = moves(board);
    let col = search(board, DEPTH, -Infinity, Infinity, NOVA).move;
    if (Math.random() < slip) col = list[Math.floor(Math.random() * list.length)];
    if (col == null) col = list[0];
    place(col, NOVA);
    if (lineFor(board, NOVA)) return end(NOVA);
    if (!moves(board).length) { over = true; status('Board full — a draw. No reward.'); return finish(false, 0); }
    myTurn = true;
    status('Your turn — drop a 🔴 into any column.');
  }
  render();
  status('You are 🔴 — tap a column. Four in a row wins.');
  return () => { over = true; };
};

// ---- 19. Delta Breaker — clear every brick, catch the ball ----
GAME_IMPL.breaker = (mount, diff, finish, status) => {
  const W = 260, H = 380;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');

  const COLS = diff === 'hard' ? 7 : 6;
  const ROWS = diff === 'hard' ? 5 : 4;
  const padW = diff === 'hard' ? 46 : 62;
  const speed0 = diff === 'hard' ? 3.4 : 2.7;
  let lives = diff === 'hard' ? 2 : 3;
  const BW = (W - 20) / COLS, BH = 15;
  const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7'];
  let bricks = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    bricks.push({ x: 10 + c * BW, y: 46 + r * (BH + 5), alive: true, col: COLORS[r % COLORS.length] });
  }
  let padX = W / 2, ball = null, over = false, launched = false, raf = 0, lastTs = 0;
  function resetBall() {
    launched = false;
    ball = { x: padX, y: H - 40, vx: 0, vy: 0, r: 5 };
  }
  resetBall();
  const remaining = () => bricks.filter((b) => b.alive).length;

  function movePad(clientX) {
    const rect = cv.getBoundingClientRect();
    padX = Math.max(padW / 2, Math.min(W - padW / 2, ((clientX - rect.left) / rect.width) * W));
    if (!launched) ball.x = padX;
  }
  const onDown = (e) => { movePad(e.clientX); launch(); };
  const onMove = (e) => { if (e.buttons || e.pointerType === 'touch') movePad(e.clientX); };
  function launch() {
    if (launched || over) return;
    launched = true;
    ball.vx = (Math.random() < 0.5 ? -1 : 1) * speed0 * 0.6;
    ball.vy = -speed0;
  }
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { padX = Math.max(padW / 2, padX - 18); if (!launched) ball.x = padX; }
    if (e.key === 'ArrowRight') { padX = Math.min(W - padW / 2, padX + 18); if (!launched) ball.x = padX; }
    if (e.key === ' ') launch();
  };
  document.addEventListener('keydown', onKey);

  function draw() {
    ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
    bricks.forEach((b) => {
      if (!b.alive) return;
      ctx.fillStyle = b.col;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(b.x + 2, b.y, BW - 4, BH, 4); else ctx.rect(b.x + 2, b.y, BW - 4, BH);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.25)';
      ctx.fillRect(b.x + 4, b.y + 2, BW - 8, 3);
    });
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(padX - padW / 2, H - 26, padW, 9, 5); else ctx.rect(padX - padW / 2, H - 26, padW, 9);
    ctx.fill();
    ctx.fillStyle = '#fde047';
    ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.r, 0, 6.29); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('❤'.repeat(lives), 10, 22);
    ctx.textAlign = 'right';
    ctx.fillText(`${remaining()} bricks`, W - 10, 22);
  }
  function loop(ts) {
    if (over) return;
    const dt = lastTs ? Math.min(3, (ts - lastTs) / (1000 / 60)) : 1;
    lastTs = ts;
    if (launched) {
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if (ball.x < ball.r) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); }
      if (ball.x > W - ball.r) { ball.x = W - ball.r; ball.vx = -Math.abs(ball.vx); }
      if (ball.y < ball.r + 28) { ball.y = ball.r + 28; ball.vy = Math.abs(ball.vy); }
      // Paddle bounce: the contact point steers the ball, so you can aim.
      if (ball.vy > 0 && ball.y > H - 26 - ball.r && ball.y < H - 12 && Math.abs(ball.x - padX) < padW / 2 + ball.r) {
        const rel = (ball.x - padX) / (padW / 2);
        const sp = Math.hypot(ball.vx, ball.vy) * 1.01;
        const ang = rel * 1.05;
        ball.vx = Math.sin(ang) * sp;
        ball.vy = -Math.abs(Math.cos(ang) * sp);
      }
      for (const b of bricks) {
        if (!b.alive) continue;
        if (ball.x > b.x && ball.x < b.x + BW && ball.y > b.y - ball.r && ball.y < b.y + BH + ball.r) {
          b.alive = false;
          ball.vy = -ball.vy;
          break;
        }
      }
      if (ball.y > H) {
        lives--;
        if (lives <= 0) {
          over = true; draw();
          status(`💀 Out of balls — ${remaining()} bricks left.`);
          return finish(false, (ROWS * COLS) - remaining());
        }
        status(`Ball lost — ${lives} left. Tap to launch.`);
        resetBall();
      }
      if (!remaining()) {
        over = true; draw();
        status('All bricks cleared! 🏆');
        return finish(true, ROWS * COLS);
      }
    }
    draw();
    if (launched) status(`${remaining()} bricks left · ${lives} ${lives === 1 ? 'ball' : 'balls'} ❤`);
    raf = requestAnimationFrame(loop);
  }
  status('Drag to move the paddle · tap to launch the ball.');
  draw();
  raf = requestAnimationFrame(loop);
  return () => {
    over = true;
    cancelAnimationFrame(raf);
    cv.removeEventListener('pointerdown', onDown);
    cv.removeEventListener('pointermove', onMove);
    document.removeEventListener('keydown', onKey);
  };
};

// ---- 20. Delta Tower — stack the beams, one miss trims you ----
GAME_IMPL.tower = (mount, diff, finish, status) => {
  const W = 260, H = 380, BH = 18;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  const target = diff === 'hard' ? 14 : 8;
  const baseW = diff === 'hard' ? 74 : 96;
  const speed0 = diff === 'hard' ? 2.6 : 1.6;
  const COLORS = ['#2f6bff', '#7c3aed', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444'];
  const stack = [{ x: (W - baseW) / 2, w: baseW }];
  let moving = { x: 0, w: baseW, dir: 1 };
  let over = false, raf = 0, lastTs = 0, flash = 0;

  const rowY = (i) => H - 30 - (i + 1) * BH; // index 0 = base row
  const camera = () => Math.max(0, (stack.length - 12) * BH); // scroll once the tower is tall
  function nextBeam() {
    const prev = stack[stack.length - 1];
    moving = { x: 0, w: prev.w, dir: 1 };
  }
  function drop() {
    if (over) return;
    const prev = stack[stack.length - 1];
    const left = Math.max(prev.x, moving.x);
    const right = Math.min(prev.x + prev.w, moving.x + moving.w);
    const overlap = right - left;
    if (overlap <= 2) {
      over = true;
      draw();
      status(`💥 Missed the tower at floor ${stack.length} — needed ${target}.`);
      return finish(false, stack.length);
    }
    stack.push({ x: left, w: overlap });
    flash = performance.now() + 180;
    if (stack.length >= target + 1) {
      over = true; draw();
      status(`Tower complete — ${target} floors! 🏆`);
      return finish(true, stack.length);
    }
    const perfect = overlap > prev.w - 3;
    status(`${perfect ? 'Perfect! ✨ ' : ''}Floor ${stack.length - 1}/${target} · beam ${Math.round(overlap)}px wide`);
    nextBeam();
  }
  const onDown = () => drop();
  cv.addEventListener('pointerdown', onDown);
  const onKey = (e) => { if (e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); drop(); } };
  document.addEventListener('keydown', onKey);

  function draw() {
    const cam = camera();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1a3a'); g.addColorStop(1, '#123a6b');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    for (let i = 0; i < 22; i++) ctx.fillRect((i * 61) % W, (i * 37) % 200, 2, 2); // stars
    stack.forEach((b, i) => {
      const y = rowY(i) + cam;
      if (y < -BH || y > H) return;
      ctx.fillStyle = COLORS[i % COLORS.length];
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(b.x, y, b.w, BH - 2, 3); else ctx.rect(b.x, y, b.w, BH - 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.fillRect(b.x + 2, y + 2, b.w - 4, 3);
    });
    if (!over) {
      const y = rowY(stack.length) + cam;
      ctx.fillStyle = COLORS[stack.length % COLORS.length];
      ctx.globalAlpha = performance.now() < flash ? 0.6 : 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(moving.x, y, moving.w, BH - 2, 3); else ctx.rect(moving.x, y, moving.w, BH - 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`Floor ${stack.length - 1}/${target}`, 10, 20);
    ctx.textAlign = 'right';
    ctx.fillText(`width ${Math.round(stack[stack.length - 1].w)}`, W - 10, 20);
  }
  function loop(ts) {
    if (over) return;
    const dt = lastTs ? Math.min(3, (ts - lastTs) / (1000 / 60)) : 1;
    lastTs = ts;
    const v = speed0 + stack.length * (diff === 'hard' ? 0.12 : 0.07);
    moving.x += v * moving.dir * dt;
    if (moving.x <= 0) { moving.x = 0; moving.dir = 1; }
    if (moving.x + moving.w >= W) { moving.x = W - moving.w; moving.dir = -1; }
    draw();
    raf = requestAnimationFrame(loop);
  }
  nextBeam();
  status(`Tap to drop the beam · stack ${target} floors`);
  raf = requestAnimationFrame(loop);
  return () => {
    over = true;
    cancelAnimationFrame(raf);
    cv.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
  };
};

// ---- 21. Delta Blocks — clear lines before the stack tops out ----
GAME_IMPL.blocks = (mount, diff, finish, status) => {
  const COLS = 10, ROWS = 16, CS = 22;
  const W = COLS * CS, H = ROWS * CS;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  const target = diff === 'hard' ? 10 : 5;
  const baseDrop = diff === 'hard' ? 620 : 900;
  const SHAPES = [
    { cells: [[0, 0], [0, 1], [0, 2], [0, 3]], col: '#22d3ee' },
    { cells: [[0, 0], [0, 1], [1, 0], [1, 1]], col: '#facc15' },
    { cells: [[0, 1], [1, 0], [1, 1], [1, 2]], col: '#a855f7' },
    { cells: [[0, 0], [1, 0], [1, 1], [1, 2]], col: '#3b82f6' },
    { cells: [[0, 2], [1, 0], [1, 1], [1, 2]], col: '#f97316' },
    { cells: [[0, 1], [0, 2], [1, 0], [1, 1]], col: '#22c55e' },
    { cells: [[0, 0], [0, 1], [1, 1], [1, 2]], col: '#ef4444' },
  ];
  const board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  let piece = null, lines = 0, over = false, raf = 0, dropTimer = 0;

  function spawn() {
    const s = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    piece = { cells: s.cells.map(([r, c]) => [r, c]), col: s.col, r: 0, c: 3 };
    if (collides(piece.cells, piece.r, piece.c)) {
      over = true;
      draw();
      status(`💀 Stack topped out — ${lines}/${target} lines.`);
      finish(false, lines);
      return false;
    }
    return true;
  }
  function collides(cells, r0, c0) {
    return cells.some(([r, c]) => {
      const rr = r0 + r, cc = c0 + c;
      return rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS || board[rr][cc];
    });
  }
  function rotate() {
    if (!piece) return;
    const h = Math.max(...piece.cells.map(([r]) => r)) + 1;
    const rotated = piece.cells.map(([r, c]) => [c, h - 1 - r]);
    for (const kick of [0, -1, 1, -2, 2]) {
      if (!collides(rotated, piece.r, piece.c + kick)) { piece.cells = rotated; piece.c += kick; draw(); return; }
    }
  }
  function move(dc) {
    if (!piece || collides(piece.cells, piece.r, piece.c + dc)) return;
    piece.c += dc;
    draw();
  }
  function step() {
    if (over || !piece) return;
    if (!collides(piece.cells, piece.r + 1, piece.c)) { piece.r++; draw(); return; }
    piece.cells.forEach(([r, c]) => { board[piece.r + r][piece.c + c] = piece.col; });
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r].every(Boolean)) {
        board.splice(r, 1);
        board.unshift(Array(COLS).fill(null));
        cleared++;
        r++;
      }
    }
    if (cleared) {
      lines += cleared;
      status(cleared > 1 ? `${cleared} lines at once! ⚡ ${lines}/${target}` : `Line cleared · ${lines}/${target}`);
    } else {
      const firstFilled = board.findIndex((row) => row.some(Boolean));
      const height = firstFilled < 0 ? 0 : ROWS - firstFilled;
      status(`${lines}/${target} lines · stack ${height}/${ROWS}`);
    }
    if (lines >= target) {
      over = true;
      draw();
      status(`${target} lines cleared! 🏆`);
      return finish(true, lines);
    }
    spawn();
    draw();
  }
  function tick() {
    if (over) return;
    step();
    dropTimer = setTimeout(tick, Math.max(220, baseDrop - lines * 55));
  }
  const cleanupInput = directionInput(mount, (d) => {
    if (over) return;
    if (d === 'left') move(-1);
    else if (d === 'right') move(1);
    else if (d === 'up') rotate();
    else if (d === 'down') step();
  });
  function cell(r, c, col) {
    ctx.fillStyle = col;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(c * CS + 1, r * CS + 1, CS - 2, CS - 2, 3);
    else ctx.rect(c * CS + 1, r * CS + 1, CS - 2, CS - 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.fillRect(c * CS + 3, r * CS + 3, CS - 6, 3);
  }
  function draw() {
    ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(148,163,184,.14)'; ctx.lineWidth = 1;
    for (let c = 1; c < COLS; c++) { ctx.beginPath(); ctx.moveTo(c * CS, 0); ctx.lineTo(c * CS, H); ctx.stroke(); }
    for (let r = 1; r < ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * CS); ctx.lineTo(W, r * CS); ctx.stroke(); }
    board.forEach((row, r) => row.forEach((v, c) => v && cell(r, c, v)));
    if (piece && !over) piece.cells.forEach(([r, c]) => cell(piece.r + r, piece.c + c, piece.col));
  }
  spawn();
  draw();
  status(`◀ ▶ move · ▲ rotate · ▼ drop · clear ${target} lines`);
  tick();
  return () => {
    over = true;
    clearTimeout(dropTimer);
    cancelAnimationFrame(raf);
    cleanupInput();
  };
};

// ---- 22. Delta Flyer — tap to fly, thread every gate ----
GAME_IMPL.flyer = (mount, diff, finish, status) => {
  const W = 260, H = 380;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  const target = diff === 'hard' ? 18 : 10;
  const gap = diff === 'hard' ? 92 : 116;
  const gateSpeed = diff === 'hard' ? 2.4 : 1.9;
  const GRAV = 0.32, FLAP = -5.2, GW = 34;
  let y = H / 2, vy = 0, gates = [], passed = 0, over = false, raf = 0, lastTs = 0, started = false, tilt = 0;

  function addGate(x) {
    const top = 40 + Math.random() * (H - gap - 110);
    gates.push({ x, top, scored: false });
  }
  addGate(W + 40);
  addGate(W + 40 + 170);

  function flap() {
    if (over) return;
    started = true;
    vy = FLAP;
  }
  const onDown = () => flap();
  cv.addEventListener('pointerdown', onDown);
  const onKey = (e) => { if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); flap(); } };
  document.addEventListener('keydown', onKey);

  function draw() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1a3a'); g.addColorStop(1, '#1e3a8a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    for (let i = 0; i < 26; i++) ctx.fillRect((i * 71 + passed * 3) % W, (i * 43) % H, 2, 2);
    gates.forEach((gt) => {
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      if (ctx.roundRect) { ctx.roundRect(gt.x, 0, GW, gt.top, 5); ctx.roundRect(gt.x, gt.top + gap, GW, H - gt.top - gap, 5); }
      else { ctx.rect(gt.x, 0, GW, gt.top); ctx.rect(gt.x, gt.top + gap, GW, H - gt.top - gap); }
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.25)';
      ctx.fillRect(gt.x + 3, gt.top - 10, GW - 6, 8);
      ctx.fillRect(gt.x + 3, gt.top + gap + 2, GW - 6, 8);
    });
    ctx.save();
    ctx.translate(70, y);
    ctx.rotate(tilt);
    ctx.font = '26px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🚀', 0, 0);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${passed} / ${target}`, 10, 24);
    if (!started) {
      ctx.textAlign = 'center';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('Tap to fly', W / 2, H - 40);
    }
  }
  function crash(msg) {
    over = true;
    draw();
    status(msg);
    finish(false, passed);
  }
  function loop(ts) {
    if (over) return;
    const dt = lastTs ? Math.min(3, (ts - lastTs) / (1000 / 60)) : 1;
    lastTs = ts;
    if (started) {
      vy += GRAV * dt;
      y += vy * dt;
      tilt = Math.max(-0.5, Math.min(0.8, vy * 0.06));
      const v = gateSpeed + passed * 0.045;
      gates.forEach((gt) => (gt.x -= v * dt));
      if (gates.length && gates[0].x < -GW) gates.shift();
      const lastX = gates.length ? gates[gates.length - 1].x : 0;
      if (lastX < W - 150) addGate(W + 20);
      for (const gt of gates) {
        if (!gt.scored && gt.x + GW < 70 - 12) {
          gt.scored = true;
          passed++;
          if (passed >= target) {
            over = true; draw();
            status(`${target} gates cleared! 🏆`);
            return finish(true, passed);
          }
        }
        const hitX = 70 + 12 > gt.x && 70 - 12 < gt.x + GW;
        if (hitX && (y - 11 < gt.top || y + 11 > gt.top + gap)) return crash(`💥 Clipped a gate at ${passed}/${target}.`);
      }
      if (y > H - 10) return crash(`💥 Down at ${passed}/${target}.`);
      if (y < 10) { y = 10; vy = 0; }
      status(`Gate ${passed}/${target} · tap to fly`);
    }
    draw();
    raf = requestAnimationFrame(loop);
  }
  status(`Tap to fly · thread ${target} gates`);
  draw();
  raf = requestAnimationFrame(loop);
  return () => {
    over = true;
    cancelAnimationFrame(raf);
    cv.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
  };
};

// ═════════════════════ INSTANT ENERGY GAMES (tap → reveal) ═════════════════════
// Spend Energy for a one-tap reveal. The SERVER (POST /rewards/energy-game)
// decides and pays the outcome; the client only animates it. Energy is
// non-monetary, and any $DLTX is clamped to the shared daily reward cap — so
// these can never inflate supply and no ad ever gates a payout.
// Each game is a self-contained render(mount, cfg) function; add more by
// registering them in INSTANT_GAMES with a matching backend config entry.

const INSTANT_GAMES = {
  smash: {
    name: 'Smash the Diamond',
    emoji: '💎',
    cost: 100,
    tagline: 'One tap cracks the diamond — grab what flies out.',
    accent: '#38bdf8',
    render: renderSmash,
  },
  scratch: {
    name: 'Energy Scratch Card',
    emoji: '🎟️',
    cost: 50,
    tagline: 'Scratch the foil — instantly reveal your prize.',
    accent: '#f59e0b',
    render: renderScratch,
  },
  box: {
    name: 'Pick a Box',
    emoji: '🎁',
    cost: 100,
    tagline: 'Three boxes, one pick — what did you choose?',
    accent: '#a855f7',
    render: renderBox,
  },
  balloon: {
    name: 'Pop the Balloon',
    emoji: '🎈',
    cost: 50,
    tagline: 'Five balloons — pick one and pop it for a prize.',
    accent: '#ef4444',
    render: renderBalloon,
  },
  coin: {
    name: 'Flip the Coin',
    emoji: '🪙',
    cost: 30,
    tagline: 'Call it — win bonus Energy. No cash on this one.',
    accent: '#eab308',
    render: renderCoin,
  },
  rocket: {
    name: 'Rocket Launch',
    emoji: '🚀',
    cost: 80,
    tagline: 'Launch — how far you fly sets your reward.',
    accent: '#6366f1',
    render: renderRocket,
  },
  target: {
    name: 'Energy Target',
    emoji: '🎯',
    cost: 50,
    tagline: 'Take the shot — where it lands is your prize.',
    accent: '#10b981',
    render: renderTarget,
  },
  dice: {
    name: 'Deltix Dice',
    emoji: '🎲',
    cost: 50,
    tagline: 'Roll the dice — match a pair for a prize.',
    accent: '#8b5cf6',
    render: renderDice,
  },
};

let instantBusy = false;

function instantEnergy() {
  return window.energyBalance ? window.energyBalance() : 0;
}

function renderInstantGames() {
  const grid = gel('instantGamesGrid');
  if (!grid) return;
  const have = instantEnergy();
  grid.innerHTML = Object.entries(INSTANT_GAMES)
    .map(([id, g]) => {
      const afford = have >= g.cost;
      return `<button class="instant-card${afford ? '' : ' short'}" data-instant="${id}" style="--ig-accent:${g.accent}">
        <span class="ig-emoji">${g.emoji}</span>
        <span class="ig-name">${g.name}</span>
        <span class="ig-tag">${g.tagline}</span>
        <span class="ig-cost">⚡ ${g.cost} Energy</span>
      </button>`;
    })
    .join('');
  grid.querySelectorAll('.instant-card').forEach((c) =>
    c.addEventListener('click', () => openInstantGame(c.dataset.instant))
  );
}

function openInstantGame(id) {
  const g = INSTANT_GAMES[id];
  if (!g) return;
  instantBusy = false;
  gel('instantTitle').textContent = `${g.emoji} ${g.name}`;
  gel('instantTagline').textContent = g.tagline;
  gel('instantCost').textContent = `Cost: ⚡ ${g.cost} per play`;
  gel('instantStatus').textContent = '';
  updateInstantBal();
  const mount = gel('instantMount');
  mount.innerHTML = '';
  ArcadeSound.unlock();
  g.render(mount, g);
  gel('instantModal').hidden = false;
}

function closeInstantGame() {
  gel('instantModal').hidden = true;
  gel('instantMount').innerHTML = '';
  instantBusy = false;
  renderInstantGames();
}
gel('instantClose')?.addEventListener('click', closeInstantGame);
// Exposed so app.js (back button / expired session) can close it too.
window.closeInstantGame = closeInstantGame;

function updateInstantBal() {
  const bal = gel('instantBal');
  if (bal) bal.textContent = `⚡ ${instantEnergy()} Energy`;
}

/** Shared play call. Returns the server result, or null on error (toasted). */
async function playInstant(id, g) {
  const have = instantEnergy();
  if (have < g.cost) {
    toast(`Not enough Energy — ${g.cost - have} more needed. Earn Energy in the Energy tab.`);
    return null;
  }
  try {
    const r = await api('POST', '/rewards/energy-game', { game: id });
    // Sync the account's Energy immediately so the balance never lags.
    if (typeof state !== 'undefined' && state.energy) state.energy.energy = r.energy;
    updateInstantBal();
    if (window.renderEnergy) window.renderEnergy();
    return r;
  } catch (e) {
    if (e.status === 401) return null; // session expired — app.js handles it
    toast(e.message || 'Could not play right now — please try again.');
    return null;
  }
}

/** Human-readable prize label for the reveal panel. */
function instantRewardLabel(r) {
  if (r.reward > 0) {
    return `<span class="ig-win">+${fmt(r.reward)} $DLTX</span>` +
      (r.energyAwarded > 0 ? `<span class="ig-win ig-win-sm">+${r.energyAwarded} ⚡</span>` : '');
  }
  if (r.energyAwarded > 0) return `<span class="ig-win">+${r.energyAwarded} ⚡ Energy</span>`;
  return `<span class="ig-miss">Try again!</span>`;
}

/** Shared celebration + status + wallet/energy refresh after a reveal. */
function announceInstant(r) {
  const prefix = r.freeSpin ? '🎡 Free Spin! ' : '';
  if (r.reward > 0) {
    (window.celebrate || toast)({
      amount: r.reward,
      title: prefix + 'You won $DLTX!',
      subtitle: r.energyAwarded > 0 ? `Plus ${r.energyAwarded} ⚡ Energy — added to your wallet.` : 'Added to your wallet.',
      icon: '💎',
    });
    Promise.all([window.loadWallet?.(), window.loadTx?.()]).catch(() => {});
  } else if (r.energyAwarded > 0) {
    (window.celebrate || toast)({
      amount: r.energyAwarded,
      unit: '⚡ Energy',
      title: prefix + 'You won Energy!',
      subtitle: `You now have ${r.energy} ⚡ total.`,
      icon: '⚡',
      duration: 2400,
    });
  } else if (r.capped) {
    toast('You cracked a $DLTX prize — but today\u2019s reward cap is reached. Come back tomorrow!');
  } else {
    try { ArcadeSound.lose(); } catch {}
  }
  const status = gel('instantStatus');
  if (status) {
    const parts = [];
    if (r.reward > 0) parts.push(`+${fmt(r.reward)} $DLTX`);
    if (r.energyAwarded > 0) parts.push(`+${r.energyAwarded} ⚡`);
    status.textContent = parts.length ? `Result: ${parts.join(' · ')}` : 'No prize this time — try again!';
  }
}

/** A shimmering blue Deltix diamond, drawn inline (no image dependency). */
function diamondSVG() {
  return `<svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
    <defs>
      <linearGradient id="dgTop" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#e0f2fe"/><stop offset="1" stop-color="#38bdf8"/>
      </linearGradient>
      <linearGradient id="dgBot" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#0369a1"/>
      </linearGradient>
    </defs>
    <polygon points="50,6 88,36 50,36" fill="url(#dgTop)"/>
    <polygon points="12,36 50,6 50,36" fill="#7dd3fc"/>
    <polygon points="12,36 88,36 50,94" fill="url(#dgBot)"/>
    <polygon points="12,36 50,36 50,94" fill="#0284c7"/>
    <polygon points="50,36 88,36 50,94" fill="#0ea5e9"/>
    <line x1="50" y1="6" x2="50" y2="94" stroke="#e0f2fe" stroke-width="0.6" opacity="0.5"/>
  </svg>`;
}

/** Reusable shard/particle burst for a winning reveal. */
function burstShards(stage, color = '#38bdf8', count = 16) {
  if (!stage) return;
  for (let i = 0; i < count; i++) {
    const s = document.createElement('i');
    s.className = 'ig-shard';
    const ang = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const dist = 60 + Math.random() * 70;
    s.style.setProperty('--tx', `${Math.cos(ang) * dist}px`);
    s.style.setProperty('--ty', `${Math.sin(ang) * dist}px`);
    s.style.background = i % 3 === 0 ? '#fbbf24' : color;
    s.style.animationDelay = `${Math.random() * 0.08}s`;
    stage.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }
}

// ---- Game 1: Smash the Diamond ----
function renderSmash(mount, g) {
  const wrap = document.createElement('div');
  wrap.className = 'instant-play smash-wrap';
  wrap.innerHTML = `
    <div class="smash-stage">
      <div class="smash-diamond" id="smashDiamond">${diamondSVG()}</div>
      <div class="ig-reward" id="smashReward" hidden></div>
    </div>
    <button class="btn primary ig-action" id="smashBtn">💥 SMASH — ⚡ ${g.cost}</button>`;
  mount.appendChild(wrap);
  const stage = wrap.querySelector('.smash-stage');
  const diamond = wrap.querySelector('#smashDiamond');
  const rewardEl = wrap.querySelector('#smashReward');
  const btn = wrap.querySelector('#smashBtn');

  async function smash() {
    if (instantBusy) return;
    instantBusy = true;
    btn.disabled = true;
    diamond.classList.remove('cracked');
    rewardEl.hidden = true;
    diamond.classList.add('shake');
    try { ArcadeSound.tap(); } catch {}
    const r = await playInstant('smash', g);
    diamond.classList.remove('shake');
    if (!r) { instantBusy = false; btn.disabled = false; return; }
    diamond.classList.add('cracked');
    try { ArcadeSound.tap(); } catch {}
    burstShards(stage, g.accent);
    setTimeout(() => {
      rewardEl.innerHTML = instantRewardLabel(r);
      rewardEl.hidden = false;
      announceInstant(r);
      btn.textContent = `↻ Smash again — ⚡ ${g.cost}`;
      btn.disabled = false;
      instantBusy = false;
    }, 440);
  }
  btn.addEventListener('click', smash);
}

// ---- Shared engine for single-button instant games (scratch / rocket / target) ----
// hooks: { actionLabel, againLabel, buildStage(), windUp(stage), reveal(stage, r) -> delayMs }
function instantButtonGame(mount, id, g, hooks) {
  const wrap = document.createElement('div');
  wrap.className = 'instant-play';
  wrap.innerHTML = `
    <div class="ig-stage">${hooks.buildStage()}<div class="ig-reward" hidden></div></div>
    <button class="btn primary ig-action">${hooks.actionLabel} — ⚡ ${g.cost}</button>`;
  mount.appendChild(wrap);
  const stage = wrap.querySelector('.ig-stage');
  const rewardEl = wrap.querySelector('.ig-reward');
  const btn = wrap.querySelector('.ig-action');

  async function play() {
    if (instantBusy) return;
    instantBusy = true;
    btn.disabled = true;
    rewardEl.hidden = true;
    if (hooks.windUp) hooks.windUp(stage);
    try { ArcadeSound.tap(); } catch {}
    const r = await playInstant(id, g);
    if (!r) { instantBusy = false; btn.disabled = false; return; }
    const delay = (hooks.reveal && hooks.reveal(stage, r)) || 380;
    setTimeout(() => {
      rewardEl.innerHTML = instantRewardLabel(r);
      rewardEl.hidden = false;
      if (r.reward > 0 || r.energyAwarded > 0) burstShards(stage, g.accent, 14);
      announceInstant(r);
      btn.textContent = `↻ ${hooks.againLabel} — ⚡ ${g.cost}`;
      btn.disabled = false;
      instantBusy = false;
    }, delay);
  }
  btn.addEventListener('click', play);
}

// ---- Shared engine for "pick one of N" instant games (box / balloon) ----
function instantPickGame(mount, id, g, { count, emoji, itemClass, instruction, againText }) {
  const wrap = document.createElement('div');
  wrap.className = 'instant-play';
  wrap.innerHTML = `
    <div class="pick-instruction">${instruction}</div>
    <div class="ig-stage pick-row">${Array.from({ length: count }, (_, i) =>
      `<button class="pick-item ${itemClass}" data-i="${i}"><span class="pick-emoji">${emoji}</span></button>`).join('')}</div>
    <div class="pick-reward" hidden></div>`;
  mount.appendChild(wrap);
  const items = [...wrap.querySelectorAll('.pick-item')];
  const row = wrap.querySelector('.pick-row');
  const rewardEl = wrap.querySelector('.pick-reward');
  const instr = wrap.querySelector('.pick-instruction');

  async function pick(item) {
    if (instantBusy) return;
    const have = instantEnergy();
    if (have < g.cost) {
      toast(`Not enough Energy — ${g.cost - have} more needed. Earn Energy in the Energy tab.`);
      return;
    }
    rewardEl.hidden = true;
    items.forEach((b) => b.classList.remove('chosen', 'dim', 'pop'));
    instantBusy = true;
    items.forEach((b) => (b.disabled = true));
    try { ArcadeSound.tap(); } catch {}
    const r = await playInstant(id, g);
    if (!r) { instantBusy = false; items.forEach((b) => (b.disabled = false)); return; }
    item.classList.add('chosen', 'pop');
    items.filter((b) => b !== item).forEach((b) => b.classList.add('dim'));
    setTimeout(() => {
      rewardEl.innerHTML = instantRewardLabel(r);
      rewardEl.hidden = false;
      if (r.reward > 0 || r.energyAwarded > 0) burstShards(row, g.accent, 14);
      announceInstant(r);
      instr.textContent = againText;
      items.forEach((b) => (b.disabled = false));
      instantBusy = false;
    }, 400);
  }
  items.forEach((b) => b.addEventListener('click', () => pick(b)));
}

// ---- Game 2: Energy Scratch Card ----
function renderScratch(mount, g) {
  instantButtonGame(mount, 'scratch', g, {
    actionLabel: '✋ Scratch',
    againLabel: 'Scratch again',
    buildStage: () => `<div class="scratch-foil"><span>SCRATCH<br>HERE</span></div>`,
    windUp: (stage) => stage.querySelector('.scratch-foil')?.classList.remove('gone'),
    reveal: (stage) => { stage.querySelector('.scratch-foil')?.classList.add('gone'); return 520; },
  });
}

// ---- Game 3: Pick a Box ----
function renderBox(mount, g) {
  instantPickGame(mount, 'box', g, {
    count: 3, emoji: '🎁', itemClass: 'box-item',
    instruction: 'Pick a box to open', againText: 'Tap a box to play again',
  });
}

// ---- Game 4: Pop the Balloon ----
function renderBalloon(mount, g) {
  instantPickGame(mount, 'balloon', g, {
    count: 5, emoji: '🎈', itemClass: 'balloon-item',
    instruction: 'Pick a balloon to pop', againText: 'Pop another to play again',
  });
}

// ---- Game 5: Flip the Coin (Energy / bonus only — never $DLTX) ----
function renderCoin(mount, g) {
  const wrap = document.createElement('div');
  wrap.className = 'instant-play coin-wrap';
  wrap.innerHTML = `
    <div class="ig-stage coin-stage"><div class="coin"><span class="coin-face">Δ</span></div></div>
    <div class="pick-reward" hidden></div>
    <div class="pick-instruction">Call it — bonus Energy only</div>
    <div class="coin-choice">
      <button class="btn ghost" data-side="heads">👑 Heads</button>
      <button class="btn ghost" data-side="tails">Δ Tails</button>
    </div>`;
  mount.appendChild(wrap);
  const coin = wrap.querySelector('.coin');
  const face = wrap.querySelector('.coin-face');
  const stage = wrap.querySelector('.coin-stage');
  const rewardEl = wrap.querySelector('.pick-reward');
  const btns = [...wrap.querySelectorAll('.coin-choice button')];

  async function flip(side) {
    if (instantBusy) return;
    const have = instantEnergy();
    if (have < g.cost) {
      toast(`Not enough Energy — ${g.cost - have} more needed. Earn Energy in the Energy tab.`);
      return;
    }
    rewardEl.hidden = true;
    instantBusy = true;
    btns.forEach((b) => (b.disabled = true));
    coin.classList.remove('flipping');
    void coin.offsetWidth; // restart the animation
    coin.classList.add('flipping');
    try { ArcadeSound.tap(); } catch {}
    const r = await playInstant('coin', g);
    if (!r) { instantBusy = false; btns.forEach((b) => (b.disabled = false)); return; }
    setTimeout(() => {
      coin.classList.remove('flipping');
      // Land on the called side when you win, the other side when you don't.
      const won = r.energyAwarded > 0;
      face.textContent = (won === (side === 'heads')) ? '👑' : 'Δ';
      rewardEl.innerHTML = instantRewardLabel(r);
      rewardEl.hidden = false;
      if (won) burstShards(stage, g.accent, 12);
      announceInstant(r);
      btns.forEach((b) => (b.disabled = false));
      instantBusy = false;
    }, 950);
  }
  btns.forEach((b) => b.addEventListener('click', () => flip(b.dataset.side)));
}

// ---- Game 6: Rocket Launch ----
function renderRocket(mount, g) {
  const DESTS = ['🌙 Reached the Moon', '♂️ Landed on Mars', '🪐 Passed Jupiter', '☄️ Into deep space'];
  instantButtonGame(mount, 'rocket', g, {
    actionLabel: '🚀 Launch',
    againLabel: 'Launch again',
    buildStage: () => `<div class="rocket-track"><div class="rocket-ship">🚀</div></div><div class="rocket-dest"></div>`,
    windUp: (stage) => {
      stage.querySelector('.rocket-ship')?.classList.remove('launched');
      const d = stage.querySelector('.rocket-dest'); if (d) d.textContent = '';
    },
    reveal: (stage, r) => {
      stage.querySelector('.rocket-ship')?.classList.add('launched');
      const d = stage.querySelector('.rocket-dest');
      // Reach farther when you win — pure flavour, the server sets the reward.
      const pool = (r.reward > 0 || r.energyAwarded > 0) ? DESTS.slice(1) : DESTS.slice(0, 2);
      setTimeout(() => { if (d) d.textContent = pool[Math.floor(Math.random() * pool.length)]; }, 520);
      return 900;
    },
  });
}

// ---- Game 7: Energy Target ----
function renderTarget(mount, g) {
  instantButtonGame(mount, 'target', g, {
    actionLabel: '🎯 Shoot',
    againLabel: 'Shoot again',
    buildStage: () => `<div class="target-face"></div><span class="dart-mark" hidden>❌</span>`,
    windUp: (stage) => { const d = stage.querySelector('.dart-mark'); if (d) d.hidden = true; },
    reveal: (stage, r) => {
      const d = stage.querySelector('.dart-mark');
      const win = r.reward > 0 || r.energyAwarded > 0;
      const rad = win ? 6 + Math.random() * 20 : 44 + Math.random() * 28;
      const ang = Math.random() * Math.PI * 2;
      if (d) {
        d.style.left = `calc(50% + ${Math.cos(ang) * rad}px)`;
        d.style.top = `calc(50% + ${Math.sin(ang) * rad}px)`;
        d.hidden = false;
      }
      return 520;
    },
  });
}

// ---- Game 8: Deltix Dice ----
function renderDice(mount, g) {
  const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  const wrap = document.createElement('div');
  wrap.className = 'instant-play';
  wrap.innerHTML = `
    <div class="ig-stage dice-stage">
      <span class="die" id="die1">⚀</span><span class="die" id="die2">⚅</span>
      <div class="ig-reward" hidden></div>
    </div>
    <button class="btn primary ig-action" id="diceBtn">🎲 Roll — ⚡ ${g.cost}</button>`;
  mount.appendChild(wrap);
  const stage = wrap.querySelector('.dice-stage');
  const d1 = wrap.querySelector('#die1');
  const d2 = wrap.querySelector('#die2');
  const rewardEl = wrap.querySelector('.ig-reward');
  const btn = wrap.querySelector('#diceBtn');
  let tumble = null;

  async function roll() {
    if (instantBusy) return;
    instantBusy = true;
    btn.disabled = true;
    rewardEl.hidden = true;
    d1.classList.add('rolling');
    d2.classList.add('rolling');
    tumble = setInterval(() => {
      d1.textContent = FACES[Math.floor(Math.random() * 6)];
      d2.textContent = FACES[Math.floor(Math.random() * 6)];
    }, 80);
    try { ArcadeSound.tap(); } catch {}
    const r = await playInstant('dice', g);
    clearInterval(tumble);
    d1.classList.remove('rolling');
    d2.classList.remove('rolling');
    if (!r) { instantBusy = false; btn.disabled = false; return; }
    const win = r.reward > 0 || r.energyAwarded > 0;
    if (win) {
      const f = FACES[3 + Math.floor(Math.random() * 3)];
      d1.textContent = f; d2.textContent = f; // matching pair on a win
    } else {
      d1.textContent = FACES[Math.floor(Math.random() * 3)];
      d2.textContent = FACES[3 + Math.floor(Math.random() * 3)]; // mismatched
    }
    setTimeout(() => {
      rewardEl.innerHTML = instantRewardLabel(r);
      rewardEl.hidden = false;
      if (win) burstShards(stage, g.accent, 14);
      announceInstant(r);
      btn.textContent = `↻ Roll again — ⚡ ${g.cost}`;
      btn.disabled = false;
      instantBusy = false;
    }, 460);
  }
  btn.addEventListener('click', roll);
}
