# Deltix Network Whitepaper

**$DLTX: A Mobile-First Delegated Proof-of-Stake Network with a Dual Earning Economy**

Version 2.0 · Effective October 1, 2026 · Deltix Network · App release 1.16

---

## Abstract

Deltix Network is a live, mobile-first Delegated Proof-of-Stake (DPoS) network built on Ethereum's
core economic design (staking-funded issuance and EIP-1559-style fee burning), delivered through a
custodial mobile experience so anyone with an email address can participate in under a minute, with
no seed phrase, gas management, or node operation required.

Since the first release the network has grown from a wallet, staking and DAO into a complete
in-app economy with two clearly separated value layers:

- **$DLTX**, the native ledger token: staking, transfers with a burned base fee, DAO voting,
  Play & Earn rewards, Deltix Earn sessions, and the P2P Marketplace.
- **Deltix Energy**, a non-monetary activity point: earned from opt-in rewarded ads and daily
  loops, delegated to Energy Validators for more Energy, and spent in games, the Shop and
  Deltix Earn.

$DLTX is an in-app utility and reward token. Deltix Network assigns it no monetary value, sets no
price for it, and does not redeem it for currency or any other cryptocurrency. The P2P Marketplace
described in section 8 is a user-to-user exchange facilitated by platform escrow and human
moderation; any price agreed there is set by the two participants, never by Deltix.

This paper describes the architecture, monetary policy, staking mechanics, the Energy system, the
Dual Earning System, the P2P Marketplace, referral and ambassador programs, security model,
governance, the related wDLTX BEP-20 token, and a plainly stated account of what is **delivered
today** versus what remains **planned** (section 15).

---

## The Deltix Story

### Why "Deltix"?

The name comes from **delta (Δ)**, the fourth letter of the Greek alphabet and one of the most
meaningful symbols in mathematics, finance, and nature:

- **In mathematics, Δ means change.** Delta is the universal symbol for difference, the measure
  of how things move from one state to another. Deltix exists to change who gets to participate
  in staking economies: not just the technically sophisticated, but anyone with a phone and an
  email address.
- **In nature, a delta is where a river meets the sea.** A river delta does not concentrate its
  water in one channel; it distributes it across many branches, nourishing everything it
  touches. That is precisely how Delegated Proof of Stake works: value flows from many small
  delegators through validator channels, and rewards flow back out to every participant.
- **In markets, delta measures sensitivity**, how much one thing responds to movement in
  another. Deltix's economy is built on the same idea of responsive balance: issuance responds
  to staking participation, burning responds to transaction volume, and the network's monetary
  state is always the sum of those flows (S<sub>t+1</sub> = S<sub>t</sub> + I<sub>t</sub> - B<sub>t</sub>).

The **"-ix"** suffix marks it as a network, a system, a matrix of participants, rather than a
single thing. Put together, **Deltix is "the network of change"**: a system built to move value,
distribute rewards, and shift staking from the server room to the pocket.

### How Deltix Began

Deltix started with a simple observation: Ethereum solved the hard problems (Proof of Stake
consensus, sustainable issuance, deflationary fee burning) but never solved the *human* problem.
A decade after staking became mainstream, participating still meant seed phrases that could be
lost forever, gas fees that made small transactions pointless, exchanges that demanded documents
before allowing a single delegation, and validator software that assumed everyone owned a server.

The founding idea behind Deltix was to keep Ethereum's proven economic engine and rebuild
everything around it for the phone:

- **If a wallet can be lost, generate and protect it for the user.** Custody with AES-256-GCM
  encryption replaced the seed phrase.
- **If validators require servers, let users delegate instead.** A curated validator set replaced
  node operation.
- **If growth programs become pyramids, keep them single-level.** One sponsor per user, no
  downlines, rewards only for genuine staking participants.
- **If people will spend time in the app anyway, let that time count.** Deltix Energy turns
  attention and daily habit into a status economy that is deliberately separated from the token.
- **If users want to trade with each other, give them escrow and a referee.** The P2P Marketplace
  digitised the rules of the community's own trading group: platform escrow, a named moderator
  on every trade, and a transparent fee.

Deltix launched live from day one, and every feature in this paper that is marked as delivered
can be opened and verified inside the shipped app today.

---

## 1. Introduction

### 1.1 Motivation

Most staking networks demand technical sophistication: seed phrases, gas management, node
operation, and exchange onboarding. Deltix inverts the model. The network is live through a
mobile-first application where:

- Identity is established with **email + one-time passcode (OTP)**. No seed phrase is required.
- A wallet is generated automatically and its private key is encrypted at rest.
- Staking, delegation, transfers, games, Energy and referrals work from the first session.

