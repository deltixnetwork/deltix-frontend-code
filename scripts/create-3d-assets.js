'use strict';
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'assets');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function write(filename, content) {
  fs.writeFileSync(path.join(outDir, filename), content.trim());
  console.log('Wrote', filename);
}

// 1. 3D Liquid Drop
write('icon-liquid-drop.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="dropGrad" cx="35%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="25%" stop-color="#a5d8ff"/>
      <stop offset="60%" stop-color="#339af0"/>
      <stop offset="100%" stop-color="#1864ab"/>
    </radialGradient>
    <filter id="dropGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#1864ab" flood-opacity="0.35"/>
    </filter>
  </defs>
  <path d="M50 10 C50 10 20 52 20 68 C20 84.5 33.5 95 50 95 C66.5 95 80 84.5 80 68 C80 52 50 10 50 10 Z" fill="url(#dropGrad)" filter="url(#dropGlow)"/>
  <ellipse cx="38" cy="45" rx="8" ry="14" transform="rotate(-25 38 45)" fill="#ffffff" opacity="0.65"/>
  <ellipse cx="60" cy="72" rx="4" ry="6" fill="#ffffff" opacity="0.4"/>
</svg>`);

// 2. 3D Staked Coins Stack
write('icon-staked-coins.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="goldRim" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff3bf"/>
      <stop offset="50%" stop-color="#fcc419"/>
      <stop offset="100%" stop-color="#d9480f"/>
    </linearGradient>
    <linearGradient id="goldFace" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#ffd43b"/>
      <stop offset="50%" stop-color="#ffe066"/>
      <stop offset="100%" stop-color="#fab005"/>
    </linearGradient>
    <filter id="coinShadow">
      <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#7f3800" flood-opacity="0.3"/>
    </filter>
  </defs>
  <g filter="url(#coinShadow)">
    <!-- Bottom coin -->
    <path d="M22 64 C22 56 78 56 78 64 L78 76 C78 84 22 84 22 76 Z" fill="url(#goldRim)"/>
    <ellipse cx="50" cy="64" rx="28" ry="10" fill="url(#goldFace)"/>
    <!-- Middle coin -->
    <path d="M22 46 C22 38 78 38 78 46 L78 58 C78 66 22 66 22 58 Z" fill="url(#goldRim)"/>
    <ellipse cx="50" cy="46" rx="28" ry="10" fill="url(#goldFace)"/>
    <!-- Top coin -->
    <path d="M22 28 C22 20 78 20 78 28 L78 40 C78 48 22 48 22 40 Z" fill="url(#goldRim)"/>
    <ellipse cx="50" cy="28" rx="28" ry="10" fill="url(#goldFace)"/>
    <ellipse cx="50" cy="28" rx="22" ry="7" fill="none" stroke="#f08c00" stroke-width="2"/>
    <text x="50" y="32" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="12" fill="#d9480f" text-anchor="middle">★</text>
  </g>
</svg>`);

// 3. 3D Rewards Trophy
write('icon-rewards-trophy.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="trophyGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff9db"/>
      <stop offset="35%" stop-color="#ffd43b"/>
      <stop offset="70%" stop-color="#f59f00"/>
      <stop offset="100%" stop-color="#d9480f"/>
    </linearGradient>
    <linearGradient id="trophyBase" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#862e9c"/>
      <stop offset="100%" stop-color="#4c1d95"/>
    </linearGradient>
    <filter id="trophyGlow">
      <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#f59f00" flood-opacity="0.35"/>
    </filter>
  </defs>
  <g filter="url(#trophyGlow)">
    <!-- Handles -->
    <path d="M20 28 C10 28 10 50 28 52 M80 28 C90 28 90 50 72 52" fill="none" stroke="url(#trophyGold)" stroke-width="6" stroke-linecap="round"/>
    <!-- Cup -->
    <path d="M26 18 L74 18 C74 48 60 62 50 62 C40 62 26 48 26 18 Z" fill="url(#trophyGold)"/>
    <ellipse cx="50" cy="18" rx="24" ry="6" fill="#ffe066"/>
    <!-- Stem & Base -->
    <path d="M44 62 L56 62 L54 76 L46 76 Z" fill="url(#trophyGold)"/>
    <rect x="32" y="76" width="36" height="12" rx="4" fill="url(#trophyBase)"/>
    <rect x="30" y="86" width="40" height="5" rx="2.5" fill="#fcc419"/>
    <!-- Highlight -->
    <path d="M34 24 C34 40 42 50 48 54" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
    <polygon points="50,28 53,37 62,37 55,42 57,51 50,46 43,51 45,42 38,37 47,37" fill="#ffffff" opacity="0.85"/>
  </g>
</svg>`);

// 4. 3D Faucet Tap
write('icon-faucet-tap.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="tapGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff3bf"/>
      <stop offset="40%" stop-color="#fcc419"/>
      <stop offset="80%" stop-color="#e67700"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <filter id="tapShadow">
      <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#843900" flood-opacity="0.25"/>
    </filter>
  </defs>
  <g filter="url(#tapShadow)">
    <!-- Mount pipe -->
    <rect x="8" y="32" width="14" height="24" rx="4" fill="url(#tapGold)"/>
    <!-- Main pipe -->
    <path d="M18 36 L55 36 C68 36 76 44 76 56 L76 68 L60 68 L60 56 C60 52 56 48 50 48 L18 48 Z" fill="url(#tapGold)"/>
    <!-- Valve top handle -->
    <ellipse cx="42" cy="18" rx="18" ry="6" fill="url(#tapGold)"/>
    <rect x="38" y="20" width="8" height="16" fill="url(#tapGold)"/>
    <!-- Spout nozzle -->
    <path d="M58 68 L78 68 L76 74 L60 74 Z" fill="url(#tapGold)"/>
    <!-- Dripping Gold Droplet -->
    <path d="M68 80 C68 80 62 88 62 91 C62 94.5 64.7 97 68 97 C71.3 97 74 94.5 74 91 C74 88 68 80 68 80 Z" fill="#ffd43b"/>
    <!-- Highlight sheen -->
    <path d="M22 40 L50 40 C56 40 64 44 64 52" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity="0.75"/>
  </g>
</svg>`);

