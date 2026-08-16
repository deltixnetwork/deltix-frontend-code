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
};

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
};

const arcadeState = { games: [], sessionId: null, currentGame: null, difficulty: 'easy', cleanup: null };

// ---------- Arcade tab ----------
async function loadArcade() {
  try {
    const a = await api('GET', '/arcade');
    arcadeState.games = a.games;
    gel('arcadeMeta').innerHTML = [
      ['Reward per win', `${a.arcade.rewardEasyWin} (easy) / ${a.arcade.rewardHardWin} (hard) $DLTX`],
      ['Earned today', `${fmt(a.earnedToday)} $DLTX`],
      ['Remaining today', `${fmt(a.remainingToday)} of ${fmt(a.arcade.dailyCap)} $DLTX`],
    ]
      .map(([k, v]) => `<div class="supply-row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
      .join('');
    updateAdBonusCard();
    gel('gamesGrid').innerHTML = a.games
      .map(
        (g) => `<button class="game-card game-card-${g.id}" data-game="${g.id}">
          <div class="game-card-img-wrap"><img src="${ARCADE_3D_IMAGES[g.id] || 'assets/nav-arcade.svg'}" class="game-card-3d-img" alt="${g.name}" /></div>
          <div class="game-card-info">
            <span class="g-name">${g.name}</span>
            <span class="g-tag">${g.tagline}</span>
          </div>
        </button>`
      )
      .join('');
    gel('gamesGrid').querySelectorAll('.game-card').forEach((c) =>
      c.addEventListener('click', () => openGame(c.dataset.game))
    );
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
  gel('gameTitle').textContent = g.name;
  gel('gameTagline').textContent = g.tagline;
  updateRewardHint();
  gel('diffEasy').classList.add('active');
  gel('diffHard').classList.remove('active');
  gel('gameSetup').hidden = false;
  gel('gameArea').hidden = true;
  gel('gameModal').hidden = false;
  if (window.updateTabAd) window.updateTabAd();
}
function updateRewardHint() {
  const g = arcadeState.currentGame;
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
  if (arcadeState.cleanup) arcadeState.cleanup();
  arcadeState.cleanup = null;
  arcadeState.sessionId = null;
  gel('gameMount').innerHTML = '';
  gel('gameModal').hidden = true;
  if (window.updateTabAd) window.updateTabAd();
}

gel('startGameBtn').addEventListener('click', async () => {
  const g = arcadeState.currentGame;
  gel('startGameBtn').disabled = true;
  try {
    const r = await api('POST', '/arcade/session/start', { game: g.id, difficulty: arcadeState.difficulty });
    arcadeState.sessionId = r.sessionId;
    gel('gameSetup').hidden = true;
    gel('gameArea').hidden = false;
    const mount = gel('gameMount');
    mount.innerHTML = '';
    arcadeState.cleanup = GAME_IMPL[g.id](mount, arcadeState.difficulty, finishGame, setGameStatus);
  } catch (e) {
    toast(e.message);
  } finally {
    gel('startGameBtn').disabled = false;
  }
});

function setGameStatus(text) {
  gel('gameStatus').textContent = text;
}

async function finishGame(won, score) {
  if (!arcadeState.sessionId) return;
  const sessionId = arcadeState.sessionId;
  arcadeState.sessionId = null;
  try {
    const r = await api('POST', `/arcade/session/${sessionId}/complete`, { won, score });
    if (r.won && r.tooFast) {
      // Fast win — reward is claimable by watching a rewarded ad.
      setGameStatus('You won! Watch a short ad to claim your reward 🎬');
      offerAdClaim(sessionId, won, score);
      return; // no interstitial while a rewarded claim is pending
    }
    if (r.won && r.reward > 0) {
      setGameStatus(`You won! +${fmt(r.reward)} $DLTX earned 🏆`);
      toast(`+${fmt(r.reward)} $DLTX game reward`);
      Promise.all([loadWallet(), loadTx(), loadArcade()]).catch(() => {});
    } else if (r.won && r.capped) {
      setGameStatus('You won — but today\u2019s reward cap is reached. Come back tomorrow!');
    } else {
      setGameStatus('Game over — no reward this time. Try again!');
    }
  } catch (e) {
    setGameStatus(e.message);
  }
  maybeShowInterstitial();
}

/** Fast-win reward claim: play a rewarded ad, then settle the session. */
function offerAdClaim(sessionId, won, score) {
  const btn = document.createElement('button');
  btn.className = 'btn primary ad-claim-btn';
  btn.textContent = '▶ Watch ad · claim reward';
  gel('gameMount').appendChild(btn);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Loading ad…';
    try {
      const earned = await playRewardedAd();
      if (!earned) {
        toast('Ad not completed — reward unclaimed.');
        btn.disabled = false;
        btn.textContent = '▶ Watch ad · claim reward';
        return;
      }
      const r = await api('POST', `/arcade/session/${sessionId}/complete`, { won, score, adPlayed: true });
      btn.remove();
      if (r.won && r.reward > 0) {
        setGameStatus(`Reward claimed! +${fmt(r.reward)} $DLTX 🏆`);
        toast(`+${fmt(r.reward)} $DLTX game reward`);
        Promise.all([loadWallet(), loadTx(), loadArcade()]).catch(() => {});
      } else if (r.won && r.capped) {
        setGameStatus('You won — but today\u2019s reward cap is reached. Come back tomorrow!');
      }
    } catch (e) {
      setGameStatus(e.message);
      btn.remove();
    }
  });
}

// ---------- Rewarded ad (Sustainability Fund bonus) ----------
// Never gates faucet, staking, or DAO actions — purely an optional bonus tap
// on the Arcade tab. Native: real AdMob rewarded ad, reward paid only on the
// SDK's own "user earned reward" callback. Web/dev: disclosed simulated ad.
function updateAdBonusCard() {
  const card = gel('adBonusCard');
  if (!card) return;
  card.hidden = false;
}
gel('watchAdBtn')?.addEventListener('click', async () => {
  const btn = gel('watchAdBtn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const earned = await playRewardedAd();
    if (!earned) {
      toast('Ad not completed — no bonus this time.');
      return;
    }
    const r = await api('POST', '/arcade/ad-bonus');
    toast(`+${fmt(r.reward)} $DLTX bonus · ${r.usedToday}/${r.maxPerDay} today`);
    Promise.all([loadWallet(), loadTx(), loadArcade()]).catch(() => {});
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Watch';
  }
});

function playRewardedAd() {
  return new Promise((resolve) => {
    const cap = window.Capacitor;
    const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
    if (cap && cap.isNativePlatform && cap.isNativePlatform() && AdMob) {
      let earned = false;
      const onReward = AdMob.addListener?.('onRewardedVideoReward', () => (earned = true));
      const onDismiss = AdMob.addListener?.('onRewardedVideoAdDismissed', async () => {
        onReward?.remove?.();
        onDismiss?.remove?.();
        resolve(earned);
      });
      AdMob.prepareRewardVideoAd({ adId: ADMOB_REWARDED_ID, isTesting: ADMOB_TESTING })
        .then(() => AdMob.showRewardVideoAd())
        .catch(() => {
          onReward?.remove?.();
          onDismiss?.remove?.();
          resolve(false);
        });
      return;
    }
    // Web / dev fallback — disclosed simulated ad so the flow is testable.
    if (!confirm('▶ Simulated rewarded ad (web preview)\n\nOn a real device this plays a full AdMob rewarded video. Continue to claim the test bonus?')) {
      return resolve(false);
    }
    setTimeout(() => resolve(true), 600);
  });
}

// ---------- Interstitial (native only, frequency-capped) ----------
// Shown at most every 3rd completed game AND never sooner than 60s apart —
// deliberately conservative to stay well inside AdMob's policy limits.
function maybeShowInterstitial() {
  const cap = window.Capacitor;
  const AdMob = cap && cap.Plugins && cap.Plugins.AdMob;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !AdMob) return;
  gamesSinceInterstitial++;
  const cooledDown = Date.now() - lastInterstitialAt > 60000;
  if (gamesSinceInterstitial < 3 || !cooledDown) return;
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
      // Maya plays near-perfect on both modes — on easy she slips like a human once in a while.
      const slip = diff !== 'hard' && Math.random() < 0.15;
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
  const pairs = diff === 'hard' ? 10 : 8;
  const recall = diff === 'hard' ? 0.95 : 0.8; // chance Iris memorizes a revealed card
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
  const target = diff === 'hard' ? 10 : 8;
  const wander = diff === 'hard' ? 0.18 : 0.32; // how often Rex drifts off the optimal path
  let speed = diff === 'hard' ? 115 : 150;
  const minSpeed = diff === 'hard' ? 80 : 105;
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
  const target = diff === 'hard' ? 1024 : 512;
  const blockerEvery = diff === 'hard' ? 9 : 13;  // moves between Δ crystal spawns
  const blockerTtl = diff === 'hard' ? 18 : 14;   // moves before a crystal dissolves
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
    let turns = { left: 0, up: 1, right: 2, down: 3 }[d];
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
  const blanks = diff === 'hard' ? 52 : 42;
  const maxStrikes = diff === 'hard' ? 2 : 3;
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
  const mines = diff === 'hard' ? 22 : 13;
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
  const board = makeGrid(mount, N, 'slide');
  let moves = 0;
  function render() {
    board.innerHTML = '';
    tiles.forEach((v, i) => {
      const el = document.createElement('button');
      el.className = 'cell' + (v ? '' : ' blank');
      el.textContent = v || '';
      el.addEventListener('click', () => {
        const bi = tiles.indexOf(0);
        const r = Math.floor(i / N), c = i % N, br = Math.floor(bi / N), bc = bi % N;
        if (Math.abs(r - br) + Math.abs(c - bc) !== 1) return;
        [tiles[i], tiles[bi]] = [tiles[bi], tiles[i]];
        moves++;
        render();
        if (tiles.every((v2, i2) => v2 === (i2 + 1) % (N * N))) finish(true, moves);
        else status(`${moves} moves`);
      });
      board.appendChild(el);
    });
  }
  status('Order the tiles 1 → ' + (N * N - 1));
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
  const board = makeGrid(mount, 8, 'reversi');
  const cells = [];
  for (let i = 0; i < 64; i++) {
    const el = document.createElement('button');
    el.className = 'cell r-cell';
    el.addEventListener('click', () => play(i));
    board.appendChild(el);
    cells.push(el);
  }
  function render(hints) {
    b.forEach((v, i) => {
      cells[i].innerHTML = v ? `<span class="disc ${v === 1 ? 'you' : 'ai'}"></span>` : '';
      cells[i].classList.toggle('hint', Boolean(hints && hints.includes(i)));
    });
    const you = b.filter((v) => v === 1).length, ai = b.filter((v) => v === 2).length;
    status(`You ${you} · Victor ${ai}`);
  }
  function gameEnd() {
    const you = b.filter((v) => v === 1).length, ai = b.filter((v) => v === 2).length;
    finish(you > ai, you);
  }
  function aiTurn() {
    const opts = movesFor(b, 2);
    if (!opts.length) {
      if (!movesFor(b, 1).length) return gameEnd();
      render(movesFor(b, 1));
      return; // AI passes
    }
    // Both modes play positionally like a person — easy occasionally settles
    // for a second-best move (a very human slip), hard is ruthless.
    const scoreMove = (i) => {
      const f = flips(b, i, 2);
      const sim = b.slice();
      sim[i] = 2; f.forEach((j) => (sim[j] = 2));
      return W[i] + 2 * f.length - 3 * movesFor(sim, 1).length;
    };
    const ranked = opts.slice().sort((x, y) => scoreMove(y) - scoreMove(x));
    let pick = ranked[0];
    if (diff !== 'hard' && ranked.length > 1 && Math.random() < 0.3) {
      pick = ranked[1 + Math.floor(Math.random() * Math.min(2, ranked.length - 1))];
    }
    const f = flips(b, pick, 2);
    b[pick] = 2; f.forEach((j) => (b[j] = 2));
    const yours = movesFor(b, 1);
    render(yours);
    if (!yours.length) {
      if (!movesFor(b, 2).length) return gameEnd();
      status('No move for you — Victor plays again…');
      setTimeout(aiTurn, 700 + Math.random() * 600); // you pass
    }
  }
  function play(i) {
    const f = flips(b, i, 1);
    if (!f.length) return;
    b[i] = 1; f.forEach((j) => (b[j] = 1));
    render();
    status(aiThinkLine('Victor'));
    setTimeout(aiTurn, 500 + Math.random() * 800);
  }
  render(movesFor(b, 1));
  return () => {};
};

// ---- 9. Pattern Recall ----
GAME_IMPL.recall = (mount, diff, finish, status) => {
  const target = diff === 'hard' ? 12 : 8;
  const speed = diff === 'hard' ? 320 : 500;
  const pads = ['#1f66f2', '#16a34a', '#f59e0b', '#dc2626'];
  const grid = makeGrid(mount, 2, 'recall');
  const els = pads.map((color, i) => {
    const el = document.createElement('button');
    el.className = 'cell pad';
    el.style.setProperty('--pad', color);
    el.addEventListener('click', () => tap(i));
    grid.appendChild(el);
    return el;
  });
  let seq = [], pos = 0, accepting = false, timers = [];
  function flash(i, ms) {
    els[i].classList.add('lit');
    timers.push(setTimeout(() => els[i].classList.remove('lit'), ms));
  }
  function playback() {
    accepting = false;
    status(`Watch… round ${seq.length}/${target}`);
    seq.forEach((p, k) => timers.push(setTimeout(() => flash(p, speed * 0.6), k * speed + 300)));
    timers.push(setTimeout(() => {
      accepting = true; pos = 0;
      status(`Your turn — repeat ${seq.length} steps`);
    }, seq.length * speed + 400));
  }
  function nextRound() {
    seq.push(Math.floor(Math.random() * 4));
    playback();
  }
  function tap(i) {
    if (!accepting) return;
    flash(i, 180);
    if (i !== seq[pos]) { accepting = false; return finish(false, seq.length - 1); }
    pos++;
    if (pos === seq.length) {
      accepting = false;
      if (seq.length >= target) return finish(true, seq.length);
      timers.push(setTimeout(nextRound, 700));
    }
  }
  nextRound();
  return () => timers.forEach(clearTimeout);
};

// ---- 10. Reaction Rush ----
GAME_IMPL.reaction = (mount, diff, finish, status) => {
  const N = diff === 'hard' ? 4 : 3;
  const goal = diff === 'hard' ? 28 : 20;
  const grid = makeGrid(mount, N, 'reaction');
  const cells = [];
  for (let i = 0; i < N * N; i++) {
    const el = document.createElement('button');
    el.className = 'cell rx-cell';
    el.addEventListener('click', () => {
      if (i === lit) { hits++; light(); update(); }
    });
    grid.appendChild(el);
    cells.push(el);
  }
  let lit = -1, hits = 0, left = 30;
  function light() {
    if (lit >= 0) cells[lit].classList.remove('lit');
    let next;
    do { next = Math.floor(Math.random() * N * N); } while (next === lit);
    lit = next;
    cells[lit].classList.add('lit');
  }
  function update() {
    status(`Hit ${goal} diamonds · ${hits}/${goal} · ${left}s left`);
  }
  light(); update();
  const clock = setInterval(() => {
    left--;
    update();
    if (left <= 0) {
      clearInterval(clock);
      finish(hits >= goal, hits);
    }
  }, 1000);
  return () => clearInterval(clock);
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
      toks.forEach((pos) => {
        if (pos < 0 || pos > 61) return;
        const [r, c] = cellOf(p, pos);
        const t = document.createElement('div');
        t.className = 'ludo-token';
        t.style.setProperty('--c', colors[p]);
        t.style.gridRow = r + 1;
        t.style.gridColumn = c + 1;
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
      // The AI players know the rules: prefer a capture, then getting a token
      // home, then a safe square, then the most advanced token. On easy they
      // occasionally play a casual (suboptimal) move, like a relaxed human.
      const capture = opts.find((i) => wouldCapture(turn, i, roll));
      const finisher = opts.find((i) => (tokens[turn][i] === -1 ? 1 : tokens[turn][i] + roll) === 62);
      const safeLanding = opts.find((i) => {
        const next = tokens[turn][i] === -1 ? 1 : tokens[turn][i] + roll;
        return next >= 1 && next <= 55 && SAFE.has((START[turn] + next - 1) % 56);
      });
      const smart = capture ?? finisher ?? safeLanding ?? opts.reduce((best, i) => (tokens[turn][i] > tokens[turn][best] ? i : best), opts[0]);
      const pick = diff === 'hard' || Math.random() < 0.7
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
  rollBtn.addEventListener('click', async () => {
    if (over || turn !== 0 || rolling) return;
    rolling = true;
    rollBtn.disabled = true;
    const roll = await rollDice();
    const opts = movable(0, roll);
    if (!opts.length) {
      status(`You rolled ${roll} — no valid move.`);
      rolling = false;
      await new Promise((r) => setTimeout(r, 500));
      if (roll !== 6) turn = 1;
      aiTurn();
      return;
    }
    const pick = opts.reduce((best, i) => (tokens[0][i] > tokens[0][best] ? i : best), opts[0]);
    const captured = moveToken(0, pick, roll);
    render();
    status(captured ? `You captured ${captured}'s token! 🎯` : `You rolled ${roll} and moved.`);
    rolling = false;
    if (endCheck(0)) return;
    await new Promise((r) => setTimeout(r, 400));
    if (roll !== 6) turn = 1;
    if (turn === 0) updateHuman(); else aiTurn();
  });
  render();
  updateHuman();
  return () => {};
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
  let sel = null, over = false, human = 'w'; // uppercase = white = human
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
    nb[m.to[0]][m.to[1]] = nb[m.from[0]][m.from[1]];
    nb[m.from[0]][m.from[1]] = null;
    // auto-queen promotion
    if (nb[m.to[0]][m.to[1]] === 'P' && m.to[0] === 0) nb[m.to[0]][m.to[1]] = 'Q';
    if (nb[m.to[0]][m.to[1]] === 'p' && m.to[0] === 7) nb[m.to[0]][m.to[1]] = 'q';
    return nb;
  }
  const VAL = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 100 };
  function evalBoard(b) {
    let s = 0;
    for (const row of b) for (const c of row) if (c) s += VAL[c.toUpperCase()] * (isWhite(c) ? 1 : -1);
    return s;
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
    return pseudoMoves(r, c, b).filter(([nr, nc]) => !inCheck(apply(b, { from: [r, c], to: [nr, nc] }), white));
  }
  function render() {
    board.forEach((row, r) => row.forEach((c, ci) => {
      const el = cells[r * 8 + ci];
      el.textContent = c ? (isWhite(c) ? P[c] : p2[c.toUpperCase()]) : '';
      el.classList.toggle('sel', !!sel && sel[0] === r && sel[1] === ci);
    }));
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
    const moves = legalMoves(false);
    if (!moves.length) {
      over = true;
      const end = gameEndFor(false);
      status(end === 'checkmate' ? 'Checkmate — you win! ♔' : 'Stalemate — a draw.');
      return finish(end === 'checkmate', 1);
    }
    let pick;
    if (diff === 'hard') {
      // 2-ply search: prefer mate, otherwise minimise the player's best reply.
      const mating = moves.find((m) => legalMoves(true, apply(board, m)).length === 0 && inCheck(apply(board, m), true));
      if (mating) pick = mating;
      else {
        let bestScore = Infinity;
        pick = moves[0];
        for (const m of moves) {
          const b1 = apply(board, m);
          const replies = legalMoves(true, b1);
          let score;
          if (!replies.length) {
            score = inCheck(b1, true) ? -Infinity : 0; // mate or stalemate
          } else {
            score = -Infinity;
            for (const r of replies) {
              const s = evalBoard(apply(b1, r));
              if (s > score) score = s;
            }
          }
          if (score < bestScore) { bestScore = score; pick = m; }
        }
      }
    } else {
      // Easy: greedy 1-ply like a club player — grabs material, avoids hanging
      // the moved piece, but slips into a second-choice move now and then.
      const scored = moves.map((m) => {
        const b1 = apply(board, m);
        let s = -evalBoard(b1); // higher = better for black
        const movedVal = VAL[(board[m.from[0]][m.from[1]] || 'p').toUpperCase()];
        const recapture = allMoves(true, b1).some(({ to }) => to[0] === m.to[0] && to[1] === m.to[1]);
        if (recapture) s -= movedVal * 0.8;
        if (inCheck(b1, true)) s += 0.5; // likes giving check
        return { m, s };
      }).sort((a, z) => z.s - a.s);
      const slip = Math.random() < 0.2 && scored.length > 1
        ? 1 + Math.floor(Math.random() * Math.min(3, scored.length - 1))
        : 0;
      pick = scored[slip].m;
    }
    board = apply(board, pick);
    render();
    const winner = kingCaptured(board);
    if (winner) { over = true; return finish(winner === 'white', 1); }
    const end = gameEndFor(true);
    if (end) {
      over = true;
      status(end === 'checkmate' ? 'Checkmate — Elena wins.' : 'Stalemate — a draw.');
      return finish(false, 1);
    }
    status(inCheck(board, true) ? 'Check! Your move (white)' : 'Your move (white)');
  }
  function onCell(r, c) {
    if (over) return;
    const piece = board[r][c];
    if (sel) {
      const legal = legalMovesFrom(sel[0], sel[1]).some(([nr, nc]) => nr === r && nc === c);
      if (legal) {
        board = apply(board, { from: sel, to: [r, c] });
        sel = null;
        render();
        const winner = kingCaptured(board);
        if (winner) { over = true; return finish(winner === 'white', 1); }
        const end = gameEndFor(false);
        if (end) {
          over = true;
          status(end === 'checkmate' ? 'Checkmate — you win! ♔' : 'Stalemate — a draw.');
          return finish(end === 'checkmate', 1);
        }
        status(inCheck(board, false) ? `Check! ${aiThinkLine('Elena')}` : aiThinkLine('Elena'));
        setTimeout(aiMove, 500 + Math.random() * 900);
        return;
      }
      sel = isWhite(piece) ? [r, c] : null;
      render();
      return;
    }
    if (isWhite(piece)) { sel = [r, c]; render(); }
  }
  status('You are White vs Elena — tap a piece, then a destination.');
  render();
  return () => {};
};

