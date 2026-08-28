# Deltix Network Whitepaper

**$DLTX — A Mobile-First Delegated Proof-of-Stake Network**

Version 1.1 · Effective August 28, 2026 · Deltix Network

---

## Abstract

Deltix Network is a live, mobile-first Delegated Proof-of-Stake (DPoS) network built on Ethereum's
core economic design — staking-funded issuance and EIP-1559-style fee burning — delivered through a
custodial mobile experience so anyone with an email address can participate in under a minute, with
no seed phrase, gas management, or node operation required. On top of that Ethereum-inspired base,
Deltix adds a single-level, human-scale **referral program** and an **ambassador recognition program**,
giving it more built-in growth and community features than base-layer Ethereum offers out of the box.
$DLTX, the native token, is an in-app utility and reward token — it has no monetary value and is not
redeemable for real-world currency or any other cryptocurrency. It powers staking, transfers,
rewards, and the **Deltix DAO — live from day one** — through which the community votes on protocol
changes by stake-weighted ballot.
Deltix is a standalone network — not a subsidiary token or dependent chain — built to stand on its
own economic and technical merits.

This paper describes the network's architecture, monetary policy, staking mechanics, fee-burn model,
referral and ambassador programs, security model, governance roadmap, sustainability strategy, and a
plainly stated account of what is **delivered today** versus what remains **planned** (§13).

---

## The Deltix Story

### Why "Deltix"?

The name comes from **delta (Δ)** — the fourth letter of the Greek alphabet and one of the most
meaningful symbols in mathematics, finance, and nature:

- **In mathematics, Δ means change.** Delta is the universal symbol for difference — the measure
  of how things move from one state to another. Deltix exists to change who gets to participate
  in staking economies: not just the technically sophisticated, but anyone with a phone and an
  email address.
- **In nature, a delta is where a river meets the sea.** A river delta doesn't concentrate its
  water in one channel — it distributes it across many branches, nourishing everything it
  touches. That is precisely how Delegated Proof of Stake works: value flows from many small
  delegators through validator channels, and rewards flow back out to every participant. The
  delta is the geography of delegation.
- **In markets, delta measures sensitivity** — how much one thing responds to movement in
  another. Deltix's economy is built on the same idea of responsive balance: issuance responds
  to staking participation, burning responds to transaction volume, and the network's monetary
  state is always the sum of those flows (S<sub>t+1</sub> = S<sub>t</sub> + I<sub>t</sub> − B<sub>t</sub>).

The **"-ix"** suffix marks it as a network — a system, a matrix of participants — rather than a
single thing. Put together, **Deltix is "the network of change"**: a system built to move value,
distribute rewards, and shift staking from the server room to the pocket.

### How Deltix Began

Deltix started with a simple observation: Ethereum solved the hard problems — Proof of Stake
consensus, sustainable issuance, deflationary fee burning — but never solved the *human* problem.
A decade after staking became mainstream, participating still meant seed phrases that could be
lost forever, gas fees that made small transactions pointless, exchanges that demanded documents
before allowing a single delegation, and validator software that assumed everyone owned a server.

The result was predictable: the people with the most to gain from open financial infrastructure
were the least able to use it. Staking became a game for whales, funds, and engineers.

The founding idea behind Deltix was to keep Ethereum's proven economic engine and rebuild
everything around it for the phone:

- **If a wallet can be lost, generate and protect it for the user.** Custody with AES-256-GCM
  encryption replaced the seed phrase.
- **If validators require servers, let users delegate instead.** A curated validator set replaced
  node operation.
- **If growth programs become pyramids, keep them single-level.** A human-scale referral system —
  one sponsor per user, no downlines, rewards only for genuine staking participants — replaced
  viral recruitment schemes.
- **If communities need leaders, recognize them.** The Ambassador program rewards the people who
  grow the network responsibly, with recognition rather than recruitment income.

Deltix launched live from day one — wallet, staking, transfers, referrals, and public tokenomics
all working from the first release — because a network that asks for trust should demonstrate
function first.

The delta symbol (◆) in the app's logo is a quiet reminder of the mission: change, distributed.

---

## 1. Introduction

### 1.1 Motivation

Most staking networks demand technical sophistication: seed phrases, gas management, node operation, and exchange onboarding. This excludes the majority of potential participants. Deltix inverts the model — the network is live from day one through a mobile-first application where:

- Identity is established with **email + one-time passcode (OTP)** — no seed phrase required to begin.
- A wallet is generated automatically and its private key is encrypted at rest.
- Staking, delegation, transfers, and referrals work from the first session.

### 1.2 Design Principles

1. **Accessibility first** — one minute from download to delegation.
2. **Ethereum-inspired economics** — issuance funds security; fee burning counteracts inflation.
3. **Mobile-custodial by design** — Deltix Network generates and encrypts each wallet on the
   user's behalf; there is no self-custody seed phrase to manage on a mobile device. This is a
   deliberate accessibility trade-off, not a placeholder — it trades node-level decentralization
   for mobile-first reach.
4. **More than base Ethereum** — the referral and ambassador programs are Deltix additions with
   no Ethereum equivalent, built to grow the network human-by-human.
5. **Human-scale growth** — single-level referrals with no downlines; rewards gated on genuine staking, not headcount.
6. **DAO from day one** — the Deltix DAO is live at genesis: protocol changes are decided by
   stake-weighted community vote inside the app, and the scope of binding on-chain control expands
   in phases toward full decentralization.
7. **Standalone by design** — Deltix is a self-contained network with its own token, monetary policy, and roadmap.

### 1.3 Deltix vs. Ethereum — What Carries Over, What's Added

| Ethereum concept | Deltix implementation |
|---|---|
| Proof of Stake | Delegated PoS — delegate to a curated validator set instead of running a validator yourself |
| EIP-1559 fee burn | Same formula shape (`max(minFee, amount × rate)`), burned on every P2P transfer |
| Issuance funds security | 5%/year issuance paid out as staking rewards |
| Self-custody wallet + seed phrase | Wallet auto-generated and AES-256-GCM encrypted server-side; unlocked with email + OTP — mobile-friendly, no seed phrase to lose |
| MetaMask + external dApps | D-Browser — curated, allowlisted in-app gateway to real external dApps |
| Off-chain governance (EIP process, social consensus) | **Deltix DAO** — in-app, stake-weighted proposals and voting, live from day one |
| *(no equivalent)* | **Referral program** — single-level (no downlines), stake-gated activation, automatic sponsor rewards |
| *(no equivalent)* | **Ambassador program** — Participant / Advocate / Ambassador recognition tiers with live progress tracking |

In short: Deltix keeps Ethereum's proven economics (staking, issuance, fee burn) and packages them for
mobile with custodial wallets, while adding growth and community mechanics — referrals and ambassador
tiers — that Ethereum itself does not have.

---

## 2. Network Overview

| Property | Value |
|---|---|
| Token | $DLTX (utility/reward token — no monetary value, not redeemable for real currency) |
| Consensus | Delegated Proof of Stake (DPoS) |
| Initial supply | 100,000,000 $DLTX |
| Annual issuance | 5% of supply (staking rewards) |
| Base staking APY | ~8% (variable, validator-dependent) |
| Transfer base fee | 0.1% of amount (min 0.01 $DLTX), **permanently burned** |
| Referral model | Unlimited direct referrals, single-level (no downlines) |
| Referral reward | 10 $DLTX per activated referral (25 $DLTX during the launch window) |
| Referral activation | Referred user verifies + stakes ≥ 50 $DLTX |
| Welcome bonus | 50 $DLTX per verified account (100 $DLTX during the launch window), non-transferable |
| Arcade rewards | 0.05 $DLTX (easy) / 0.1 $DLTX (hard) per win · 10 $DLTX daily cap |
| Arcade catalogue | 22 original skill games (5 opened with Deltix Energy) |
| Deltix Energy | 8 non-monetary status ranks · never exchangeable for $DLTX |
| Ambassador threshold | 3 activated referrals + 500 $DLTX self-staked |
| Governance | Deltix DAO — stake-weighted voting (1 staked $DLTX = 1 vote), live at genesis |
| DAO proposal threshold | 100 $DLTX self-staked |
| DAO voting period | 7 days per proposal |

---

## 3. Architecture

### 3.1 Delegated Proof of Stake

Deltix uses DPoS: token holders delegate stake to validators who produce blocks and secure the network. Validators publish a **commission rate** and are measured on **uptime**; delegator rewards are computed net of commission and degraded by validator downtime.