// 5. Nav Icons (Wallet, Stake, Arcade, D-Browser, Community, Network)
write('nav-wallet.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="wallBlue" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4dabf7"/>
      <stop offset="40%" stop-color="#1c7ed6"/>
      <stop offset="100%" stop-color="#0b469e"/>
    </linearGradient>
    <filter id="wallShadow"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#0b469e" flood-opacity="0.3"/></filter>
  </defs>
  <g filter="url(#wallShadow)">
    <rect x="14" y="26" width="72" height="52" rx="12" fill="url(#wallBlue)"/>
    <path d="M14 38 C14 30 22 24 32 24 L76 24 C82 24 86 28 86 34 L14 34 Z" fill="#74c0fc" opacity="0.8"/>
    <!-- Clasp flap -->
    <path d="M56 42 L86 42 C88 42 90 44 90 47 L90 59 C90 62 88 64 86 64 L56 64 C50 64 46 59 46 53 C46 47 50 42 56 42 Z" fill="#1864ab"/>
    <circle cx="62" cy="53" r="5" fill="#ffd43b"/>
    <line x1="22" y1="38" x2="52" y2="38" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
  </g>
</svg>`);

write('nav-stake.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="nGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff3bf"/>
      <stop offset="50%" stop-color="#fcc419"/>
      <stop offset="100%" stop-color="#e67700"/>
    </linearGradient>
    <filter id="nShadow"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#7f3800" flood-opacity="0.3"/></filter>
  </defs>
  <g filter="url(#nShadow)">
    <path d="M26 60 C26 53 74 53 74 60 L74 72 C74 79 26 79 26 72 Z" fill="#d9480f"/>
    <ellipse cx="50" cy="60" rx="24" ry="8" fill="url(#nGold)"/>
    <path d="M26 44 C26 37 74 37 74 44 L74 56 C74 63 26 63 26 56 Z" fill="#e67700"/>
    <ellipse cx="50" cy="44" rx="24" ry="8" fill="url(#nGold)"/>
    <path d="M26 28 C26 21 74 21 74 28 L74 40 C74 47 26 47 26 40 Z" fill="#f08c00"/>
    <ellipse cx="50" cy="28" rx="24" ry="8" fill="url(#nGold)"/>
    <circle cx="50" cy="28" r="4" fill="#d9480f" opacity="0.6"/>
  </g>
</svg>`);

write('nav-arcade.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="padBlue" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38d9a9"/>
      <stop offset="30%" stop-color="#228be6"/>
      <stop offset="100%" stop-color="#1864ab"/>
    </linearGradient>
    <filter id="padShadow"><feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#1864ab" flood-opacity="0.35"/></filter>
  </defs>
  <g filter="url(#padShadow)">
    <path d="M24 36 C34 32 66 32 76 36 C86 40 92 68 84 80 C78 88 66 78 58 72 C54 69 46 69 42 72 C34 78 22 88 16 80 C8 68 14 40 24 36 Z" fill="url(#padBlue)"/>
    <!-- D-Pad -->
    <path d="M30 46 L36 46 L36 40 L42 40 L42 46 L48 46 L48 52 L42 52 L42 58 L36 58 L36 52 L30 52 Z" fill="#0b469e"/>
    <!-- Action buttons -->
    <circle cx="68" cy="44" r="3.5" fill="#ff6b6b"/>
    <circle cx="76" cy="50" r="3.5" fill="#ffd43b"/>
    <circle cx="68" cy="56" r="3.5" fill="#51cf66"/>
    <circle cx="60" cy="50" r="3.5" fill="#cc5de8"/>
  </g>
</svg>`);

write('nav-dbrowser.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="globeGrad" cx="35%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#91a7ff"/>
      <stop offset="40%" stop-color="#4c6ef5"/>
      <stop offset="100%" stop-color="#182b8a"/>
    </radialGradient>
    <filter id="globeShadow"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#182b8a" flood-opacity="0.35"/></filter>
  </defs>
  <g filter="url(#globeShadow)">
    <circle cx="50" cy="50" r="36" fill="url(#globeGrad)"/>
    <!-- Continents in Green -->
    <path d="M32 30 C38 26 44 28 46 36 C48 42 42 46 38 48 C34 50 30 46 26 42 C24 36 28 32 32 30 Z" fill="#51cf66"/>
    <path d="M52 38 C60 34 68 36 72 44 C74 52 68 62 60 64 C56 60 56 50 52 46 Z" fill="#40c057"/>
    <path d="M34 62 C40 58 48 62 46 72 C44 78 36 82 30 76 C28 70 30 64 34 62 Z" fill="#37b24d"/>
    <!-- Glass shine -->
    <ellipse cx="38" cy="32" rx="14" ry="7" transform="rotate(-30 38 32)" fill="#ffffff" opacity="0.5"/>
  </g>
</svg>`);

write('nav-community.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="commPurple" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#e599f7"/>
      <stop offset="40%" stop-color="#ae3ec9"/>
      <stop offset="100%" stop-color="#5c1482"/>
    </linearGradient>
    <filter id="commShadow"><feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#5c1482" flood-opacity="0.3"/></filter>
  </defs>
  <g filter="url(#commShadow)">
    <!-- Left person -->
    <circle cx="28" cy="42" r="11" fill="url(#commPurple)"/>
    <path d="M14 74 C14 62 20 56 28 56 C36 56 42 62 42 74 Z" fill="url(#commPurple)"/>
    <!-- Right person -->
    <circle cx="72" cy="42" r="11" fill="url(#commPurple)"/>
    <path d="M58 74 C58 62 64 56 72 56 C80 56 86 62 86 74 Z" fill="url(#commPurple)"/>
    <!-- Center front person -->
    <circle cx="50" cy="34" r="14" fill="#d0bfff"/>
    <circle cx="50" cy="34" r="13" fill="url(#commPurple)"/>
    <path d="M30 78 C30 63 38 54 50 54 C62 54 70 63 70 78 Z" fill="#f3d9fa"/>
    <path d="M32 78 C32 65 40 56 50 56 C60 56 68 65 68 78 Z" fill="url(#commPurple)"/>
  </g>
</svg>`);

write('nav-network.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="nodeBlue" cx="35%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#74c0fc"/>
      <stop offset="60%" stop-color="#1c7ed6"/>
      <stop offset="100%" stop-color="#0c4a9e"/>
    </radialGradient>
    <filter id="netShadow"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#0c4a9e" flood-opacity="0.3"/></filter>
  </defs>
  <g filter="url(#netShadow)">
    <line x1="50" y1="50" x2="22" y2="30" stroke="#4dabf7" stroke-width="4"/>
    <line x1="50" y1="50" x2="78" y2="30" stroke="#4dabf7" stroke-width="4"/>
    <line x1="50" y1="50" x2="82" y2="70" stroke="#4dabf7" stroke-width="4"/>
    <line x1="50" y1="50" x2="18" y2="70" stroke="#4dabf7" stroke-width="4"/>
    <line x1="50" y1="50" x2="50" y2="84" stroke="#4dabf7" stroke-width="4"/>
    <!-- Center orb -->
    <circle cx="50" cy="50" r="16" fill="url(#nodeBlue)"/>
    <!-- Outer orbs -->
    <circle cx="22" cy="30" r="10" fill="url(#nodeBlue)"/>
    <circle cx="78" cy="30" r="10" fill="url(#nodeBlue)"/>
    <circle cx="82" cy="70" r="9" fill="url(#nodeBlue)"/>
    <circle cx="18" cy="70" r="9" fill="url(#nodeBlue)"/>
    <circle cx="50" cy="84" r="8" fill="url(#nodeBlue)"/>
    <!-- Sheen -->
    <circle cx="46" cy="45" r="4" fill="#ffffff" opacity="0.75"/>
  </g>
</svg>`);