// ---- 13. Delta Card Draw (Deltix original suits — best hand, no wagering) ----
GAME_IMPL.threecard = (mount, diff, finish, status) => {
  const rounds = diff === 'hard' ? 7 : 5;
  const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  // Deltix original suits: Delta Δ, Gem ◆, Node ●, Peak ▲ — no third-party card faces.
  const SUITS = ['Δ','◆','●','▲'];
  const RED = new Set(['◆','▲']);
  let wins = 0, losses = 0, round = 0;
  const table = document.createElement('div');
  table.className = 'card-table';
  mount.appendChild(table);
  const dealBtn = document.createElement('button');
  dealBtn.className = 'btn primary';
  dealBtn.textContent = 'Deal';
  mount.appendChild(dealBtn);

  function draw3() {
    const deck = [];
    for (const r of RANKS) for (const s of SUITS) deck.push({ r, s });
    shuffleArr(deck);
    return [deck.slice(0, 3), deck.slice(3, 6)];
  }
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
  function renderHands(you, ai, reveal) {
    const fmtHand = (hand, hide) =>
      hand.map((c) => hide
        ? '<span class="pcard back">Δ</span>'
        : `<span class="pcard ${RED.has(c.s) ? 'red' : ''}">${c.r}<i class="suit">${c.s}</i></span>`).join('');
    table.innerHTML = `
      <div class="hand-row"><div class="hand-label">Dealer Rio</div><div class="hand">${fmtHand(ai, !reveal)}</div></div>
      <div class="hand-row"><div class="hand-label">You</div><div class="hand">${fmtHand(you, false)}</div></div>`;
  }
  dealBtn.addEventListener('click', () => {
    round++;
    const [you, ai] = draw3();
    renderHands(you, ai, false);
    dealBtn.disabled = true;
    status(`Round ${round}/${rounds} — revealing…`);
    setTimeout(() => {
      renderHands(you, ai, true);
      const you_s = handScore(you), ai_s = handScore(ai);
      const cmp = compare(you_s, ai_s);
      if (cmp > 0) wins++;
      else if (cmp < 0) losses++;
      status(`${cmp > 0 ? 'You win the round!' : cmp < 0 ? 'Rio wins the round.' : 'Push.'} · You ${wins} – Rio ${losses}`);
      if (round >= rounds) {
        setTimeout(() => finish(wins > losses, wins), 900);
      } else {
        dealBtn.disabled = false;
        dealBtn.textContent = 'Deal next round';
      }
    }, 900);
  });
  status(`Best of ${rounds} hands vs Dealer Rio — Deltix suits Δ ◆ ● ▲, no wagering.`);
  return () => {};
};

