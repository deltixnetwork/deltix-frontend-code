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
    gel('gamesGrid').innerHTML = a.games
      .map(
        (g) => `<button class="game-card" data-game="${g.id}">
          <span class="g-icon">${ARCADE_ICONS[g.id] || '◆'}</span>
          <span class="g-name">${g.name}</span>
          <span class="g-tag">${g.tagline}</span>
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
}

// ---------- shared helpers ----------
function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
  status('You are ◆ — take the board!');
  function render() {
    board.forEach((v, i) => {
      cells[i].textContent = v === 'X' ? '◆' : v === 'O' ? '○' : '';
      cells[i].classList.toggle('p1', v === 'X');
    });
  }
  function end(w) {
    over = true;
    if (w === 'X') finish(true, 1);
    else { status(w === 'draw' ? 'Draw — no reward. Play again!' : 'The AI wins this one.'); finish(false, 0); }
  }
  function play(i) {
    if (over || board[i]) return;
    board[i] = 'X';
    render();
    let w = winner(board);
    if (w) return end(w);
    const empty = board.map((v, j) => (v ? null : j)).filter((v) => v !== null);
    const move = diff === 'hard' ? minimax(board.slice(), 'O').move : empty[Math.floor(Math.random() * empty.length)];
    board[move] = 'O';
    render();
    w = winner(board);
    if (w) end(w);
  }
  return () => {};
};

// ---- 2. Memory Match ----
GAME_IMPL.memory = (mount, diff, finish, status) => {
  const glyphs = ['◆','●','▲','■','★','✚','☾','⬟','✿','⬢'];
  const pairs = diff === 'hard' ? 10 : 6;
  const deck = shuffleArr(glyphs.slice(0, pairs).flatMap((g) => [g, g]));
  const grid = makeGrid(mount, 4, 'memory');
  let open = [], matched = 0, moves = 0, lock = false;
  status('Find all the pairs.');
  deck.forEach((glyph, i) => {
    const c = document.createElement('button');
    c.className = 'cell face-down';
    c.addEventListener('click', () => {
      if (lock || open.includes(i) || c.classList.contains('done')) return;
      c.textContent = glyph;
      c.classList.remove('face-down');
      open.push(i);
      if (open.length === 2) {
        moves++;
        const [a, b] = open;
        const els = grid.children;
        if (deck[a] === deck[b]) {
          els[a].classList.add('done');
          els[b].classList.add('done');
          matched++;
          open = [];
          status(`${matched}/${pairs} pairs · ${moves} moves`);
          if (matched === pairs) finish(true, moves);
        } else {
          lock = true;
          setTimeout(() => {
            els[a].textContent = ''; els[b].textContent = '';
            els[a].classList.add('face-down'); els[b].classList.add('face-down');
            open = []; lock = false;
          }, 700);
        }
      }
    });
    grid.appendChild(c);
  });
  return () => {};
};

// ---- 3. Delta Snake ----
GAME_IMPL.snake = (mount, diff, finish, status) => {
  const N = 15, target = diff === 'hard' ? 12 : 5, speed = diff === 'hard' ? 110 : 190;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 300;
  cv.className = 'game-canvas';
  mount.appendChild(cv);
  const ctx = cv.getContext('2d');
  let snake = [{ x: 7, y: 7 }], dir = 'right', nextDir = 'right', eaten = 0, food = null, timer = null;
  const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const cleanupInput = directionInput(mount, (d) => { if (d !== opposite[dir]) nextDir = d; });
  function placeFood() {
    do { food = { x: Math.floor(Math.random() * N), y: Math.floor(Math.random() * N) }; }
    while (snake.some((s) => s.x === food.x && s.y === food.y));
  }
  placeFood();
  status(`Eat ${target} to win · 0/${target}`);
  function draw() {
    ctx.fillStyle = '#f4f7ff'; ctx.fillRect(0, 0, 300, 300);
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.moveTo(food.x * 20 + 10, food.y * 20 + 3);
    ctx.lineTo(food.x * 20 + 17, food.y * 20 + 10);
    ctx.lineTo(food.x * 20 + 10, food.y * 20 + 17);
    ctx.lineTo(food.x * 20 + 3, food.y * 20 + 10);
    ctx.fill();
    snake.forEach((s, i) => {
      ctx.fillStyle = i === 0 ? '#1f66f2' : '#7ba3f7';
      ctx.fillRect(s.x * 20 + 1, s.y * 20 + 1, 18, 18);
    });
  }
  function tick() {
    dir = nextDir;
    const h = { ...snake[0] };
    if (dir === 'up') h.y--; if (dir === 'down') h.y++;
    if (dir === 'left') h.x--; if (dir === 'right') h.x++;
    if (h.x < 0 || h.y < 0 || h.x >= N || h.y >= N || snake.some((s) => s.x === h.x && s.y === h.y)) {
      clearInterval(timer);
      return finish(false, eaten);
    }
    snake.unshift(h);
    if (h.x === food.x && h.y === food.y) {
      eaten++;
      status(`Eat ${target} to win · ${eaten}/${target}`);
      if (eaten >= target) { clearInterval(timer); draw(); return finish(true, eaten); }
      placeFood();
    } else snake.pop();
    draw();
  }
  draw();
  timer = setInterval(tick, speed);
  return () => { clearInterval(timer); cleanupInput(); };
};

// ---- 4. Merge 2048 (slide & merge) ----
GAME_IMPL.merge = (mount, diff, finish, status) => {
  const target = diff === 'hard' ? 1024 : 256;
  let grid = Array.from({ length: 4 }, () => Array(4).fill(0));
  let score = 0, over = false;
  const board = makeGrid(mount, 4, 'merge');
  const cells = [];
  for (let i = 0; i < 16; i++) {
    const c = document.createElement('div');
    c.className = 'cell tile';
    board.appendChild(c);
    cells.push(c);
  }
  function addTile() {
    const empty = [];
    grid.forEach((row, r) => row.forEach((v, c) => { if (!v) empty.push([r, c]); }));
    if (!empty.length) return;
    const [r, c] = empty[Math.floor(Math.random() * empty.length)];
    grid[r][c] = Math.random() < 0.9 ? 2 : 4;
  }
  function render() {
    grid.forEach((row, r) => row.forEach((v, c) => {
      const el = cells[r * 4 + c];
      el.textContent = v || '';
      el.dataset.v = v > 2048 ? 'max' : v;
    }));
    status(`Reach ${target} to win · score ${score}`);
  }
  function slideRow(row) {
    const vals = row.filter(Boolean);
    const out = [];
    let moved = false;
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] === vals[i + 1]) { out.push(vals[i] * 2); score += vals[i] * 2; i++; }
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
    grid = g;
    addTile();
    render();
    if (grid.flat().some((v) => v >= target)) { over = true; return finish(true, score); }
    const stuck = !grid.flat().includes(0) &&
      !grid.some((row, r) => row.some((v, c) =>
        (c < 3 && v === grid[r][c + 1]) || (r < 3 && v === grid[r + 1][c])));
    if (stuck) { over = true; finish(false, score); }
  }
  const cleanupInput = directionInput(mount, move);
  addTile(); addTile(); render();
  return () => cleanupInput();
};

// ---- 5. Sudoku ----
GAME_IMPL.sudoku = (mount, diff, finish, status) => {
  // Valid full grid from a shuffled base pattern.
  const digits = shuffleArr([1,2,3,4,5,6,7,8,9]);
  const seq = () => shuffleArr([0,1,2]);
  const rows = seq().flatMap((b) => seq().map((r) => b * 3 + r));
  const cols = seq().flatMap((b) => seq().map((c) => b * 3 + c));
  const pattern = (r, c) => (3 * (r % 3) + Math.floor(r / 3) + c) % 9;
  const solved = rows.map((r) => cols.map((c) => digits[pattern(r, c)]));
  const blanks = diff === 'hard' ? 48 : 34;
  const puzzle = solved.map((row) => row.slice());
  shuffleArr(Array.from({ length: 81 }, (_, i) => i)).slice(0, blanks)
    .forEach((i) => (puzzle[Math.floor(i / 9)][i % 9] = 0));

  const board = makeGrid(mount, 9, 'sudoku');
  let selected = null;
  const cellEls = [];
  puzzle.forEach((row, r) => row.forEach((v, c) => {
    const el = document.createElement('button');
    el.className = 'cell s-cell' + (v ? ' given' : '');
    el.textContent = v || '';
    if ((c + 1) % 3 === 0 && c < 8) el.classList.add('bx');
    if ((r + 1) % 3 === 0 && r < 8) el.classList.add('by');
    if (!v) el.addEventListener('click', () => {
      cellEls.forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      selected = { r, c, el };
    });
    board.appendChild(el);
    cellEls.push(el);
  }));
  const pad = document.createElement('div');
  pad.className = 'numpad';
  for (let n = 1; n <= 9; n++) {
    const b = document.createElement('button');
    b.textContent = n;
    b.addEventListener('click', () => enter(n));
    pad.appendChild(b);
  }
  const erase = document.createElement('button');
  erase.textContent = '⌫';
  erase.addEventListener('click', () => enter(0));
  pad.appendChild(erase);
  mount.appendChild(pad);
  status('Tap a cell, then a number.');
  function valid() {
    const seen = (cells) => {
      const s = new Set(cells);
      return s.size === 9 && !s.has(0);
    };
    for (let i = 0; i < 9; i++) {
      if (!seen(puzzle[i])) return false;
      if (!seen(puzzle.map((row) => row[i]))) return false;
      const br = Math.floor(i / 3) * 3, bc = (i % 3) * 3;
      const box = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) box.push(puzzle[br + r][bc + c]);
      if (!seen(box)) return false;
    }
    return true;
  }
  function enter(n) {
    if (!selected) return;
    puzzle[selected.r][selected.c] = n;
    selected.el.textContent = n || '';
    const remaining = puzzle.flat().filter((v) => !v).length;
    status(remaining ? `${remaining} cells left` : 'Checking…');
    if (!remaining) {
      if (valid()) finish(true, blanks);
      else status('Board full but not valid — check for duplicates.');
    }
  }
  return () => {};
};

// ---- 6. Mine Hunt ----
GAME_IMPL.minehunt = (mount, diff, finish, status) => {
  const N = diff === 'hard' ? 10 : 8;
  const mines = diff === 'hard' ? 18 : 9;
  const board = makeGrid(mount, N, 'mines');
  const isMine = new Set(shuffleArr(Array.from({ length: N * N }, (_, i) => i)).slice(0, mines));
  const revealed = new Set(), flagged = new Set();
  let flagMode = false, over = false;
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
  function reveal(i) {
    if (revealed.has(i) || flagged.has(i) || over) return;
    revealed.add(i);
    const el = cells[i];
    el.classList.add('open');
    if (isMine.has(i)) {
      el.textContent = '◆'; el.classList.add('boom');
      over = true;
      isMine.forEach((m) => { cells[m].textContent = '◆'; cells[m].classList.add('open', 'boom'); });
      return finish(false, revealed.size);
    }
    const n = count(i);
    el.textContent = n || '';
    el.dataset.n = n;
    if (!n) neighbors(i).forEach(reveal);
    if (revealed.size === N * N - mines) { over = true; finish(true, revealed.size); }
    else status(`${N * N - mines - revealed.size} safe cells left`);
  }
  for (let i = 0; i < N * N; i++) {
    const el = document.createElement('button');
    el.className = 'cell m-cell';
    el.addEventListener('click', () => {
      if (over) return;
      if (flagMode) {
        if (revealed.has(i)) return;
        if (flagged.has(i)) { flagged.delete(i); el.textContent = ''; }
        else { flagged.add(i); el.textContent = '⚑'; }
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
  status(`${N * N - mines} safe cells to clear · ${mines} mines`);
  return () => {};
};

// ---- 7. Slide Puzzle (15-puzzle) ----
GAME_IMPL.slide = (mount, diff, finish, status) => {
  const N = diff === 'hard' ? 4 : 3;
  let tiles = Array.from({ length: N * N }, (_, i) => (i + 1) % (N * N)); // 0 = blank
  // Shuffle with random valid moves so the puzzle is always solvable.
  let blank = N * N - 1;
  for (let k = 0; k < N * N * 60; k++) {
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
    status(`You ${you} · AI ${ai}`);
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
    let pick;
    if (diff === 'hard') {
      pick = opts.reduce((best, i) =>
        W[i] + flips(b, i, 2).length > W[best] + flips(b, best, 2).length ? i : best, opts[0]);
    } else pick = opts[Math.floor(Math.random() * opts.length)];
    const f = flips(b, pick, 2);
    b[pick] = 2; f.forEach((j) => (b[j] = 2));
    const yours = movesFor(b, 1);
    render(yours);
    if (!yours.length) {
      if (!movesFor(b, 2).length) return gameEnd();
      setTimeout(aiTurn, 600); // you pass
    }
  }
  function play(i) {
    const f = flips(b, i, 1);
    if (!f.length) return;
    b[i] = 1; f.forEach((j) => (b[j] = 1));
    render();
    setTimeout(aiTurn, 400);
  }
  render(movesFor(b, 1));
  return () => {};
};

// ---- 9. Pattern Recall ----
GAME_IMPL.recall = (mount, diff, finish, status) => {
  const target = diff === 'hard' ? 10 : 6;
  const speed = diff === 'hard' ? 350 : 600;
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
  const goal = diff === 'hard' ? 25 : 15;
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