// 6. D-Browser 6 Tile 3D Icons
write('dapp-swap.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="uniHorn" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffd43b"/><stop offset="100%" stop-color="#f59f00"/>
    </linearGradient>
    <linearGradient id="uniMane" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ff8787"/><stop offset="50%" stop-color="#cc5de8"/><stop offset="100%" stop-color="#74c0fc"/>
    </linearGradient>
  </defs>
  <!-- 3D White Unicorn Head with Rainbow Mane & Golden Horn -->
  <path d="M58 10 L68 28 L52 24 Z" fill="url(#uniHorn)"/>
  <path d="M26 36 C22 48 30 76 56 78 C68 80 82 72 82 54 C82 38 68 34 54 34 Z" fill="#ffffff"/>
  <path d="M38 32 C38 18 24 38 20 54 C16 68 26 84 40 88 C32 82 30 68 38 52 Z" fill="url(#uniMane)"/>
  <circle cx="64" cy="46" r="4" fill="#1864ab"/>
  <circle cx="65" cy="45" r="1.5" fill="#ffffff"/>
  <ellipse cx="76" cy="62" rx="3" ry="2" fill="#ff8787"/>
</svg>`);

write('dapp-nfts.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="nftFrame" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff3bf"/><stop offset="50%" stop-color="#fcc419"/><stop offset="100%" stop-color="#d9480f"/>
    </linearGradient>
    <linearGradient id="nftSky" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#74c0fc"/><stop offset="100%" stop-color="#a9e34b"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="68" height="68" rx="8" fill="url(#nftFrame)"/>
  <rect x="24" y="24" width="52" height="52" rx="4" fill="url(#nftSky)"/>
  <circle cx="38" cy="38" r="6" fill="#ffd43b"/>
  <polygon points="24,68 44,46 58,60 66,52 76,68" fill="#2b8a3e"/>
  <polygon points="42,68 56,54 70,68" fill="#40c057"/>
</svg>`);

write('dapp-defi.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="ghostGlow" cx="40%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="70%" stop-color="#f8f9fa"/>
      <stop offset="100%" stop-color="#e9ecef"/>
    </radialGradient>
  </defs>
  <!-- 3D Cute Ghost with Tongue out -->
  <path d="M50 14 C30 14 20 32 20 54 C20 74 18 86 28 84 C34 82 38 88 44 84 C50 80 54 88 60 84 C66 80 70 86 76 82 C82 78 80 68 80 54 C80 32 70 14 50 14 Z" fill="url(#ghostGlow)"/>
  <ellipse cx="38" cy="40" rx="4" ry="7" fill="#212529"/>
  <ellipse cx="62" cy="40" rx="4" ry="7" fill="#212529"/>
  <circle cx="39" cy="38" r="1.5" fill="#ffffff"/>
  <circle cx="63" cy="38" r="1.5" fill="#ffffff"/>
  <!-- Smile & tongue -->
  <path d="M38 54 Q50 64 62 54 Z" fill="#212529"/>
  <path d="M46 58 C46 68 54 68 54 58 Z" fill="#ff6b6b"/>
  <!-- Cute ghost arms -->
  <path d="M20 52 C10 50 12 60 22 58" fill="url(#ghostGlow)"/>
  <path d="M80 52 C90 50 88 60 78 58" fill="url(#ghostGlow)"/>
</svg>`);

write('dapp-dao.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="boxBlue" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4dabf7"/><stop offset="100%" stop-color="#1864ab"/>
    </linearGradient>
  </defs>
  <!-- 3D Ballot Box with Ballot Check -->
  <polygon points="50,22 82,36 50,50 18,36" fill="#74c0fc"/>
  <polygon points="18,36 50,50 50,82 18,68" fill="#1c7ed6"/>
  <polygon points="82,36 50,50 50,82 82,68" fill="#1864ab"/>
  <!-- Slot -->
  <polygon points="42,34 58,40 54,42 38,36" fill="#0c4a9e"/>
  <!-- Ballot with X check -->
  <polygon points="44,12 60,18 56,36 40,30" fill="#ffffff"/>
  <text x="50" y="26" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#e03131" text-anchor="middle">✕</text>
</svg>`);