Effective delegator yield:

```
APY_effective ≈ BASE_APY × uptime × (1 − commission)
```

### 3.2 Accounts and Wallets

- Registration requires only an email address, verified by a short-lived OTP.
- A wallet keypair is generated server-side at registration; the private key is encrypted at rest with AES-256-GCM.
- Addresses follow the familiar `0x` + 40-hex-character format.
- OTP verification is an **identity mechanism only** — it never controls wallet keys.

### 3.3 The Deltix Application

The application is organized into these surfaces:

1. **Wallet** — balances, send/receive, network snapshot, activity history.
2. **Stake** — validator directory, delegation, unbonding, reward tracking.
3. **Arcade** — 22 original skill games with capped daily $DLTX utility rewards (no wagering, no entry fees). Play sessions are opened and settled server-side against a minimum play time, and every reward is recorded on the Deltix chain.
4. **D-Browser** — a curated, allowlisted gateway to third-party dApps with a security interstitial (HTTPS-only; external sites are never trusted with credentials).
5. **Community** — the Deltix DAO (proposals and stake-weighted voting), referral code, referral tracking, ambassador tiers.
6. **Network** — live tokenomics: supply, staked totals, burned totals, participation.
7. **Deltix Energy** — a non-monetary status system: watch opt-in rewarded ads to earn Energy and climb eight ranks. Energy may be spent to open bonus Arcade games. It is held **against the account**, so a rank survives a reinstall or a change of device. Energy has no monetary value, is never $DLTX, and can never be transferred, sold, or exchanged.

---

## 4. Monetary Policy

### 4.1 Issuance

The network launched with a genesis supply of **100,000,000 $DLTX**. New $DLTX is issued at **5% annually**, distributed exclusively as staking rewards. Issuance pays for security: only participants who lock value into the network's consensus earn new supply. $DLTX is a utility and reward token with no monetary value; issuance and rewards represent in-app utility, not financial return.

### 4.2 Fee Burning (Deflationary Pressure)

Every peer-to-peer transfer pays a **base fee**:

```
fee = max(0.01 $DLTX, amount × 0.001)
```

The base fee is **permanently burned** — removed from total supply — mirroring Ethereum's EIP-1559 mechanism. As network activity grows, burn pressure increasingly offsets issuance:

```
net_inflation = issuance − burns
```

At sufficient transaction volume, the network can become **net deflationary**.

### 4.3 Supply Transparency

Total supply, staked supply, burned supply, and participation statistics are publicly visible in the application's Network tab at all times.

### 4.4 Onboarding Allocations

- **Welcome bonus:** 50 $DLTX per verified account (100 $DLTX during the launch window), one per person. The welcome bonus is **non-transferable** — it can be staked or used in-app but never sent peer-to-peer — which prevents multi-account bonus farming.
- **Genesis faucet:** retired by governance (DIP-2); early participation is now seeded by the welcome bonus and play-to-earn Arcade rewards.

---

## 5. Staking and Delegation

### 5.1 Mechanics

- Any holder may delegate any amount to an active validator.
- Staked balances are **locked** — unavailable for transfer while staked.
- Rewards accrue continuously based on stake size, validator uptime, and commission.
- Unstaking is subject to **unbonding rules** that protect network security.

### 5.2 Validator Accountability

Validators are ranked by total stake, uptime, and commission. Poor performance directly reduces delegator returns, creating a market for reliability. Slashing mechanics for provable misbehavior (double-signing, extended downtime) are part of the security roadmap (§11).

### 5.3 Risk Disclosure

Staking rewards are **variable protocol incentives, never guaranteed income**. Delegators bear validator performance risk, protocol parameter risk, and market risk. These disclosures are presented in-app before every delegation.

---

## 6. Peer-to-Peer Transfers

Once verified, every participant can transfer $DLTX to any other network address:

1. Sender specifies recipient address and amount.
2. The protocol computes the base fee and displays the total debit before confirmation.
3. On confirmation, the amount is credited to the recipient and the fee is burned.
4. Transfers are final once processed.

This gives $DLTX immediate utility as a medium of exchange within the network, in the same spirit as ETH transfers on Ethereum.

---

## 7. Referral Program

### 7.1 Design Goals