// ---- 14. Carom Strike (2D physics flick-to-pot) ----
GAME_IMPL.carom = (mount, diff, finish, status) => {
  const W = 300, H = 300, R = 8;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  const pocketR = 16;
  const pockets = [[0,0],[W/2,0],[W,0],[0,H],[W/2,H],[W,H]];
  const target = diff === 'hard' ? 7 : 4;
  const maxShots = diff === 'hard' ? 14 : 10;
  let pucks = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    pucks.push({ x: W/2 + Math.cos(ang) * 40, y: H/2 + Math.sin(ang) * 40, vx: 0, vy: 0, out: false });
  }
  const striker = { x: W/2, y: H - 30, vx: 0, vy: 0, out: false };
  let potted = 0, shots = 0, dragging = false, sx = 0, sy = 0, moving = false;

  function pottedCount() { return potted; }
  function draw() {
    ctx.fillStyle = '#0f7a3d'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#0a5c2c'; ctx.lineWidth = 10; ctx.strokeRect(5, 5, W - 10, H - 10);
    pockets.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, pocketR, 0, 7); ctx.fillStyle = '#0a0a0a'; ctx.fill(); });
    pucks.forEach((p) => { if (p.out) return; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 7); ctx.fillStyle = '#f1f5f9'; ctx.fill(); ctx.strokeStyle = '#94a3b8'; ctx.stroke(); });
    if (!striker.out) { ctx.beginPath(); ctx.arc(striker.x, striker.y, R + 1, 0, 7); ctx.fillStyle = '#1f66f2'; ctx.fill(); }
    if (dragging) {
      ctx.beginPath(); ctx.moveTo(striker.x, striker.y); ctx.lineTo(sx, sy);
      ctx.strokeStyle = 'rgba(31,102,242,.5)'; ctx.lineWidth = 2; ctx.stroke();
    }
  }
  function physicsStep() {
    let anyMoving = false;
    const all = [striker, ...pucks];
    all.forEach((p) => {
      if (p.out) return;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.985; p.vy *= 0.985;
      if (p.x < 12) { p.x = 12; p.vx *= -0.8; } if (p.x > W - 12) { p.x = W - 12; p.vx *= -0.8; }
      if (p.y < 12) { p.y = 12; p.vy *= -0.8; } if (p.y > H - 12) { p.y = H - 12; p.vy *= -0.8; }
      for (const [px, py] of pockets) {
        if (Math.hypot(p.x - px, p.y - py) < pocketR) { p.out = true; if (p !== striker) potted++; }
      }
      if (Math.hypot(p.vx, p.vy) > 0.05) anyMoving = true;
    });
    // simple pairwise collision
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.out || b.out) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d < R * 2 && d > 0) {
        const nx = dx / d, ny = dy / d, overlap = R * 2 - d;
        a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
        b.x += nx * overlap / 2; b.y += ny * overlap / 2;
        const avx = a.vx, avy = a.vy;
        a.vx = b.vx; a.vy = b.vy; b.vx = avx; b.vy = avy;
      }
    }
    return anyMoving;
  }
  let raf;
  function loop() {
    const anyMoving = physicsStep();
    draw();
    moving = anyMoving;
    if (moving) raf = requestAnimationFrame(loop);
    else {
      status(`Potted ${potted}/${target} · shot ${shots}/${maxShots}`);
      if (potted >= target) return finish(true, shots);
      if (striker.out) return finish(false, shots);
      if (shots >= maxShots) return finish(false, shots);
    }
  }
  cv.addEventListener('pointerdown', (e) => {
    if (moving) return;
    dragging = true;
    const rect = cv.getBoundingClientRect();
    sx = (e.clientX - rect.left) * (W / rect.width); sy = (e.clientY - rect.top) * (H / rect.height);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = cv.getBoundingClientRect();
    sx = (e.clientX - rect.left) * (W / rect.width); sy = (e.clientY - rect.top) * (H / rect.height);
    draw();
  });
  cv.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    const dx = striker.x - sx, dy = striker.y - sy;
    const power = Math.min(14, Math.hypot(dx, dy) / 8);
    const ang = Math.atan2(dy, dx);
    striker.vx = Math.cos(ang) * power; striker.vy = Math.sin(ang) * power;
    shots++;
    loop();
  });
  status(`Drag from the blue striker to aim, release to flick · pot ${target} in ${maxShots} shots`);
  draw();
  return () => cancelAnimationFrame(raf);
};