write('dapp-explorer.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="lensGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/><stop offset="40%" stop-color="#a5d8ff"/><stop offset="100%" stop-color="#339af0"/>
    </linearGradient>
    <linearGradient id="handleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#868e96"/><stop offset="100%" stop-color="#212529"/>
    </linearGradient>
  </defs>
  <!-- 3D Magnifying Glass -->
  <g transform="rotate(-15 50 50)">
    <circle cx="42" cy="42" r="26" fill="none" stroke="#adb5bd" stroke-width="8"/>
    <circle cx="42" cy="42" r="22" fill="url(#lensGrad)" opacity="0.85"/>
    <ellipse cx="34" cy="34" rx="8" ry="4" transform="rotate(-40 34 34)" fill="#ffffff" opacity="0.7"/>
    <rect x="58" y="58" width="12" height="34" rx="5" transform="rotate(45 64 75)" fill="url(#handleGrad)"/>
    <rect x="58" y="58" width="12" height="8" rx="2" transform="rotate(45 64 62)" fill="#ffd43b"/>
  </g>
</svg>`);

write('dapp-storage.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="boxKraft" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffe066"/><stop offset="50%" stop-color="#f59f00"/><stop offset="100%" stop-color="#d9480f"/>
    </linearGradient>
  </defs>
  <!-- 3D Cardboard Delivery Box -->
  <polygon points="50,18 84,34 50,50 16,34" fill="#ffd43b"/>
  <polygon points="16,34 50,50 50,82 16,66" fill="#f59f00"/>
  <polygon points="84,34 50,50 50,82 84,66" fill="#d9480f"/>
  <!-- Tape -->
  <polygon points="46,20 54,24 54,48 46,44" fill="#e9ecef" opacity="0.8"/>
  <polygon points="46,50 54,50 54,82 46,82" fill="#ced4da" opacity="0.8"/>
  <rect x="60" y="50" width="14" height="10" rx="2" fill="#ffffff" opacity="0.9"/>
  <line x1="63" y1="53" x2="71" y2="53" stroke="#495057" stroke-width="1.5"/>
  <line x1="63" y1="57" x2="69" y2="57" stroke="#495057" stroke-width="1.5"/>
</svg>`);