### 1.2 Design Principles

1. **Accessibility first.** One minute from download to delegation.
2. **Ethereum-inspired economics.** Issuance funds security; fee burning counteracts inflation.
3. **Mobile-custodial by design.** Deltix generates and encrypts each wallet on the user's behalf.
   This is a deliberate accessibility trade-off, not a placeholder.
4. **Server-authoritative everything.** Every balance, reward, game outcome, Energy grant and
   trade state is decided and recorded server-side. The app only animates results; a modified
   client cannot mint anything.
5. **Two value layers, kept apart.** $DLTX is the ledger token. Energy is a non-monetary status
   point. Advertising pays Energy only, never $DLTX directly.
6. **Bounded emission.** Every free $DLTX path is clamped by a shared daily cap per account.
7. **Human-scale growth.** Single-level referrals with no downlines; rewards gated on genuine
   staking and time-locked against farming.
8. **DAO from day one.** Protocol changes are decided by stake-weighted community vote inside the
   app, and the scope of binding control expands in phases.
9. **Standalone by design.** Deltix is a self-contained network with its own token, monetary
   policy, and roadmap.

### 1.3 Deltix vs. Ethereum: What Carries Over, What Is Added

| Ethereum concept | Deltix implementation |
|---|---|
| Proof of Stake | Delegated PoS: delegate to a curated validator set instead of running a validator yourself |
| EIP-1559 fee burn | Same formula shape (`max(minFee, amount x rate)`), burned on every transfer; 1% unstake fee also burned |
| Issuance funds security | 5% per year issuance paid out as staking rewards |
| Self-custody wallet + seed phrase | Wallet auto-generated and AES-256-GCM encrypted server-side; unlocked with email + OTP |
| MetaMask + external dApps | D-Browser: curated, allowlisted in-app gateway to external dApps |
| Off-chain governance | **Deltix DAO**: in-app, stake-weighted proposals and voting |
| *(no equivalent)* | **Deltix Energy**: non-monetary status points with ranks, delegation and games |
| *(no equivalent)* | **Dual Earning System**: Play & Earn (capped) and Deltix Earn (timed sessions) |
| *(no equivalent)* | **P2P Marketplace**: escrowed, moderated user-to-user DLTX/USDT trades |
| *(no equivalent)* | **Referral and Ambassador programs**: single-level, stake-gated, time-locked |

---

## 2. Network Overview

| Property | Value |
|---|---|
| Token | $DLTX (in-app utility and reward token; no monetary value assigned by Deltix) |
| Consensus | Delegated Proof of Stake (DPoS) |
| Initial supply | 100,000,000 $DLTX |
| Annual issuance | 5% of supply (staking rewards) |
| Base staking APY | ~8% (variable, validator-dependent) |
| Transfer base fee | 0.1% of amount (min 0.01 $DLTX), **permanently burned** |
| Unstake fee | 1% of principal, **permanently burned** |
| Welcome bonus | 50 $DLTX per verified account, non-transferable (stakeable) |
| Play & Earn daily cap | 10 $DLTX per account per UTC day across every game and reward loop |
| Deltix Earn | 50 Energy opens a 12-hour session that pays 5 $DLTX on claim |
| Arcade catalogue | 23 original skill games (18 core + 5 opened with Energy) |
| Instant Energy games | 14 server-settled one-tap and timing games |
| Deltix Energy ranks | 8 non-monetary ranks, Deltix Soldier to Deltix Legend |
| Energy Delegation | 50% annual generation rate (protocol-adjustable), claim-only rewards |
| Referral reward | 10 $DLTX per activated referral; 15 $DLTX on days 1 to 3 of each month |
| Referral activation | Referred user verifies and stakes at least 50 $DLTX of earned (non-bonus) value |
| Referral reward lock | Transferable after 180 days; stakeable and spendable in-app immediately |
| Ambassador threshold | 3 activated referrals + 500 $DLTX self-staked |
| P2P Marketplace | DLTX/USDT (BNB Chain BEP-20), platform escrow, 1% buyer fee + 1% seller fee, 90-minute trade window |
| Governance | Deltix DAO, stake-weighted voting (1 staked $DLTX = 1 vote) |
| DAO proposal threshold | 100 $DLTX self-staked; 7-day voting period; 100 voted $DLTX quorum |
| Accounts per device | 4 |

---

## 3. Architecture

### 3.1 Delegated Proof of Stake