Growth mechanisms in crypto frequently degenerate into multi-level marketing. Deltix's referral program is deliberately constrained:

- **Single-level only.** Rewards flow only between a sponsor and their direct referral — never through chains, levels, or downlines.
- **Stake-gated activation.** Registration alone earns nothing; a referral pays only after the referred user stakes.
- **Abuse-resistant by design.** The non-transferable welcome bonus and stake-gated activation — not an arbitrary slot cap — keep referrals honest, so the number of direct referrals is unlimited.

### 7.2 Mechanics

1. Every verified account receives a unique referral code (`DLTX-XXXXXX`).
2. A new user enters the code at signup (or redeems it once, later, if they joined without one).
3. The referral is **pending** until the new user verifies their email, and **activated** only when they stake **≥ 50 $DLTX**.
4. On activation, the sponsor automatically receives **10 $DLTX** (**25 $DLTX** during the launch window). One reward per referral, paid once, forever.

### 7.3 Tracking

Sponsors see each referral's status in real time — pending verification, verified/awaiting stake, or activated — with referred emails masked for privacy.

### 7.4 Why Stake-Gating Matters

Requiring an eligible stake before any reward is paid means every rewarded referral is a **real economic participant**, not a throwaway signup. This aligns growth incentives with network security.

### 7.5 Reward Economics

Referral rewards are protocol incentives drawn from the network incentive budget: **10 $DLTX per activation** (25 $DLTX during the launch window). There is no slot cap, but every reward requires the referred user to verify and hold an eligible stake of ≥ 50 $DLTX — so rewards track genuine, capital-committed participants rather than raw signups, and cannot be industrialized with throwaway accounts.

### 7.6 Anti-Fraud

The protocol enforces: self-referral rejection, one-sponsor-per-account, a non-transferable welcome bonus, stake-gated one-time reward payment, rate limiting, Play Integrity attestation, and duplicate-account (Sybil) detection. Fraudulent referrals result in reward forfeiture and account termination.

---

## 8. Ambassador Program

Recognition tiers reward sustained, genuine contribution:

| Tier | Requirements | Benefits |
|---|---|---|
| **Participant** | Verified account | Stake, delegate, govern, refer others |
| **Advocate** | 1 activated referral + an active stake | Community badge, early feature access |
| **Ambassador** | 3 activated referrals + 500 $DLTX self-staked | Non-transferable ambassador badge, governance spotlight, priority validator invitations |

Tier status is computed automatically and displayed with live progress tracking in the Community tab. Tiers are recognition statuses — they confer visibility and access, not income streams.

---

## 9. D-Browser and the dApp Ecosystem

The D-Browser is a curated gateway to the wider decentralized web:

- **Allowlisted destinations only** — a vetted set of established dApps.
- **Security interstitial** — the full destination URL is displayed before any external navigation; HTTPS is mandatory.
- **Zero credential trust** — users are warned never to enter recovery material on external sites.
- Third-party dApps are independent services; Deltix does not audit, control, or guarantee them.

---

## 10. Governance: The Deltix DAO — Live from Day One

Deltix does not treat decentralization as a distant promise. The **Deltix DAO is live at genesis**:
from the first day of the network, protocol changes are proposed and decided by the community,
inside the app, by stake-weighted vote.

### 10.1 How the DAO Works

- **Voting power comes from staking.** 1 staked $DLTX = 1 vote. Only participants with locked,
  at-risk value steer the protocol — the same capital that secures the network governs it.
- **Anyone can propose.** Any account with an active self-stake of at least **100 $DLTX** may
  submit a proposal from the Community tab.
- **Fixed voting window.** Each proposal is open for **7 days**. One vote per account per
  proposal; votes are weighted by the voter's staked balance at the time of voting.
- **Quorum + majority.** A proposal passes when total voted stake meets quorum and FOR outweighs
  AGAINST. Results, tallies, and voter counts are publicly visible in the app in real time.
- **Genesis proposals.** The DAO opened with its first ballots at launch — DIP-1 (ratification of
  the genesis parameter set) and DIP-2 (the faucet retirement schedule) — so governance has never
  been inactive for a single day of the network's existence.

### 10.2 Governance Surfaces

Protocol parameters — issuance rate, base fee, staking APY, referral values, ambassador
thresholds, faucet policy, and DAO thresholds themselves — are explicit governance surfaces,
adjustable by community vote.