// ---- 15. Delta Slicer (swipe-to-slice Deltix gems, dodge dark orbs) ----
GAME_IMPL.slicer = (mount, diff, finish, status) => {
  const W = 300, H = 380;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  const target = diff === 'hard' ? 28 : 18;
  const spawnMs = diff === 'hard' ? 500 : 680;
  const missLimit = diff === 'hard' ? 5 : 6;
  // Deltix original gems — drawn in brand colours, no third-party art.
  const GEMS = ['#1f66f2', '#16a34a', '#f59e0b', '#dc2626', '#8b5cf6'];
  let items = [], score = 0, misses = 0, over = false, trail = [];
  function spawn() {
    if (over) return;
    const isBomb = Math.random() < 0.18;
    items.push({
      x: 30 + Math.random() * (W - 60), y: H + 20,
      vy: -(6 + Math.random() * 2.5), vx: (Math.random() - 0.5) * 2,
      g: 0.14, bomb: isBomb, color: GEMS[Math.floor(Math.random() * GEMS.length)],
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.1,
      sliced: false, r: 16,
    });
    setTimeout(spawn, spawnMs);
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
  function draw() {
    ctx.fillStyle = '#eef3ff'; ctx.fillRect(0, 0, W, H);
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
  let raf;
  function loop() {
    items.forEach((it) => { it.vy += it.g; it.x += it.vx; it.y += it.vy; it.rot += it.vr; });
    items = items.filter((it) => {
      if (it.y < -30 && !it.sliced && !it.bomb) { misses++; return false; }
      return it.y < H + 40;
    });
    draw();
    status(`${score}/${target} gems sliced · ${misses}/${missLimit} missed`);
    if (score >= target) { over = true; return finish(true, score); }
    if (misses >= missLimit) { over = true; return finish(false, score); }
    raf = requestAnimationFrame(loop);
  }
  function pointAt(e) {
    const rect = cv.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (W / rect.width), y: (e.clientY - rect.top) * (H / rect.height) };
  }
  function trySlice(pt) {
    items.forEach((it) => {
      if (it.sliced) return;
      if (Math.hypot(it.x - pt.x, it.y - pt.y) < it.r + 10) {
        it.sliced = true;
        if (it.bomb) { over = true; cancelAnimationFrame(raf); return finish(false, score); }
        score++;
      }
    });
  }
  cv.addEventListener('pointerdown', (e) => { trail = [pointAt(e)]; trySlice(trail[0]); });
  cv.addEventListener('pointermove', (e) => {
    if (!e.buttons) return;
    const pt = pointAt(e);
    trail.push(pt);
    if (trail.length > 8) trail.shift();
    trySlice(pt);
  });
  cv.addEventListener('pointerup', () => (trail = []));
  status(`Slice ${target} Deltix gems · avoid the dark orbs`);
  spawn();
  loop();
  return () => cancelAnimationFrame(raf);
};

// ---- 16. Penalty Kicks (soccer shootout) ----
GAME_IMPL.soccer = (mount, diff, finish, status) => {
  const rounds = diff === 'hard' ? 6 : 5;
  const need = Math.ceil(rounds / 2) + 1;
  const W = 300, H = 220;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  let round = 0, goals = 0, misses = 0, chosen = null, animating = false;
  const zones = [W * 0.22, W * 0.5, W * 0.78];
  const history = [0, 0, 0]; // shots per zone — hard keeper learns your habits
  function draw(ballPos, keeperX, result) {
    ctx.fillStyle = '#dff5e3'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 4;
    ctx.strokeRect(W * 0.15, 20, W * 0.7, 60);
    ctx.fillStyle = '#1f66f2';
    ctx.fillRect(keeperX - 18, 22, 36, 50);
    ctx.beginPath(); ctx.arc(ballPos.x, ballPos.y, 9, 0, 7); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#0f172a'; ctx.fill(); ctx.stroke();
    if (result) {
      ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = result === 'GOAL' ? '#16a34a' : '#dc2626';
      ctx.fillText(result, W / 2, H - 20);
    }
  }
  function reset() { chosen = null; draw({ x: W / 2, y: H - 30 }, W / 2, null); }
  function kick(zoneIdx) {
    if (animating || round >= rounds) return;
    animating = true;
    chosen = zoneIdx;
    history[zoneIdx]++;
    // The keeper studies your habits — dives to your favourite zone often.
    const favourite = history.indexOf(Math.max(...history));
    const keeperGuess = Math.random() < (diff === 'hard' ? 0.6 : 0.45)
      ? favourite
      : Math.floor(Math.random() * 3);
    const targetX = zones[zoneIdx];
    let t = 0;
    const startY = H - 30;
    const anim = setInterval(() => {
      t += 0.08;
      const y = startY - t * (startY - 40);
      draw({ x: W / 2 + (targetX - W / 2) * t, y }, zones[keeperGuess], null);
      if (t >= 1) {
        clearInterval(anim);
        const saved = keeperGuess === zoneIdx && Math.random() < (diff === 'hard' ? 0.6 : 0.5);
        round++;
        if (saved) misses++; else goals++;
        draw({ x: targetX, y: 40 }, zones[keeperGuess], saved ? 'SAVED' : 'GOAL');
        status(`You ${goals} \u2013 ${misses} missed \u00b7 round ${round}/${rounds}`);
        setTimeout(() => {
          if (goals >= need) return finish(true, goals);
          if (misses >= need) return finish(false, goals);
          if (round >= rounds) return finish(goals > misses, goals);
          animating = false;
          reset();
        }, 700);
      }
    }, 16);
  }
  const row = document.createElement('div');
  row.className = 'kick-row';
  ['Left', 'Center', 'Right'].forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.textContent = label;
    b.addEventListener('click', () => kick(i));
    row.appendChild(b);
  });
  mount.appendChild(row);
  status(`Score ${need} to win the shootout \u00b7 tap a side to shoot`);
  reset();
  return () => {};
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
  const target = diff === 'hard' ? 50 : 35; // seconds to survive
  let lane = 1, obstacles = [], speed = diff === 'hard' ? 5.5 : 4.2, t = 0, over = false, dashOffset = 0;
  const cleanupInput = directionInput(mount, (d) => {
    if (d === 'left') lane = Math.max(0, lane - 1);
    if (d === 'right') lane = Math.min(LANES - 1, lane + 1);
  });
  function spawnObstacle() {
    obstacles.push({ lane: Math.floor(Math.random() * LANES), y: -40 });
  }
  let raf, spawnTimer;
  function draw() {
    ctx.fillStyle = '#1e293b'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#475569'; ctx.setLineDash([16, 14]); ctx.lineDashOffset = -dashOffset;
    for (let i = 1; i < LANES; i++) { ctx.beginPath(); ctx.moveTo(i * laneW, 0); ctx.lineTo(i * laneW, H); ctx.stroke(); }
    ctx.setLineDash([]);
    obstacles.forEach((o) => {
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(o.lane * laneW + laneW * 0.2, o.y, laneW * 0.6, 26);
    });
    ctx.fillStyle = '#1f66f2';
    ctx.fillRect(lane * laneW + laneW * 0.25, H - 60, laneW * 0.5, 34);
  }
  function loop() {
    if (over) return;
    t += 1 / 60;
    dashOffset += speed;
    obstacles.forEach((o) => (o.y += speed));
    obstacles = obstacles.filter((o) => o.y < H + 40);
    const collided = obstacles.some((o) => o.lane === lane && o.y > H - 90 && o.y < H - 40);
    if (collided) { over = true; clearTimeout(spawnTimer); cancelAnimationFrame(raf); return finish(false, Math.floor(t)); }
    draw();
    status(`Survive ${target}s \u00b7 ${Math.floor(t)}s elapsed`);
    if (t >= target) { over = true; clearTimeout(spawnTimer); cancelAnimationFrame(raf); return finish(true, Math.floor(t)); }
    raf = requestAnimationFrame(loop);
  }
  function tickSpawn() {
    if (over) return;
    spawnObstacle();
    spawnTimer = setTimeout(tickSpawn, Math.max(450, 900 - t * 15));
  }
  status(`Swipe or use the arrows to change lanes \u00b7 survive ${target}s`);
  draw();
  tickSpawn();
  loop();
  return () => {
    over = true;
    cancelAnimationFrame(raf);
    clearTimeout(spawnTimer);
    cleanupInput();
  };
};
