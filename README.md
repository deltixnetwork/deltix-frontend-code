# Deltix Network — Frontend

**The Deltix Network app ($DLTX) — a mobile-first Delegated Proof-of-Stake experience.**

A dependency-free vanilla JS single-page application: wallet, staking, live DAO governance,
P2P transfers with fee burn, referral + ambassador programs, D-Browser, and live chain/tokenomics
dashboards. Served statically by [deltix-backend-code](https://github.com/deltixnetwork/deltix-backend-code)
and packaged for stores by [deltix-Mobile-App-code](https://github.com/deltixnetwork/deltix-Mobile-App-code).

## Surfaces

| Tab | Features |
|---|---|
| **Wallet** | Balance, send/receive $DLTX (base fee burned), genesis faucet, activity history |
| **Stake** | Validator directory, delegation, rewards, unstake |
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

## Compliance Built In

18+ age gate with explicit consent · no-monetary-value disclosures · in-app account deletion ·
no mining · single-level, hard-capped referrals · risk disclosures before every delegation.

---

$DLTX is an in-app utility and reward token with no monetary value. © 2026 Deltix Network. All rights reserved.