Deltix uses DPoS: token holders delegate stake to validators who produce blocks and secure the
network. Validators publish a **commission rate** and are measured on **uptime**; delegator
rewards are computed net of commission and degraded by validator downtime.

```
APY_effective ~ BASE_APY x uptime x (1 - commission)
```

### 3.2 The Deltix Chain

Every economic action (transfer, stake, reward, Energy grant, trade settlement) is sealed into a
hash-linked block ledger with a 15-second block time. The chain is persisted in the network
database with a writer fence so only the newest server instance may append, and a verification
endpoint re-derives every hash link on demand. A **public block explorer** in the Network tab
requires no account.

### 3.3 Accounts and Wallets

- Registration requires only an email address from a public mail provider, verified by a
  short-lived OTP. Sign-in uses the same code flow; there is no password to steal.
- A wallet keypair is generated server-side at registration; the private key is encrypted at
  rest with AES-256-GCM. Addresses follow the `0x` + 40-hex-character format.
- OTP verification is an **identity mechanism only**. It never controls wallet keys.
- Balances are tracked to 8 decimal places. The wallet shows four numbers: **Balance** (all
  liquid $DLTX), **Staked**, **Pending rewards**, and **Transferable**.

### 3.4 Balance Model

Transferable value is the single authoritative number the backend validates against:

```
transferable = balance - p2p_escrow - max(0, welcome_bonus + time_locked_referral_rewards - staked)
```

The welcome bonus and time-locked referral rewards are liens on the account's total holdings;
both may be staked, and the lien follows the coins into the stake. P2P escrow is a hard lien on
liquid balance only: escrowed coins can never be staked, spent or sold twice. Transfers, paid
spins and Shop purchases all read this one calculation.

### 3.5 The Deltix Application

The application is organised into these surfaces, all shipped:

1. **Wallet**: balances, send/receive, network snapshot, activity history.
2. **Stake**: validator directory, delegation, unbonding, reward tracking.
3. **Deltix Energy**: Energy Delegation to Energy Validators, claimable rewards, transfer unlock
   progress.
4. **P2P Market**: DLTX/USDT advertisements, escrowed order rooms, moderator panel.
5. **Arcade**: 23 original skill games with capped $DLTX rewards.
6. **Games**: hub for Fortune Wheel, Daily Ladder, Coin Flip, Take It or Risk It, Energy Wire
   and the Instant Energy games.
7. **Rewards**: daily check-in, Mystery Box, Chest, Daily Puzzle, Daily Challenge, Deltix Tree,
   Deltix Vault, Weekly Calendar, Deltix Rain.
8. **Shop**: avatars, themes, Energy packs and a one-day Arcade cap boost.
9. **Deltix Earn**: timed 12-hour earn sessions.
10. **Missions**: a six-step daily journey.
11. **Assistant**: in-app help bot and identity verification card.
12. **D-Browser**: curated, allowlisted gateway to third-party dApps with a security
    interstitial.
13. **Community**: the Deltix DAO, referral code and tracking, ambassador tiers, global
    participation globe.
14. **Leaderboard, Season and Passport**: activity ranking, 30-day competitive seasons, and a
    per-account passport of stamps and badges.
15. **Network**: live tokenomics and the public block explorer.
16. **Rank**: Energy balance, streaks, rank shields and 2x Energy Hour.
17. **FAQ**: searchable in-app help mirrored on the website.

---

## 4. Monetary Policy

### 4.1 Issuance

The network launched with a genesis supply of **100,000,000 $DLTX**. New $DLTX is issued at **5%
annually**, distributed as staking rewards. In addition, the Play & Earn loops and Deltix Earn mint
small utility rewards that are clamped per account per day (section 7). The core team's share of
all distributed supply is hard-capped at 20%.

### 4.2 Fee Burning (Deflationary Pressure)

Every peer-to-peer transfer pays a **base fee**:

```
fee = max(0.01 $DLTX, amount x 0.001)
```

Unstaking burns **1% of the principal**. Both fees are **permanently removed from total supply**,
mirroring Ethereum's EIP-1559 mechanism. As network activity grows, burn pressure increasingly
offsets issuance:

```
net_inflation = issuance - burns
```

### 4.3 Recycled Pools

Some flows neither mint nor burn. $DLTX wagered on the paid Fortune Wheel spin and $DLTX spent in
the Shop flow into a **community rewards pool**, and paid-spin prizes are paid only from that
pool. This recycles value through the ecosystem without inflating supply.

### 4.4 Supply Transparency

Total supply, staked supply, burned supply and participation statistics are publicly visible in
the Network tab at all times, backed by the public block explorer.

### 4.5 Onboarding Allocation

