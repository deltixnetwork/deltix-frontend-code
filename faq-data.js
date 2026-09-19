'use strict';

/**
 * Deltix FAQ — single data source for the in-app FAQ tab.
 * Rendered by renderFaq() in app.js with live search + category filtering.
 * The website FAQ (deltixllc.com/faq.html) mirrors this content — when you
 * change an answer here, update the website too.
 */

window.DELTIX_FAQ = [
  {
    id: 'start',
    name: 'Getting Started',
    icon: '🚀',
    items: [
      { q: 'How do I create a Deltix account?', a: 'Download the Deltix Network app, enter your email, and confirm the one-time code we send you. Your wallet is created automatically — no seed phrases to manage.' },
      { q: 'What is the welcome bonus?', a: 'New accounts receive a small locked $DLTX welcome bonus. It counts toward your balance and staking, but it can never be transferred to another user — this protects the network from fake-account farming.' },
      { q: 'Do I need to verify my identity?', a: 'Basic play works without verification. Identity verification (KYC) unlocks the Verified badge and may be required for certain community features.' },
      { q: 'Is Deltix free to use?', a: 'Yes. Everything in Deltix is free — you never need to pay money to play, earn, or transfer.' },
    ],
  },
  {
    id: 'dltx',
    name: '$DLTX Token',
    icon: '◆',
    items: [
      { q: 'What is $DLTX?', a: '$DLTX is the Deltix Network in-app utility and reward token. It has no monetary value, is not redeemable for currency or crypto, and is not an investment. Rewards are variable incentives, never guaranteed.' },
      { q: 'How much $DLTX exists?', a: 'Deltix launched with 100,000,000 $DLTX. New supply is issued at up to 5% per year to fund staking rewards, and burns permanently remove supply from circulation.' },
      { q: 'How much $DLTX can I earn per day?', a: 'Play & Earn (arcade wins, check-in, mystery box, chest, puzzles, missions) shares a 10 $DLTX/day allowance. Deltix Earn sessions can add more on their own schedule. Staking rewards accrue separately.' },
      { q: 'Can my $DLTX be taken away?', a: 'No. Parameter changes (rates, caps, issuance) only affect future earning — $DLTX already in your wallet is never removed, except fees you explicitly pay when transferring or unstaking.' },
    ],
  },
  {
    id: 'energy',
    name: 'Energy',
    icon: '⚡',
    items: [
      { q: 'What is Energy?', a: 'Energy (⚡) is a non-monetary status point. It powers ranks, games, and boosts inside the app. It has no monetary value and can never be exchanged for $DLTX.' },
      { q: 'How do I earn Energy?', a: 'Watch rewarded ads (1 ⚡ each), climb the Daily Ladder, spin the Fortune Wheel, and collect from Deltix Rain, the Weekly Calendar, the Tree, missions, and puzzles. Free (non-ad) sources share a combined 50 ⚡ daily allowance.' },
      { q: 'What do I spend Energy on?', a: 'Instant Energy games, the Deltix Shop (avatars, themes, boosts), extra mystery boxes, unlocking bonus games, and Deltix Earn sessions.' },
      { q: 'What are Energy ranks?', a: 'Your lifetime Energy sets your rank — from Deltix Soldier upward. Ranks are cosmetic bragging rights and never affect $DLTX earnings.' },
    ],
  },
  {
    id: 'mining',
    name: 'Mining & Deltix Earn',
    icon: '⛏️',
    items: [
      { q: 'How does Deltix Earn (mining) work?', a: 'Start a session by spending 50 ⚡. The session runs for 12 hours, then you return and claim 5 $DLTX. It is a timed earn session — you don\u2019t need to keep the app open.' },
      { q: 'Do I lose my session if I close the app?', a: 'No. Sessions run on the server. Come back after 12 hours and claim — but claim before starting a new session.' },
      { q: 'Why did my claim fail?', a: 'Sessions must fully finish (12 hours) before claiming, and claims count toward daily allowances. If the network is paused for maintenance, claims resume when maintenance ends — nothing is lost.' },
    ],
  },
  {
    id: 'games',
    name: 'Games',
    icon: '🎮',
    items: [
      { q: 'Where do I find the games?', a: 'Open the Games tab — the hub lists every game: Fortune Wheel, Daily Ladder, Coin Flip, Instant Energy games, and the Deltix Arcade. Each opens on its own page.' },
      { q: 'Who decides game outcomes?', a: 'The server. Every spin, flip, and reveal is decided and paid server-side — the app only animates the result. Outcomes can\u2019t be forged, replayed, or manipulated from a device.' },
      { q: 'What is the Deltix Arcade?', a: 'Skill-based mini games where wins pay small $DLTX amounts within the shared daily allowance.' },
      { q: 'What are Instant Energy games?', a: 'One-tap games (scratch cards, boxes, dice, and more) that cost Energy to play and instantly reveal an Energy prize.' },
    ],
  },
  {
    id: 'ladder',
    name: 'Daily Ladder',
    icon: '🪜',
    items: [
      { q: 'How does the Daily Ladder work?', a: '15 steps per day, claimed strictly in order. Steps 1–9 and 11–14 pay 1 ⚡ each; the starred bonus steps 10 and 15 pay 5 ⚡ each — up to 23 ⚡ per day.' },
      { q: 'Can I skip steps or claim twice?', a: 'No. The server enforces the order, blocks repeat claims, and resets the ladder daily at UTC midnight.' },
      { q: 'Do ladder steps need ads?', a: 'Step 1 is free every day. Later steps offer an optional rewarded ad — ads are never required to receive rewards you\u2019ve already earned.' },
    ],
  },
  {
    id: 'wheel',
    name: 'Fortune Wheel',
    icon: '🎡',
    items: [
      { q: 'How does the Fortune Wheel work?', a: 'You get a free spin every 12 hours. The winnable segments pay 2 ⚡, 5 ⚡, or 8 ⚡. The spin outcome is decided by the server before the wheel animates.' },
      { q: 'What is the locked 5 $DLTX segment?', a: 'It\u2019s a jackpot preview — clearly marked with a 🔒 and not winnable yet. It will be unlocked in a future update. The wheel never pretends it\u2019s in play: locked segments are display-only.' },
      { q: 'What is the paid spin?', a: 'An optional extra spin for 1 $DLTX. Paid-spin wagers recycle through the community rewards pool — they are never burned or kept.' },
    ],
  },
  {
    id: 'coin',
    name: 'Coin Flip',
    icon: '🪙',
    items: [
      { q: 'How does Coin Flip work?', a: 'Each flip costs 30 ⚡. The only possible outcomes are 25 ⚡, 30 ⚡, 35 ⚡ — or nothing. The result is decided server-side.' },
      { q: 'Is Coin Flip profitable?', a: 'On average, no — the expected return is less than the 30 ⚡ cost. It\u2019s a fun risk for a chance at a small profit, not an Energy generator.' },
      { q: 'It charged me but the app crashed — did I lose Energy?', a: 'No. The cost and the prize are settled in one atomic step on the server, so a crash or connection drop can never charge you without paying your result.' },
    ],
  },
  {
    id: 'ads',
    name: 'Rewarded Ads',
    icon: '📺',
    items: [
      { q: 'How much Energy does one ad give?', a: 'Exactly 1 ⚡ per successfully completed rewarded ad, up to 100 ⚡ per day.' },
      { q: 'What is 2× Energy Hour?', a: 'Once a day, at a surprise hour, ad rewards are doubled to 2 ⚡. The bonus window is set by the server — it\u2019s intentional, not a glitch.' },
      { q: 'Can I get paid twice for one ad?', a: 'No. Each ad completion is credited once — refreshing, replaying, or duplicate SDK callbacks are detected and refused, on top of a cooldown between ads.' },
      { q: 'Are ads ever required?', a: 'No reward you\u2019ve earned is ever held hostage behind an ad. Ads are always opt-in extras.' },
    ],
  },
  {
    id: 'staking',
    name: 'Staking',
    icon: '🏦',
    items: [
      { q: 'How does staking work?', a: 'Stake $DLTX to support the network and earn rewards funded by annual issuance. Rewards accrue continuously and can be claimed anytime.' },
      { q: 'Is there an unstaking fee?', a: 'Yes — unstaking burns 1% of the principal, permanently removing it from supply. This discourages rapid in-and-out cycling.' },
      { q: 'Can I stake my welcome bonus?', a: 'Yes. The locked welcome bonus can be staked — it just can\u2019t be transferred to other users.' },
    ],
  },
  {
    id: 'p2p',
    name: 'P2P Transfers',
    icon: '💸',
    items: [
      { q: 'How do I send $DLTX to another user?', a: 'Open Wallet → Send, enter the recipient\u2019s address, and confirm. Transfers are instant and sealed into the public Deltix chain.' },
      { q: 'Why is my transferable balance lower than my total balance?', a: 'Your transferable balance = total balance − locked welcome bonus. Everything you earned from games, mining, rewards, and staking is fully transferable; only the welcome bonus stays locked.' },
      { q: 'What is the transfer fee?', a: '0.1% of the amount (minimum 0.01 $DLTX), burned forever. The fee is shown before you confirm.' },
      { q: 'The app says my transfer was already submitted — why?', a: 'Duplicate protection. If a send is retried (double tap, network blip), the server refuses the duplicate so you can never accidentally pay twice.' },
    ],
  },
  {
    id: 'issuance',
    name: 'Issuance & Supply',
    icon: '📈',
    items: [
      { q: 'How is new $DLTX created?', a: 'Two ways: annual issuance (up to 5% of supply per year, funding staking rewards) and capped game/reward minting within strict daily allowances.' },
      { q: 'Is the 5% issuance fixed forever?', a: 'No — it\u2019s the current protocol parameter. It can be lowered, raised, or paused through a transparent governance decision, never silently.' },
      { q: 'Who decides these numbers?', a: 'The Deltix DAO — every staked $DLTX is one vote. Issuance, fees, reward rates, and caps are explicit governance surfaces.' },
    ],
  },
  {
    id: 'burning',
    name: 'Burning',
    icon: '🔥',
    items: [
      { q: 'How does burning work?', a: 'EIP-1559-style: every P2P transfer burns a 0.1% fee (min 0.01 $DLTX), and unstaking burns 1% of principal — removed from supply forever. Net supply change = issuance − burns.' },
      { q: 'Why does the burned total look small?', a: 'Burns scale with network activity (transfers and unstaking), not with time. A young network burns little and burns more as usage grows — that\u2019s the design working, not a bug.' },
      { q: 'Can the burn rate increase?', a: 'Yes — fee rates are governance surfaces. The community can raise them through the DAO as the network matures.' },
    ],
  },
  {
    id: 'wallet',
    name: 'Wallet',
    icon: '👛',
    items: [
      { q: 'What do the wallet numbers mean?', a: 'Balance is everything you hold. Staked is what\u2019s locked in staking. Pending rewards are unclaimed staking earnings. Transferable is what you can send to others (balance minus the locked welcome bonus).' },
      { q: 'Where is my wallet stored?', a: 'Your wallet lives on the Deltix server, tied to your verified email. Losing your phone never loses your balance — sign in on a new device and it\u2019s there.' },
      { q: 'My balance shows a long decimal — is that a bug?', a: 'Balances are tracked to 8 decimal places, like most token ledgers. The app rounds for display; the ledger keeps full precision.' },
    ],
  },
  {
    id: 'security',
    name: 'Security',
    icon: '🔐',
    items: [
      { q: 'How is my account protected?', a: 'Sign-in uses one-time email codes — there\u2019s no password to steal. Never share a code with anyone; Deltix staff will never ask for it.' },
      { q: 'Can someone cheat the games?', a: 'Game outcomes, rewards, and balances are decided and enforced entirely server-side, with rate limits, daily caps, duplicate detection, and per-account serialization. A modified app can\u2019t mint rewards.' },
      { q: 'Is the ledger public?', a: 'Yes — every economic action is sealed into the public Deltix chain, which anyone can audit from the Network tab.' },
    ],
  },
  {
    id: 'rewards',
    name: 'Daily Rewards',
    icon: '🎁',
    items: [
      { q: 'What daily rewards are there?', a: 'Daily check-in (with streaks), the Mystery Box every 12 hours, the daily Chest pick, the Daily Puzzle, the Daily Challenge, Missions, and the 7-day Deltix Vault.' },
      { q: 'What happens if I miss a day?', a: 'Check-in streaks reset, but nothing is taken from you — your balance, rank, and badges are permanent.' },
      { q: 'Why did a reward say "paused"?', a: 'During maintenance the team can briefly pause reward claims to protect the economy. Nothing is lost — claims resume when the pause lifts.' },
    ],
  },
];