### 10.3 Expanding Scope of Decentralization

The DAO's voting machinery is live from day one; what expands over time is the **scope of binding
on-chain control**. These phases map one-to-one onto the delivery phases in §13.2:

| Phase | Status | Scope of DAO control |
|---|---|---|
| **Phase 1 — Live DAO** | ✅ Delivered | Stake-weighted proposals and voting live in-app; parameter changes ratified by community ballot |
| **Phase 2 — Validator governance** | ▶ In progress | Validator admission and removal put to DAO vote; proposal timelocks |
| **Phase 3 — Treasury governance** | ○ Planned | Treasury allocation and incentive budgets controlled by DAO vote with public accounting |
| **Phase 4 — Full decentralization** | ○ Planned | Protocol upgrades, parameter changes, and treasury spending controlled entirely by the DAO |

---

## 11. Security Model

- **Key custody:** wallet private keys encrypted at rest (AES-256-GCM); encryption keys never leave the server boundary.
- **Authentication:** short-lived OTPs delivered by email; signed, expiring session tokens.
- **Transport:** HTTPS everywhere.
- **Client integrity:** Google Play Integrity attestation on account creation and reward settlement, plus a server-side minimum-version gate for retiring unsupported clients.
- **Abuse resistance:** per-IP rate limiting, disposable-domain and mail-exchange screening, one-account-per-person policy, a non-transferable welcome bonus, Sybil detection, and referral-fraud enforcement (§7.6).
- **Planned (§13.2, Phase 3):** validator slashing enforcement, optional self-custody export, and an independent third-party security audit before the remaining decentralization phases.

---

## 12. Liquidity Strategy

Deltix is a standalone network with its own token, monetary policy, and roadmap. Exchange listings
and liquidity venues are pursued deliberately, once network fundamentals — active staking, real
transaction volume, and a functioning referral/ambassador community — are established. Deltix
pursues **no premature independent listings**; thin, fragmented early liquidity harms the same
participants the network is trying to serve.

---

## 13. Delivery Status and Roadmap

Deltix publishes what is **actually running** separately from what is **planned**. Everything in
§13.1 is live in the shipped application today and can be verified inside the app; everything in
§13.2 is a development objective, not a guarantee.

### 13.1 Delivered — Live Today

**Core protocol**

- Genesis supply of 100,000,000 $DLTX with public, real-time supply accounting (issued, staked, burned, circulating).
- Hash-linked Deltix block ledger with a **public block explorer** that requires no account, and a chain-verification endpoint that re-derives every hash link.
- Peer-to-peer transfers with the EIP-1559-style base fee **permanently burned** on every transaction.
- Delegated Proof-of-Stake delegation and unbonding against a published validator directory, with commission and uptime reflected in effective yield.

**Governance**

- The **Deltix DAO is live**: proposal creation above the self-stake threshold, stake-weighted voting, quorum and majority resolution, and public tallies.
- Genesis ballots DIP-1 (parameter ratification) and DIP-2 (faucet retirement) were opened at launch and DIP-2 has been executed — the faucet is retired and its endpoints now return a permanent retirement response.

**Accounts and community**

- Email-OTP onboarding with a custodial wallet generated at registration, private keys encrypted at rest with AES-256-GCM.
- Separate **Sign in** and **Sign up** flows; sign-up carries the 18+ and Terms acceptance gate.
- **Unlimited** single-level referrals with stake-gated activation, plus the ambassador recognition tiers.
- Self-service **account deletion** with immediate and irreversible erasure.

**Application surfaces**

- All seven surfaces described in §3.3 are shipped: Wallet, Stake, Arcade, D-Browser, Community, Network and Deltix Energy.
- **22 original Arcade games**, each an in-house implementation of a public-domain game concept, with server-side session settlement, a minimum play time, and a 10 $DLTX daily reward cap.
- **Deltix Energy** with eight status ranks, daily streaks, and Energy-funded unlocking of five bonus Arcade games. Energy, streaks and cosmetic ownership are held per account and settled server-side against a daily limit.
- Personalisation: 82 avatar characters and 12 application themes, including a free dark theme.

**Platform and integrity**