- **Welcome bonus:** 50 $DLTX per verified account, one per person. It is **non-transferable**:
  it can be staked or used in-app but never sent to another account, which prevents multi-account
  bonus farming. It also does not count toward referral activation.
- **Genesis faucet:** retired by governance (DIP-2).

---

## 5. Staking and Delegation

### 5.1 Mechanics

- Any holder may delegate any amount (including the welcome bonus) to an active validator.
- Staked balances are **locked** and unavailable for transfer while staked.
- Rewards accrue continuously based on stake size, validator uptime and commission, and can be
  claimed at any time.
- Unstaking burns a 1% fee from principal before funds return to the liquid balance.

### 5.2 Validator Accountability

Validators are ranked by total stake, uptime and commission. Poor performance directly reduces
delegator returns. Slashing for provable misbehaviour is specified but not yet enforced
(section 15).

### 5.3 Risk Disclosure

Staking rewards are **variable protocol incentives, never guaranteed income**. Delegators bear
validator performance risk and protocol parameter risk. These disclosures are presented in-app
before every delegation.

---

## 6. Deltix Energy

### 6.1 What Energy Is

Deltix Energy (⚡) is a **non-monetary activity point** held against the account, so it survives a
reinstall or a change of phone and cannot be edited on the device. Energy is never $DLTX, cannot
be transferred between accounts, cannot be sold, and cannot be cashed out. Lifetime Energy sets a
cosmetic rank across eight tiers: Soldier, Inspector, Guardian, Captain, Major, Commander, Elite
and Legend.

### 6.2 Earning Energy

- **Rewarded ads:** 1 ⚡ per completed opt-in rewarded video, with a 20-second cooldown and
  server-side duplicate-callback detection. There is no daily ceiling on ad Energy because Energy
  is non-monetary.
- **2x Energy Hour:** a personal 60-minute window, activated by a rewarded ad up to twice per
  UTC day, during which ad Energy is doubled.
- **Daily Ladder:** 15 steps per day, claimed strictly in order; steps pay 1 ⚡ with starred
  bonus steps 10 and 15 paying 5 ⚡, for 23 ⚡ per day.
- **Weekly Calendar:** 1 ⚡ on weekdays, 2 ⚡ on weekend days.
- **Deltix Rain:** six drops per day totalling 10 ⚡.
- **Fortune Wheel:** one free spin every 12 hours paying 2, 5 or 8 ⚡.
- **Deltix Tree, Vault, Puzzle, Missions, Chest, Season prizes** and most Instant game outcomes.

### 6.3 Energy Delegation

Energy can be delegated to an **Energy Validator** (the validator registry in an app-level role;
consensus is untouched) and generates more Energy continuously:

```
reward = amount x annual_rate x elapsed / 365 days
```

- The current annual rate is **50%**, set by the protocol and adjustable at runtime; a rate
  change checkpoints existing accruals first and is never retroactive.
- Rewards accrue into **Claimable Energy only**; they never auto-compound and must be claimed.
- Undelegating early burns part of the principal by delegation age: days 1 to 7: 40%; days 8 to
  14: 25%; days 15 to 29: 10%; day 30 and later: no burn.

### 6.4 Transfer Unlock

New accounts begin with $DLTX transfers locked. The lock lifts once the account has **claimed 500
Energy from delegation** in total. Earned, purchased or granted Energy does not count; only
delegation claims advance the counter. This requires a sustained, time-based commitment before an
account can move $DLTX out, which is the network's primary defence against throwaway accounts.
Accounts created before this policy are grandfathered.

### 6.5 Spending Energy

Energy opens the five bonus Arcade games (15 to 80 ⚡), funds every Instant game, starts Deltix
Earn sessions, waters the Deltix Tree, buys extra Mystery Boxes, and purchases cosmetics in the
Shop.

---

## 7. The Dual Earning System

Deltix pays $DLTX utility rewards through two independent paths. Neither requires any payment, and
no reward is ever gated behind an advertisement.

### 7.1 Path 1: Play & Earn

Every game and daily loop shares **one** cap: at most **10 $DLTX per account per UTC day**
across Arcade wins, check-in, Mystery Box, Chest, Instant games, Daily Puzzle, Missions, Vault and
Tree. The cap is enforced server-side at the single point where rewards are credited.

- **Deltix Arcade:** 23 original implementations of public-domain game concepts (Tic-Tac-Toe,
  Chess, Sudoku, Reversi, Snake, 2048, Ludo and more), each with easy and hard modes paying 0.05
  and 0.1 $DLTX per win. Sessions are opened and settled server-side against a minimum play time.
  **Deltix Hour** doubles Arcade rewards for one unpredictable 60-minute window per UTC day,
  still inside the daily cap.