// 7. 3D Bank Vault / Safe & Gold Coins (Sustainability Fund)
write('art-vault-safe.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 120">
  <defs>
    <linearGradient id="vaultGold" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fff9db"/>
      <stop offset="30%" stop-color="#ffd43b"/>
      <stop offset="70%" stop-color="#f59f00"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <radialGradient id="dialGrad" cx="35%" cy="35%" r="65%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#fcc419"/>
      <stop offset="100%" stop-color="#7f3800"/>
    </radialGradient>
  </defs>
  <!-- Safe Body -->
  <rect x="20" y="15" width="80" height="85" rx="14" fill="url(#vaultGold)" stroke="#d9480f" stroke-width="2"/>
  <rect x="28" y="23" width="64" height="69" rx="10" fill="#f08c00"/>
  <!-- Vault Door Wheel -->
  <circle cx="60" cy="57" r="22" fill="url(#dialGrad)"/>
  <circle cx="60" cy="57" r="16" fill="#7f3800"/>
  <!-- Spoke Handles -->
  <line x1="60" y1="36" x2="60" y2="78" stroke="#ffd43b" stroke-width="4" stroke-linecap="round"/>
  <line x1="39" y1="57" x2="81" y2="57" stroke="#ffd43b" stroke-width="4" stroke-linecap="round"/>
  <line x1="45" y1="42" x2="75" y2="72" stroke="#ffd43b" stroke-width="4" stroke-linecap="round"/>
  <line x1="45" y1="72" x2="75" y2="42" stroke="#ffd43b" stroke-width="4" stroke-linecap="round"/>
  <circle cx="60" cy="57" r="6" fill="#ffffff"/>
  <!-- Gold Coins Stack Left -->
  <ellipse cx="22" cy="100" rx="16" ry="6" fill="#fab005"/>
  <ellipse cx="22" cy="94" rx="16" ry="6" fill="#ffd43b"/>
  <ellipse cx="22" cy="88" rx="16" ry="6" fill="#ffe066"/>
  <!-- Green Sprout -->
  <path d="M22 88 Q14 74 8 76 Q14 84 22 88 Z" fill="#51cf66"/>
  <path d="M22 88 Q28 72 36 74 Q28 82 22 88 Z" fill="#40c057"/>
  <path d="M22 88 L22 76" stroke="#2b8a3e" stroke-width="2" stroke-linecap="round"/>
  <!-- Gold Coins Stack Right -->
  <ellipse cx="106" cy="100" rx="16" ry="6" fill="#fab005"/>
  <ellipse cx="106" cy="94" rx="16" ry="6" fill="#ffd43b"/>
</svg>`);

// 8. 3D Illustrated Staking Banner (Boy, Girl, Treasure Chest, Joy wands, Confetti)
write('art-staking-banner.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 240">
  <defs>
    <linearGradient id="bgGlow" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#fff9db"/>
      <stop offset="60%" stop-color="#fff3bf"/>
      <stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>
    <radialGradient id="sparkleGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffe066" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="240" fill="url(#bgGlow)"/>
  <!-- Burst Sparkles -->
  <circle cx="300" cy="90" r="110" fill="url(#sparkleGlow)"/>
  <!-- Confetti particles -->
  <circle cx="120" cy="50" r="5" fill="#ff6b6b"/>
  <circle cx="480" cy="40" r="6" fill="#339af0"/>
  <circle cx="210" cy="30" r="4" fill="#51cf66"/>
  <circle cx="390" cy="35" r="5" fill="#fcc419"/>
  <polygon points="170,70 178,78 170,86 162,78" fill="#cc5de8"/>
  <polygon points="430,70 438,78 430,86 422,78" fill="#ff922b"/>

  <!-- Left Boy in Blue Hoodie -->
  <g transform="translate(60, 40)">
    <!-- Face -->
    <ellipse cx="60" cy="65" rx="36" ry="38" fill="#ffd8a8"/>
    <!-- Brown Spiky Hair -->
    <path d="M22 60 C18 20 40 10 60 10 C80 10 102 20 98 60 C90 35 75 30 60 30 C45 30 30 35 22 60 Z" fill="#5c3c10"/>
    <path d="M40 15 L50 2 L56 16 L66 4 L72 18" fill="#5c3c10"/>
    <!-- Eyes -->
    <ellipse cx="48" cy="62" rx="5" ry="7" fill="#2b1a04"/>
    <ellipse cx="72" cy="62" rx="5" ry="7" fill="#2b1a04"/>
    <circle cx="50" cy="60" r="2" fill="#ffffff"/>
    <circle cx="74" cy="60" r="2" fill="#ffffff"/>
    <!-- Cute Blush & Smile -->
    <ellipse cx="40" cy="74" rx="6" ry="3" fill="#ff8787" opacity="0.6"/>
    <ellipse cx="80" cy="74" rx="6" ry="3" fill="#ff8787" opacity="0.6"/>
    <path d="M52 76 Q60 84 68 76" fill="none" stroke="#2b1a04" stroke-width="2.5" stroke-linecap="round"/>
    <!-- Blue Hoodie Body -->
    <path d="M26 102 C26 90 40 86 60 86 C80 86 94 90 94 102 L100 170 L20 170 Z" fill="#1c7ed6"/>
    <path d="M48 94 L60 110 L72 94" fill="#339af0"/>
    <!-- Gift Box Held in Left Hand -->
    <rect x="0" y="110" width="36" height="36" rx="6" fill="#339af0"/>
    <rect x="0" y="124" width="36" height="8" fill="#ffd43b"/>
    <rect x="14" y="110" width="8" height="36" fill="#ffd43b"/>
    <!-- Joy Wand in Right Hand -->
    <line x1="94" y1="110" x2="114" y2="70" stroke="#ffd43b" stroke-width="4" stroke-linecap="round"/>
    <circle cx="114" cy="70" r="14" fill="#fab005"/>
    <text x="114" y="74" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="9" fill="#5c3c10" text-anchor="middle">JOY</text>
  </g>

  <!-- Center Overflowing Gold Treasure Chest -->
  <g transform="translate(210, 45)">
    <!-- Chest Base -->
    <rect x="25" y="80" width="130" height="75" rx="14" fill="#c92a2a" stroke="#fab005" stroke-width="5"/>
    <rect x="25" y="80" width="130" height="15" fill="#fab005"/>
    <rect x="80" y="95" width="20" height="26" rx="4" fill="#fab005"/>
    <circle cx="90" cy="105" r="4" fill="#212529"/>
    <!-- Open Curved Lid Behind -->
    <path d="M20 70 C20 30 160 30 160 70 L150 78 L30 78 Z" fill="#e03131" stroke="#fab005" stroke-width="5"/>
    <!-- Overflowing Gold Coins & Gems -->
    <ellipse cx="90" cy="68" rx="55" ry="22" fill="#ffd43b"/>
    <circle cx="60" cy="62" r="9" fill="#ffe066" stroke="#f08c00" stroke-width="2"/>
    <circle cx="80" cy="55" r="10" fill="#ffd43b" stroke="#f08c00" stroke-width="2"/>
    <circle cx="102" cy="58" r="9" fill="#ffe066" stroke="#f08c00" stroke-width="2"/>
    <circle cx="120" cy="65" r="8" fill="#fab005" stroke="#f08c00" stroke-width="2"/>
    <!-- Rubies & Sapphires -->
    <polygon points="70,50 78,56 74,66 66,66 62,56" fill="#e03131"/>
    <polygon points="95,45 104,52 100,62 90,62 86,52" fill="#1c7ed6"/>
    <polygon points="112,48 118,54 114,62 106,62 104,54" fill="#ae3ec9"/>
  </g>

  <!-- Right Girl in Pink Hoodie -->
  <g transform="translate(420, 40)">
    <!-- Face -->
    <ellipse cx="60" cy="65" rx="36" ry="38" fill="#ffd8a8"/>
    <!-- Long Brown Hair with Pink Bow -->
    <path d="M20 50 C18 15 40 8 60 8 C80 8 102 15 100 50 C106 75 106 120 96 140 C84 105 82 40 60 30 C38 40 36 105 24 140 C14 120 14 75 20 50 Z" fill="#5c3c10"/>
    <!-- Pink Bow on Head -->
    <polygon points="86,22 98,12 98,32" fill="#f06595"/>
    <polygon points="86,22 74,12 74,32" fill="#f06595"/>
    <circle cx="86" cy="22" r="4" fill="#d6336c"/>
    <!-- Eyes -->
    <ellipse cx="48" cy="62" rx="5" ry="7" fill="#2b1a04"/>
    <ellipse cx="72" cy="62" rx="5" ry="7" fill="#2b1a04"/>
    <circle cx="50" cy="60" r="2" fill="#ffffff"/>
    <circle cx="74" cy="60" r="2" fill="#ffffff"/>
    <!-- Cute Blush & Smile -->
    <ellipse cx="40" cy="74" rx="6" ry="3" fill="#ff8787" opacity="0.6"/>
    <ellipse cx="80" cy="74" rx="6" ry="3" fill="#ff8787" opacity="0.6"/>
    <path d="M52 76 Q60 84 68 76" fill="none" stroke="#2b1a04" stroke-width="2.5" stroke-linecap="round"/>
    <!-- Pink Hoodie Body -->
    <path d="M26 102 C26 90 40 86 60 86 C80 86 94 90 94 102 L100 170 L20 170 Z" fill="#e64980"/>
    <path d="M48 94 L60 110 L72 94" fill="#f783ac"/>
    <!-- Gift Box Held in Right Hand -->
    <rect x="84" y="110" width="36" height="36" rx="6" fill="#845ef7"/>
    <rect x="84" y="124" width="36" height="8" fill="#ffd43b"/>
    <rect x="98" y="110" width="8" height="36" fill="#ffd43b"/>
    <!-- Joy Wand in Left Hand -->
    <line x1="26" y1="110" x2="6" y2="70" stroke="#ffd43b" stroke-width="4" stroke-linecap="round"/>
    <circle cx="6" cy="70" r="14" fill="#fab005"/>
    <text x="6" y="74" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="9" fill="#5c3c10" text-anchor="middle">JOY</text>
  </g>
</svg>`);

