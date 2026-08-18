# Deltix Network — Frontend

**The Deltix Network app ($DLTX) — a mobile-first Delegated Proof-of-Stake experience.**

A dependency-free vanilla JS single-page application: wallet, staking, live DAO governance,
P2P transfers with fee burn, referral + ambassador programs, D-Browser, and live chain/tokenomics
dashboards. Served statically by [deltix-backend-code](https://github.com/deltixnetwork/deltix-backend-code)
and packaged for stores by [deltix-Mobile-App-code](https://github.com/deltixnetwork/deltix-Mobile-App-code).

## Surfaces

| Tab | Features |
|---|---|
| **Wallet** | Balance, send/receive $DLTX (base fee burned), activity history |
| **Stake** | Validator directory, delegation, rewards, unstake |
| **Arcade** | **Deltix Arcade (live)** — 10 original games (easy/hard) with daily-capped $DLTX win rewards |
| **D-Browser** | Curated, allowlisted dApp gateway with security interstitial |
| **Community** | **Deltix DAO (live)** — proposals + stake-weighted voting; referrals (max 3); ambassador tiers; account deletion |
| **Network** | **Deltix Chain (live)** — latest blocks + chain info; token supply; monetary model |

## Pages

- `index.html` — the app
- `terms.html` — Terms of Service
- `privacy.html` — Privacy Policy
- `delete-account.html` — account-deletion instructions (Google Play Data safety URL)
- `WHITEPAPER.md` — the Deltix Network whitepaper
- `assets/` — brand assets (logo, wordmark, app icon — SVG sources)

## Run

The frontend is served by the backend — no build step:

```bash
git clone https://github.com/deltixnetwork/deltix-backend-code ../deltix-backend-code
# point the backend's static dir at this folder (see backend README), then:
cd ../deltix-backend-code && npm install && npm start
# → http://localhost:4000
```

All API calls go to the same origin under `/api/...`.

## Deltix Arcade

Ten fully original implementations of classic, ownerless game concepts — Tic-Tac-Toe, Memory
Match, Delta Snake, Merge 2048, Sudoku, Mine Hunt, Slide Puzzle, Reversi, Pattern Recall, and
Reaction Rush. All code, names, and visuals are Deltix originals (no third-party assets), each
with easy/hard modes. Wins earn $DLTX utility rewards, settled server-side against a play
session with a minimum play time and a daily cap — no wagering, no entry fees.

## Compliance Built In

18+ age gate with explicit consent · no-monetary-value disclosures · in-app account deletion ·
no mining · single-level, hard-capped referrals · risk disclosures before every delegation ·
free skill games only · forced-update gate for unsupported client versions.

---

$DLTX is an in-app utility and reward token with no monetary value. © 2026 Deltix Network. All rights reserved.