- **Instant Energy games:** 14 games (Smash the Diamond, Energy Scratch Card, Pick a Box, Pop
  the Balloon, Flip the Coin, Rocket Launch, Energy Target, Deltix Dice, Diamond Drop, Deltix Stop,
  Which Key?, Deltix Egg, Deltix Energy Wire and Take It or Risk It). Each spends Energy and pays a
  server-drawn outcome: Energy, a small $DLTX amount, a free spin, or nothing. On average they are
  an Energy sink.
  - **Take It or Risk It:** 20 ⚡ entry, ten shuffled cases with prizes from 1 to 100 ⚡; the
    server holds the board, makes rising offers after each round, and allows one hint ad per round.
  - **Deltix Energy Wire:** 1 ⚡ entry, five timed checkpoints paying 1/2/3/5/8 ⚡; collect after
    any hit or continue and risk the run; a break can be repaired by a rewarded ad (two per round).
- **Daily loops:** check-in (0.5 $DLTX, streaks), Mystery Box every 12 hours (0.5/1/2 $DLTX,
  extra box for 10 ⚡), Chest pick (0.75 $DLTX or 5/8 ⚡), Daily Puzzle (date-seeded code
  breaking, 6 attempts), Daily Challenge, six-step Missions (a new step every 4 hours), Deltix
  Tree (15 ⚡ to water, 30 levels), and the 7-day Deltix Vault (14 keys, one every 12 hours).

### 7.2 Path 2: Deltix Earn

Deltix Earn is a timed session with no game, no skill and no ad: spend **50 ⚡** to start a
**12-hour** session, then return and claim **5 $DLTX**. Sessions run on the server, so the app
does not need to stay open. The reward and Energy cost are locked into the session when it starts;
a later rate change never alters a running session. The rate is published as the *current* earn
rate and may be tuned by governance as the network grows.

### 7.3 Season, Leaderboard and Passport

A **30-day Season** awards points for real activity (games, check-ins, ads) and resets each
season; the top 20 receive announced prizes and cosmetic badges. The **Leaderboard** ranks lifetime
activity and the **Passport** records per-account stamps, including the Verified Identity stamp.
Points never mint anything automatically.

---

## 8. P2P Marketplace

### 8.1 Purpose

Before the marketplace existed, community members traded $DLTX for USDT in a messaging group with
volunteer referees. The P2P Marketplace digitises those rules so that neither side has to trust
the other: the platform holds the $DLTX, a named moderator verifies the USDT, and nothing is
released without both.

Deltix does not set, quote or guarantee any price. Each advertiser prices their own offer, each
trade is between two users, and Deltix's role is escrow agent and referee.

### 8.2 How a Trade Works

1. A **maker** posts a Buy or Sell advertisement (price in USDT, amount, limits, terms). Up to
   five new ads per rolling 24 hours per account; ads expire after 72 hours, can be paused,
   edited or cancelled, and a seller must first register a BEP-20 payout wallet.
2. A **taker** opens an order. The seller's $DLTX is locked in **platform escrow** inside the
   same database transaction that reserves the ad, so two buyers can never claim the same coins.
3. The buyer sends USDT (BNB Chain, BEP-20) to the **platform USDT address** shown in the order
   room, never directly to the seller, and submits the transaction hash. A hash can settle one
   order only.
4. The server verifies the transfer on-chain: successful receipt, correct contract, correct
   recipient, amount, and 15 confirmations.
5. The assigned **moderator** reviews the order room (chat, payment screenshot, verification
   result) and approves release. Release is never automatic: a server-side checklist requires
   locked escrow, verified USDT, an assigned moderator who is not a party, and no open dispute.
6. On release the buyer receives 99% of the $DLTX, the moderator pays the seller 99% of the USDT
   from the platform wallet and records the payout hash, and the order completes.

### 8.3 Trade Window and Cancellation

Each order carries a **90-minute** payment window shown to both parties. A buyer may cancel any
time before verification. A seller may cancel only after the window has elapsed with no payment
marked. A background sweeper returns escrow on orders that expire unpaid. Orders with a marked
payment or an open dispute are **never** cancelled by the clock; only a moderator can resolve them.

### 8.4 Fees and Moderators

- **Dual 1% fee:** the buyer pays 1% on the $DLTX leg and the seller pays 1% on the USDT leg.
- The fee is split **50% to the assigned moderator and 50% to the protocol**, and each trade
  stores an immutable commission snapshot so later policy changes never apply retroactively.