// 9. 3D Illustrated Arcade Banner (Gamer Boy, Gamer Girl with Controllers, Trophy, Gold Chest)
write('art-arcade-banner.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 240">
  <defs>
    <linearGradient id="arcBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#e7f5ff"/>
      <stop offset="60%" stop-color="#d0ebff"/>
      <stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>
  </defs>
  <rect width="600" height="240" fill="url(#arcBg)"/>
  <!-- Sparkles & Confetti -->
  <circle cx="300" cy="80" r="120" fill="#ffd43b" opacity="0.2"/>
  <circle cx="100" cy="35" r="6" fill="#ff6b6b"/>
  <circle cx="500" cy="45" r="5" fill="#51cf66"/>
  <circle cx="280" cy="25" r="5" fill="#845ef7"/>
  <circle cx="340" cy="20" r="6" fill="#fcc419"/>

  <!-- Gamer Boy with Video Game Controller -->
  <g transform="translate(50, 30)">
    <!-- Face -->
    <ellipse cx="65" cy="65" rx="38" ry="40" fill="#ffd8a8"/>
    <!-- Hair -->
    <path d="M25 60 C20 15 45 8 65 8 C85 8 110 15 105 60 C95 32 80 26 65 26 C50 26 35 32 25 60 Z" fill="#422800"/>
    <!-- Eyes -->
    <ellipse cx="52" cy="62" rx="6" ry="8" fill="#2b1a04"/>
    <ellipse cx="78" cy="62" rx="6" ry="8" fill="#2b1a04"/>
    <circle cx="54" cy="59" r="2.5" fill="#ffffff"/>
    <circle cx="80" cy="59" r="2.5" fill="#ffffff"/>
    <!-- Smile & Blush -->
    <ellipse cx="44" cy="74" rx="6" ry="3" fill="#ff8787" opacity="0.6"/>
    <ellipse cx="86" cy="74" rx="6" ry="3" fill="#ff8787" opacity="0.6"/>
    <path d="M56 76 Q65 86 74 76" fill="none" stroke="#2b1a04" stroke-width="3" stroke-linecap="round"/>
    <!-- Blue Hoodie -->
    <path d="M30 105 C30 92 45 88 65 88 C85 88 100 92 100 105 L105 180 L25 180 Z" fill="#1864ab"/>
    <!-- Video Game Controller held in both hands -->
    <rect x="42" y="118" width="46" height="26" rx="8" fill="#212529"/>
    <circle cx="52" cy="131" r="5" fill="#495057"/>
    <circle cx="78" cy="127" r="3" fill="#ff6b6b"/>
    <circle cx="72" cy="133" r="3" fill="#51cf66"/>
  </g>

  <!-- Center Gold Treasure Chest & Deltix Gold Trophy -->
  <g transform="translate(205, 45)">
    <!-- Chest -->
    <rect x="25" y="75" width="120" height="70" rx="12" fill="#c92a2a" stroke="#fab005" stroke-width="4"/>
    <rect x="25" y="75" width="120" height="14" fill="#fab005"/>
    <ellipse cx="85" cy="64" rx="50" ry="18" fill="#ffd43b"/>
    <circle cx="65" cy="58" r="8" fill="#ffe066" stroke="#f08c00" stroke-width="2"/>
    <circle cx="85" cy="52" r="9" fill="#ffd43b" stroke="#f08c00" stroke-width="2"/>
    <circle cx="105" cy="56" r="8" fill="#ffe066" stroke="#f08c00" stroke-width="2"/>
    <!-- Trophy with D logo -->
    <g transform="translate(130, 40)">
      <path d="M12 10 L48 10 C48 34 38 44 30 44 C22 44 12 34 12 10 Z" fill="#fcc419" stroke="#d9480f" stroke-width="2"/>
      <path d="M6 16 C0 16 0 32 14 34 M54 16 C60 16 60 32 46 34" fill="none" stroke="#fcc419" stroke-width="4"/>
      <rect x="24" y="44" width="12" height="12" fill="#f59f00"/>
      <rect x="16" y="56" width="28" height="10" rx="3" fill="#495057"/>
      <text x="30" y="32" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="14" fill="#1864ab" text-anchor="middle">D</text>
    </g>
  </g>

  <!-- Gamer Girl with Video Game Controller -->
  <g transform="translate(425, 30)">
    <!-- Face -->
    <ellipse cx="65" cy="65" rx="38" ry="40" fill="#ffd8a8"/>
    <!-- Long Hair & Pink Bow -->
    <path d="M22 50 C20 15 45 8 65 8 C85 8 110 15 108 50 C114 75 114 120 104 140 C90 105 88 40 65 30 C42 40 40 105 26 140 C16 120 16 75 22 50 Z" fill="#422800"/>
    <polygon points="90,20 102,10 102,30" fill="#f06595"/>
    <polygon points="90,20 78,10 78,30" fill="#f06595"/>
    <circle cx="90" cy="20" r="4" fill="#c2255c"/>
    <!-- Eyes -->
    <ellipse cx="52" cy="62" rx="6" ry="8" fill="#2b1a04"/>
    <ellipse cx="78" cy="62" rx="6" ry="8" fill="#2b1a04"/>
    <circle cx="54" cy="59" r="2.5" fill="#ffffff"/>
    <circle cx="80" cy="59" r="2.5" fill="#ffffff"/>
    <!-- Smile & Blush -->
    <ellipse cx="44" cy="74" rx="6" ry="3" fill="#ff8787" opacity="0.6"/>
    <ellipse cx="86" cy="74" rx="6" ry="3" fill="#ff8787" opacity="0.6"/>
    <path d="M56 76 Q65 86 74 76" fill="none" stroke="#2b1a04" stroke-width="3" stroke-linecap="round"/>
    <!-- Pink Hoodie -->
    <path d="M30 105 C30 92 45 88 65 88 C85 88 100 92 100 105 L105 180 L25 180 Z" fill="#d6336c"/>
    <!-- Video Game Controller held in both hands -->
    <rect x="42" y="118" width="46" height="26" rx="8" fill="#212529"/>
    <circle cx="52" cy="131" r="5" fill="#495057"/>
    <circle cx="78" cy="127" r="3" fill="#ff6b6b"/>
    <circle cx="72" cy="133" r="3" fill="#51cf66"/>
  </g>
</svg>`);

// 10. 3D Game Card Icons (TicTacToe Robot, Memory Diamonds, Snake, Merge 2048, Sudoku, MineHunt)
write('game-tictactoe.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="botHead" cx="35%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#e9ecef"/><stop offset="70%" stop-color="#ced4da"/><stop offset="100%" stop-color="#495057"/>
    </radialGradient>
  </defs>
  <!-- Cute 3D Robot Head & Neon Grid -->
  <rect x="8" y="16" width="36" height="36" rx="4" fill="#3b156b" stroke="#da77f2" stroke-width="2"/>
  <line x1="20" y1="16" x2="20" y2="52" stroke="#da77f2" stroke-width="1.5"/>
  <line x1="32" y1="16" x2="32" y2="52" stroke="#da77f2" stroke-width="1.5"/>
  <line x1="8" y1="28" x2="44" y2="28" stroke="#da77f2" stroke-width="1.5"/>
  <line x1="8" y1="40" x2="44" y2="40" stroke="#da77f2" stroke-width="1.5"/>
  <text x="14" y="26" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="10" fill="#38d9a9">✕</text>
  <circle cx="26" cy="34" r="3.5" fill="none" stroke="#ff6b6b" stroke-width="1.5"/>
  <text x="38" y="50" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="10" fill="#38d9a9">✕</text>

  <!-- Robot on Right -->
  <rect x="48" y="24" width="44" height="40" rx="14" fill="url(#botHead)"/>
  <rect x="54" y="30" width="32" height="20" rx="8" fill="#181a20"/>
  <ellipse cx="62" cy="40" rx="4" ry="5" fill="#38d9a9"/>
  <ellipse cx="78" cy="40" rx="4" ry="5" fill="#38d9a9"/>
  <!-- Ears -->
  <rect x="44" y="36" width="4" height="12" rx="2" fill="#74c0fc"/>
  <rect x="92" y="36" width="4" height="12" rx="2" fill="#74c0fc"/>
  <!-- Antenna -->
  <line x1="70" y1="24" x2="70" y2="14" stroke="#ced4da" stroke-width="3"/>
  <circle cx="70" cy="12" r="4" fill="#38d9a9"/>
</svg>`);