- The Android application is published on Google Play, targeting the current required API level, with code shrinking and resource optimisation enabled.
- **Google Play Integrity** attestation is wired into account creation and reward settlement to resist cloned or tampered installs.
- A server-side minimum-version gate lets the network retire unsupported clients without an app-store dependency.
- Anti-abuse controls in production: disposable-domain blocking, mail-exchange validation, request rate limiting, and a **non-transferable welcome bonus** so onboarding grants cannot be farmed and drained between accounts.

### 13.2 Planned — In Sequence

Phases are ordered by dependency. Each phase must clear security review before the next begins.

| Phase | Status | Scope |
|---|---|---|
| **Phase 1 — Live Network** | ✅ Delivered | Everything in §13.1: wallet, staking, burn-bearing transfers, live DAO, referrals and ambassadors, D-Browser, Arcade, Energy, public explorer, Android release |
| **Phase 2 — Reach and Validators** | ▶ In progress | iOS release; third-party validator onboarding and validator-set expansion; DAO control extended to validator admission and removal; proposal timelocks |
| **Phase 3 — Hardening** | ○ Planned | Validator slashing enforcement; independent third-party security audit; optional self-custody key export; DAO control of the protocol treasury with public accounting |
| **Phase 4 — Full Decentralization** | ○ Planned | Protocol upgrades, parameter changes and treasury spending controlled entirely by the DAO |
| **Phase 5 — Ecosystem** | ○ Planned | Exchange listings and liquidity venues per §12; bridges; expanded dApp directory; public developer APIs |

Community-requested features currently queued for delivery inside Phase 2 include Energy
leaderboards, profile rank badges, and seasonal Energy events.

**Honest limitations at the time of writing.** The initial validator set is operated under network
supervision while third-party validator onboarding is built; slashing is specified but not yet
enforced; wallets are custodial and key export is a Phase 3 item; and no independent security audit
has been completed yet. These are stated plainly so that participation is an informed choice.

Roadmap items are development objectives, not guarantees; sequencing may change based on security
review and governance input.

---

## 14. Sustainability

Long-term operations are funded by a combination of:

1. **Protocol treasury** — a governance-controlled share of issuance.
2. **Clearly separated advertising** — optional sponsored placements in non-protocol surfaces, never mixed with consensus, balances, or the ledger, and always labeled. Two formats are used: interstitials between Arcade sessions, and **opt-in rewarded video** that the user chooses to watch.
3. **Standalone sustainability** — the network is designed to fund its own operations without dependence on external ecosystems.

**Advertising never pays $DLTX.** Rewarded video grants only non-transferable, in-app cosmetic or
status benefits — Deltix Energy, avatar characters, and application themes. These cannot be sent to
another account, sold, or converted into $DLTX or any currency. $DLTX is earned only by staking,
referral activation, and Arcade skill wins, and it is never gated behind watching an advertisement.
This separation is deliberate: it keeps advertising revenue independent of the token economy and
keeps the network compliant with advertising-network policy on non-transferable rewards.

No user funds are ever used for operations. Staked balances belong to their delegators, full stop.

---

## 15. Legal Notices

- $DLTX is an in-app utility and reward token. It has **no monetary value**, is **not redeemable for real-world currency or any other cryptocurrency**, and cannot be cashed out through the Service.
- Nothing in this document is an offer to sell securities, investment advice, financial advice, or tax advice. $DLTX is not an investment product.
- Staking, referral, and APY figures are variable protocol parameters representing in-app utility value, not promises of monetary return.
- Use of the network is governed by the [Terms of Service](frontend/terms.html) and [Privacy Policy](frontend/privacy.html). Users must be 18 or older.
- This whitepaper describes protocol intent; where it conflicts with the Terms of Service, the Terms control.

---

## 16. Conclusion

Deltix Network makes Ethereum-style staking economics accessible to anyone with an email address — live from the very beginning. A fixed genesis supply, security-funding issuance, and transaction-driven burning form a disciplined monetary core. A single-level, stake-gated referral system grows the network human by human, not pyramid by pyramid. And the Deltix DAO — live from day one — puts every protocol change to a stake-weighted community vote, expanding its binding scope deliberately and verifiably until the network belongs entirely to its participants.

**Deltix Network — stake, transfer, govern. From day one.**

---

*Contact: support@deltixllc.com · © 2026 Deltix Network. All rights reserved.*