- Moderators are approved community members with a verified registry entry (referral code,
  personal $DLTX wallet, personal USDT wallet, none of which may be a platform address). Each
  moderator publishes **availability**, sends a heartbeat, and has a capacity limit; the
  marketplace shows who is ONLINE, BUSY or OFFLINE so a taker can choose a moderator who is
  actually present. A party may request reassignment when their moderator goes offline; senior
  moderators can reassign.
- Role permissions are enforced server-side: view, moderate, cancel, return escrow, resolve
  disputes, view commissions, reassign (senior only).

### 8.5 Safety Rules

- Buyers and sellers are identified publicly by **referral code**, never by email or IP.
- Contact details are held by the moderator only. The order-room chat blocks phone numbers and
  messenger handles between parties, and every order room shows the official Deltix support line.
- A reconciliation report proves at any time that total escrow equals total open obligations.
- Simulation mode, used for staging, labels every surface and only permits test identities.

### 8.6 Identity Verification

Identity verification (KYC) through a third-party provider is built into the app as a Verified
badge and Passport stamp. It is not yet switched on in production; when it is, it will gate the
marketplace for new traders. Deltix never stores identity documents itself.

---

## 9. Peer-to-Peer Transfers

Once an account has passed the transfer unlock (section 6.4), it can send $DLTX to any other
network address:

1. Sender specifies recipient address and amount.
2. The protocol computes the base fee and displays the total debit before confirmation.
3. On confirmation, the amount is credited to the recipient and the fee is burned, atomically.
4. Transfers are final once processed. Duplicate submissions are detected and refused.

---

## 10. Referral Program

### 10.1 Design Goals

- **Single-level only.** Rewards flow only between a sponsor and their direct referral.
- **Stake-gated activation.** Registration alone earns nothing.
- **Time-locked rewards.** Referral rewards cannot leave the sponsor's account for 180 days.
- **Unlimited direct referrals.** Abuse resistance comes from the gates above, not a slot cap.

### 10.2 Mechanics

1. Every verified account receives a unique referral code (`DLTX-XXXXXX`), which is also its
   public trader identity in the marketplace.
2. A new user enters the code at sign-up, or redeems it once later.
3. The referral is **pending** until the new user verifies, and **activates** only when they hold
   a stake of at least **50 $DLTX of earned or received value**. The welcome bonus does not count.
4. On activation the sponsor receives **10 $DLTX** (**15 $DLTX** during the monthly promo on days
   1 to 3). The reward is stakeable and spendable in-app immediately and becomes transferable
   after **180 days**.

### 10.3 Anti-Fraud

The protocol enforces self-referral rejection, one sponsor per account, a non-transferable welcome
bonus, earned-value activation, the 180-day lock, the 500-claim transfer unlock, a four-accounts-
per-device limit, rate limiting, and duplicate-account (Sybil) analysis. Fraudulent referrals
result in reward forfeiture, burning of farmed balances and account termination. In September
2026 the network identified and removed an industrial farm of roughly 131,000 fake accounts; the
earned-value activation rule, the reward lock and the transfer unlock were introduced in response.

---

## 11. Ambassador Program

| Tier | Requirements | Benefits |
|---|---|---|
| **Participant** | Verified account | Stake, delegate, govern, refer others |
| **Advocate** | 1 activated referral + an active stake | Community badge, early feature access |
| **Ambassador** | 3 activated referrals + 500 $DLTX self-staked | Ambassador badge, governance spotlight, priority validator invitations |

Tier status is computed automatically and displayed with live progress in the Community tab.
Tiers are recognition statuses, not income streams.

---

## 12. Governance: The Deltix DAO

### 12.1 How the DAO Works

- **Voting power comes from staking.** 1 staked $DLTX = 1 vote.
- **Anyone can propose.** Any account with an active self-stake of at least **100 $DLTX** may
  submit a proposal from the Community tab.
- **Fixed voting window.** Each proposal is open for **7 days**. One vote per account per
  proposal, weighted by staked balance at the time of voting.
- **Quorum + majority.** A proposal passes when at least 100 voted $DLTX participates and FOR
  outweighs AGAINST. Tallies and voter counts are public in real time.
- **Genesis proposals.** DIP-1 ratified the genesis parameter set and DIP-2 retired the faucet.
- **Maintenance pause.** The protocol steward can temporarily pause voting during maintenance;
  while paused, new proposals and votes are rejected and this is shown in the app.

### 12.2 Governance Surfaces