write('game-memory.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="diaBlue" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#74c0fc"/><stop offset="50%" stop-color="#1c7ed6"/><stop offset="100%" stop-color="#0b469e"/>
    </linearGradient>
  </defs>
  <!-- 3 Floating Glossy Blue Diamond Tiles with Diamond Emblem -->
  <g transform="translate(10, 20) rotate(-15 20 20)">
    <rect x="0" y="0" width="30" height="30" rx="8" fill="url(#diaBlue)" stroke="#ffffff" stroke-width="2"/>
    <polygon points="15,6 24,15 15,24 6,15" fill="#ffffff"/>
  </g>
  <g transform="translate(36, 12)">
    <rect x="0" y="0" width="32" height="32" rx="8" fill="url(#diaBlue)" stroke="#ffffff" stroke-width="2.5"/>
    <polygon points="16,6 26,16 16,26 6,16" fill="#ffffff"/>
  </g>
  <g transform="translate(62, 22) rotate(15 20 20)">
    <rect x="0" y="0" width="30" height="30" rx="8" fill="url(#diaBlue)" stroke="#ffffff" stroke-width="2"/>
    <polygon points="15,6 24,15 15,24 6,15" fill="#ffffff"/>
  </g>
</svg>`);

write('game-snake.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="snkHead" cx="35%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#a9e34b"/><stop offset="60%" stop-color="#40c057"/><stop offset="100%" stop-color="#2b8a3e"/>
    </radialGradient>
  </defs>
  <!-- Cute Emerald 3D Cartoon Snake with Coins -->
  <!-- Body S-Curves -->
  <path d="M20 74 Q32 86 48 76 Q64 64 64 48 Q64 34 50 26 Q36 20 34 36 Q32 50 48 58 Q66 66 84 60" fill="none" stroke="url(#snkHead)" stroke-width="14" stroke-linecap="round"/>
  <!-- Head -->
  <circle cx="34" cy="30" r="16" fill="url(#snkHead)"/>
  <ellipse cx="28" cy="24" rx="4" ry="5" fill="#ffffff"/>
  <ellipse cx="40" cy="24" rx="4" ry="5" fill="#ffffff"/>
  <circle cx="29" cy="24" r="2.5" fill="#212529"/>
  <circle cx="41" cy="24" r="2.5" fill="#212529"/>
  <path d="M28 34 Q34 40 40 34" fill="none" stroke="#212529" stroke-width="2" stroke-linecap="round"/>
  <!-- Gold Coins Floating -->
  <circle cx="78" cy="24" r="8" fill="#ffd43b" stroke="#f08c00" stroke-width="2"/>
  <circle cx="82" cy="74" r="6" fill="#ffd43b" stroke="#f08c00" stroke-width="1.5"/>
</svg>`);

write('game-2048.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- 3D Numbered Cubes 2, 4, 8, 16, 32, 64 -->
  <g transform="translate(8, 12)">
    <rect x="0" y="0" width="26" height="26" rx="6" fill="#fff3bf" stroke="#ffd43b" stroke-width="2"/>
    <text x="13" y="18" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="14" fill="#e67700" text-anchor="middle">2</text>
  </g>
  <g transform="translate(37, 12)">
    <rect x="0" y="0" width="26" height="26" rx="6" fill="#ffe066" stroke="#fcc419" stroke-width="2"/>
    <text x="13" y="18" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="14" fill="#d9480f" text-anchor="middle">4</text>
  </g>
  <g transform="translate(66, 12)">
    <rect x="0" y="0" width="26" height="26" rx="6" fill="#ff922b" stroke="#f76707" stroke-width="2"/>
    <text x="13" y="18" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="14" fill="#ffffff" text-anchor="middle">8</text>
  </g>
  <g transform="translate(8, 44)">
    <rect x="0" y="0" width="26" height="26" rx="6" fill="#845ef7" stroke="#7048e8" stroke-width="2"/>
    <text x="13" y="17" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#ffffff" text-anchor="middle">16</text>
  </g>
  <g transform="translate(37, 44)">
    <rect x="0" y="0" width="26" height="26" rx="6" fill="#339af0" stroke="#1c7ed6" stroke-width="2"/>
    <text x="13" y="17" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#ffffff" text-anchor="middle">32</text>
  </g>
  <g transform="translate(66, 44)">
    <rect x="0" y="0" width="26" height="26" rx="6" fill="#e03131" stroke="#c92a2a" stroke-width="2"/>
    <text x="13" y="17" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#ffffff" text-anchor="middle">64</text>
  </g>
</svg>`);

write('game-sudoku.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- Sudoku Number Grid + 3D Pencil -->
  <rect x="8" y="16" width="56" height="56" rx="8" fill="#1c7ed6" stroke="#ffffff" stroke-width="2"/>
  <rect x="12" y="20" width="14" height="14" rx="3" fill="#ffffff"/>
  <text x="19" y="31" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#1864ab" text-anchor="middle">5</text>
  <rect x="29" y="20" width="14" height="14" rx="3" fill="#ffffff"/>
  <text x="36" y="31" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#1864ab" text-anchor="middle">3</text>
  <rect x="46" y="20" width="14" height="14" rx="3" fill="#ffffff"/>
  <text x="53" y="31" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#1864ab" text-anchor="middle">8</text>

  <rect x="12" y="37" width="14" height="14" rx="3" fill="#ffffff"/>
  <text x="19" y="48" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#1864ab" text-anchor="middle">6</text>
  <rect x="29" y="37" width="14" height="14" rx="3" fill="#ffffff"/>
  <text x="36" y="48" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#1864ab" text-anchor="middle">1</text>
  <rect x="46" y="37" width="14" height="14" rx="3" fill="#ffffff"/>
  <text x="53" y="48" font-family="'Segoe UI',sans-serif" font-weight="900" font-size="11" fill="#1864ab" text-anchor="middle">9</text>

  <!-- 3D Pencil on Right -->
  <g transform="translate(60, 20) rotate(40)">
    <polygon points="6,0 16,0 16,50 6,50" fill="#fcc419"/>
    <polygon points="6,0 16,0 11,-12" fill="#ffd8a8"/>
    <polygon points="9,-8 13,-8 11,-12" fill="#212529"/>
    <rect x="6" y="50" width="10" height="10" rx="3" fill="#ff8787"/>
    <rect x="6" y="46" width="10" height="4" fill="#ced4da"/>
  </g>
</svg>`);