Issuance rate, base fee, unstake fee, staking APY, the Play & Earn daily cap, Deltix Earn rate,
Energy generation rate and burn tiers, referral values and locks, marketplace fees and windows,
ambassador thresholds and the DAO thresholds themselves are explicit governance surfaces.
Parameter changes affect future earning only; $DLTX already in a wallet is never removed.

### 12.3 Expanding Scope of Decentralisation

| Phase | Status | Scope of DAO control |
|---|---|---|
| **Phase 1: Live DAO** | Delivered | Stake-weighted proposals and voting live in-app |
| **Phase 2: Validator governance** | In progress | Validator admission and removal by DAO vote; proposal timelocks |
| **Phase 3: Treasury governance** | Planned | Treasury allocation and incentive budgets controlled by DAO vote with public accounting |
| **Phase 4: Full decentralisation** | Planned | Protocol upgrades, parameter changes and treasury spending controlled entirely by the DAO |

---

## 13. Security Model

- **Key custody:** wallet private keys encrypted at rest (AES-256-GCM); keys never leave the
  server boundary. Marketplace on-chain keys are never stored in the application codebase.
- **Authentication:** short-lived email OTPs with brute-force lockout and per-address send
  limits; signed session tokens; no passwords.
- **Transport:** HTTPS everywhere behind a global edge network, with real client addresses
  derived only from trusted edge headers.
- **Server authority:** every economic action is serialised per account, so rapid taps or
  concurrent requests cannot double-pay; escrow and transfers run in row-locked database
  transactions.
- **Client integrity:** Google Play Integrity attestation is wired for account creation and
  reward settlement, with a server-side minimum-version gate for retiring unsupported clients.
- **Account policy:** public-provider email addresses only, 4 accounts per device, 150 sign-ups
  per IP per day as a brake on scripted registration. Enforcement targets accounts and devices,
  never whole networks.
- **Abuse response:** Sybil scoring and audited ban tooling, burned farm balances, read-only
  account investigation reports, and request IDs on every error so support can trace incidents.
- **Observability:** slow-request and error logging with correlation references; degraded
  database conditions return a retryable status instead of failing silently.
- **Planned:** validator slashing enforcement, optional self-custody key export, and an
  independent third-party security audit (section 15).

---

## 14. wDLTX on BNB Chain

Deltix has deployed **Wrapped Deltix (wDLTX)**, a BEP-20 token on BNB Smart Chain (chain ID 56),
at `0xb239AE27C34235D329C56aF20ca91186b4564c3B`, with verified source on BscScan.

| Property | Value |
|---|---|
| Fixed supply | 50,000,000 wDLTX, 18 decimals, no mint function |
| Owner, admin, pause, blacklist, tax, proxy | None. The contract is immutable and has no privileged roles |
| Burning | Voluntary only (`burn` / `burnFrom`); supply can only decrease |
| Extras | EIP-2612 `permit` for gasless approvals |
| Initial holder | Deltix treasury (100% at deployment; distribution is a separate, later phase) |

**Required disclosure.** Native $DLTX and wDLTX are currently **two separate, unlinked assets**.
Despite the "Wrapped" name there is **no** conversion, redemption, 1:1 backing, bridge, vault or
price relationship between them, and none is implemented in the contract. Any future link would
require real backing, an audit and a governance decision, and would be announced in an updated
version of this paper. Until then wDLTX must not be represented as a conventional wrapped asset.

---

## 15. Delivery Status and Roadmap

Deltix publishes what is **actually running** separately from what is **planned**.

### 15.1 Delivered

**Core protocol**

- Genesis supply of 100,000,000 $DLTX with real-time public supply accounting.
- Hash-linked Deltix block ledger, public explorer, and chain-verification endpoint.
- Transfers with the burned base fee; unstaking with the burned 1% fee; DPoS delegation against a
  published validator directory.

**Governance**

- The Deltix DAO with proposals, stake-weighted voting, quorum and public tallies; DIP-1 and
  DIP-2 executed.

**Economy**

- The Dual Earning System: Play & Earn with a single 10 $DLTX daily cap, and Deltix Earn
  12-hour sessions.
- 23 Arcade games, 14 Instant Energy games, Fortune Wheel (free and paid), Daily Ladder, Weekly
  Calendar, Deltix Rain, Mystery Box, Chest, Daily Puzzle, Daily Challenge, Missions, Deltix
  Tree, Deltix Vault, Deltix Hour and 2x Energy Hour.
- Deltix Energy with eight ranks, Energy Delegation at a published rate, age-based undelegation
  burn, and the 500-claim transfer unlock.
- The Deltix Shop, 85 avatar characters, 15 application themes.
- 30-day Seasons, Leaderboard and Passport.

**P2P Marketplace**

- DLTX/USDT marketplace on BNB Chain with platform escrow, on-chain USDT verification,
  moderator approval, dual 1% fees with immutable commission snapshots, 90-minute trade window,
  automatic expiry of unpaid orders, moderator availability and reassignment, order history,
  dispute handling, moderator controls, and escrow reconciliation.

**Accounts and community**

- Email-OTP onboarding, custodial wallets, separate sign-in and sign-up flows with the 18+ and
  Terms gate, unlimited single-level referrals, ambassador tiers, in-app assistant, FAQ, and
  self-service account deletion.

**Platform and integrity**

- Android application on Google Play (release 1.16), Play Integrity attestation, minimum-version
  gate, device cap, email policy, Sybil tooling, request correlation and resilience hardening.

### 15.2 Planned, In Sequence

| Phase | Status | Scope |
|---|---|---|
| **Phase 1: Live Network** | Delivered | Everything in section 15.1 |
| **Phase 2: Reach, Identity and Validators** | In progress | Identity verification switched on for the marketplace; iOS release; third-party validator onboarding; DAO control of validator admission and removal; proposal timelocks; Fortune Wheel $DLTX jackpot segment |
| **Phase 3: Hardening** | Planned | Validator slashing enforcement; independent third-party security audit; optional self-custody key export; DAO control of the protocol treasury with public accounting |
| **Phase 4: Full Decentralisation** | Planned | Protocol upgrades, parameter changes and treasury spending controlled entirely by the DAO |
| **Phase 5: Ecosystem** | Planned | wDLTX distribution and any audited link to native $DLTX; additional marketplace networks; expanded dApp directory; public developer APIs |

**Honest limitations at the time of writing.** The initial validator set is operated under
network supervision; slashing is specified but not enforced; wallets are custodial and key export
is a Phase 3 item; identity verification is built but not yet enabled; the iOS app is not yet
released; no independent security audit has been completed; wDLTX is held entirely by the
treasury and is not linked to native $DLTX. These are stated plainly so that participation is an
informed choice. Roadmap items are development objectives, not guarantees.

---

## 16. Sustainability

Long-term operations are funded by:

1. **Protocol treasury**: a governance-controlled share of issuance, hard-capped for the team.
2. **Marketplace fees**: the protocol's 50% share of the dual 1% trade fee.
3. **Clearly separated advertising**: opt-in rewarded video and interstitials between game
   sessions, always labelled and never mixed with consensus, balances or the ledger.

**Advertising pays Energy only.** Rewarded video grants non-transferable Energy and cosmetics; it
never pays $DLTX directly and no $DLTX reward is ever gated behind watching an advertisement.

No user funds are ever used for operations. Staked balances belong to their delegators and
escrowed balances belong to the trade they secure.

---

## 17. Legal Notices

- $DLTX is an in-app utility and reward token. Deltix Network assigns it **no monetary value**,
  does not redeem it for real-world currency or any other cryptocurrency, and does not offer a
  cash-out through the Service.
- The P2P Marketplace is a facility for users to exchange $DLTX with each other. Deltix acts as
  escrow agent and moderator only. It does not set, quote or guarantee prices, does not act as a
  counterparty, and does not promise liquidity. Trading is voluntary and at the user's own risk.
- wDLTX is a separate BEP-20 token with no link to native $DLTX (section 14).
- Nothing in this document is an offer to sell securities, investment advice, financial advice
  or tax advice. $DLTX is not an investment product.
- Staking, referral, Earn and APY figures are variable protocol parameters, not promises of
  return.
- Use of the network is governed by the [Terms of Service](https://app.deltixllc.com/terms.html) and
  [Privacy Policy](https://app.deltixllc.com/privacy.html). Users must be 18 or older.
- This whitepaper describes protocol intent; where it conflicts with the Terms of Service, the
  Terms control.

---

## 18. Conclusion

Deltix Network makes Ethereum-style staking economics accessible to anyone with an email address.
A fixed genesis supply, security-funding issuance and transaction-driven burning form a
disciplined monetary core. A second, non-monetary Energy layer turns daily participation into
status and play without inflating the token. A capped Dual Earning System pays utility rewards
within bounds that are enforced in one place. An escrowed, moderated marketplace lets users trade
with each other without trusting each other. And the Deltix DAO puts every protocol parameter to
a stake-weighted community vote, expanding its binding scope deliberately until the network
belongs entirely to its participants.

**Deltix Network: stake, play, trade, govern.**

---

*Contact: support@deltixllc.com · © 2026 Deltix Network. All rights reserved.*