write('game-minehunt.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="bombGrad" cx="35%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#495057"/><stop offset="60%" stop-color="#212529"/><stop offset="100%" stop-color="#000000"/>
    </radialGradient>
  </defs>
  <!-- Minefield grid with yellow flags + 3D Bomb -->
  <rect x="8" y="30" width="50" height="48" rx="6" fill="#862e9c" stroke="#f06595" stroke-width="1.5"/>
  <!-- Yellow Flags -->
  <path d="M18 42 L28 36 L18 32 Z" fill="#ffd43b"/>
  <line x1="18" y1="32" x2="18" y2="48" stroke="#ffffff" stroke-width="2"/>
  <path d="M38 56 L48 50 L38 46 Z" fill="#ffd43b"/>
  <line x1="38" y1="46" x2="38" y2="62" stroke="#ffffff" stroke-width="2"/>

  <!-- 3D Bomb -->
  <circle cx="70" cy="58" r="20" fill="url(#bombGrad)"/>
  <ellipse cx="64" cy="50" rx="5" ry="3" transform="rotate(-30 64 50)" fill="#ffffff" opacity="0.6"/>
  <rect x="66" y="34" width="8" height="6" rx="2" fill="#ced4da"/>
  <!-- Fuse & Spark -->
  <path d="M70 34 Q76 22 84 20" fill="none" stroke="#f59f00" stroke-width="3" stroke-linecap="round"/>
  <!-- Spark Star -->
  <polygon points="84,20 86,12 89,19 97,19 91,24 93,31 86,27 80,30 83,23 76,19 83,19" fill="#ff6b6b"/>
  <circle cx="85" cy="20" r="3" fill="#ffd43b"/>
</svg>`);

// 11. 3D Shields for Staking (Blue, Green, Orange, Purple, Red)
const shields = [
  { name: 'shield-blue.svg', c1: '#74c0fc', c2: '#1c7ed6', c3: '#0b469e' },
  { name: 'shield-green.svg', c1: '#8ce99a', c2: '#37b24d', c3: '#1b642a' },
  { name: 'shield-orange.svg', c1: '#ffd43b', c2: '#f76707', c3: '#9c3600' },
  { name: 'shield-purple.svg', c1: '#e599f7', c2: '#ae3ec9', c3: '#5c1482' },
  { name: 'shield-red.svg', c1: '#ffa8a8', c2: '#e03131', c3: '#870000' }
];

shields.forEach(s => {
  write(s.name, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g_${s.name}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${s.c1}"/>
      <stop offset="50%" stop-color="${s.c2}"/>
      <stop offset="100%" stop-color="${s.c3}"/>
    </linearGradient>
    <filter id="sh_${s.name}"><feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="${s.c3}" flood-opacity="0.35"/></filter>
  </defs>
  <g filter="url(#sh_${s.name})">
    <path d="M50 10 C74 10 86 16 86 42 C86 68 50 90 50 90 C50 90 14 68 14 42 C14 16 26 10 50 10 Z" fill="url(#g_${s.name})" stroke="#ffffff" stroke-width="4"/>
    <path d="M50 18 C70 18 78 22 78 44 C78 64 50 82 50 82 C50 82 22 64 22 44 C22 22 30 18 50 18 Z" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.6"/>
    <!-- Center Star -->
    <polygon points="50,28 54,40 66,40 56,47 60,59 50,52 40,59 44,47 34,40 46,40" fill="#ffffff"/>
  </g>
</svg>`);
});

// 12. 3D Casino Chips / Token Stack
write('chips-stack.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
  <defs>
    <linearGradient id="chipBlue" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#74c0fc"/><stop offset="100%" stop-color="#1864ab"/>
    </linearGradient>
  </defs>
  <!-- Stack of 4 Poker/Casino Chips -->
  <g transform="translate(10, 8)">
    <path d="M6 46 C6 40 54 40 54 46 L54 54 C54 60 6 60 6 54 Z" fill="#0b469e"/>
    <ellipse cx="30" cy="46" rx="24" ry="7" fill="url(#chipBlue)"/>
    <path d="M6 34 C6 28 54 28 54 34 L54 42 C54 48 6 48 6 42 Z" fill="#0b469e"/>
    <ellipse cx="30" cy="34" rx="24" ry="7" fill="url(#chipBlue)"/>
    <path d="M6 22 C6 16 54 16 54 22 L54 30 C54 36 6 36 6 30 Z" fill="#0b469e"/>
    <ellipse cx="30" cy="22" rx="24" ry="7" fill="url(#chipBlue)"/>
    <path d="M6 10 C6 4 54 4 54 10 L54 18 C54 24 6 24 6 18 Z" fill="#0b469e"/>
    <ellipse cx="30" cy="10" rx="24" ry="7" fill="url(#chipBlue)"/>
    <ellipse cx="30" cy="10" rx="16" ry="4.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-dasharray="4 3"/>
  </g>
</svg>`);

console.log('All 3D vector SVG assets created successfully!');
