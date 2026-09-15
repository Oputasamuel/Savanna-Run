# Savanna Run

[![Live Game](https://img.shields.io/badge/Play-savanna--run.xyz-f0a52b?style=for-the-badge)](https://savanna-run.xyz/)
[![Deploy Savanna Run WebGL](https://github.com/Oputasamuel/Savanna-Run/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/Oputasamuel/Savanna-Run/actions/workflows/deploy-pages.yml)

![Savanna Run](TemplateData/savanna-loading.jpg)

**Savanna Run** is a mobile-first 3D endless runner inspired by African landscapes and folklore. Guide Kesi through the savanna, dodge obstacles, collect cowries, use magical power-ups, and take to the sky on a flying broom.

## Play

Play the production WebGL release at **[savanna-run.xyz](https://savanna-run.xyz/)**.

A Nimiq Pay wallet is  required when purchasing items priced in NIM.

> **Mainnet notice:** NIM purchases use real NIM. Always review the recipient and amount in Nimiq Pay before confirming.

## Gameplay

- Run through a stylized 3D savanna village with an atmospheric home scene.
- Swipe or use the keyboard to change lanes, jump, and roll.
- Collect cowries on the ground and while flying.
- Preserve Kesi's Life Force by collecting Life Orbs and avoiding repeated hits.
- Use Cowrie Magnet and Invincibility power-ups during a run.
- Find the rare Flying Broom pickup after a randomized sequence of 2–4 magnet appearances.
- Fly for 10 seconds with randomized aerial animations, broom trails, particles, wind audio, and responsive camera effects.
- Receive 3 seconds of invulnerability when landing so the run can continue safely.
- Complete challenges and compete on the global leaderboard.

## Controls

| Action | Mobile | Keyboard |
| --- | --- | --- |
| Move left/right | Swipe left/right | `A` / `D` or arrow keys |
| Jump | Swipe up | `W`, `Up`, or `Space` |
| Roll | Swipe down | `S`, `Down`, or `Ctrl` |
| Use Life Orb | On-screen control | `1` or `Q` |
| Use Cowrie Magnet | On-screen control | `2` or `E` |
| Use Invincibility | On-screen control | `3` or `R` |
| Pause | Pause button | `Esc` |

## Accounts and progression

Players can begin immediately as guests and choose a runner name. An account can later be secured with an email address and a six-digit verification code—no password or emailed login link is required.

Signing into an existing email account safely merges eligible guest progress into the saved runner. Supabase stores authoritative balances, inventory, high scores, tasks, and leaderboard data. Missing profiles are automatically repaired, and stale guest sessions from a completed merge resolve to the permanent runner.

## Shop and economy

| Item | Price | Effect |
| --- | ---: | --- |
| Life Orb | 1,000 NIM | Restores 20% of Kesi's Life Force |
| Cowrie Magnet | 500 cowries | Pulls nearby cowries toward Kesi |
| Invincibility | 700 cowries | Protects Kesi from obstacles temporarily |
| Flying Broom | 1,000 cowries | Grants one 10-second flight |

Cowrie power-ups use dynamic repeat pricing. Repeat purchases increase in price until the 24-hour reset timer ends.

### Nimiq purchase flow

Life Orb purchases use native NIM on **Nimiq Mainnet**:

1. The player taps **Buy** and connects Nimiq Pay.
2. Supabase creates a short-lived purchase intent with the exact SKU, amount, treasury, and unique payment reference.
3. Nimiq Pay asks the player to approve the transaction.
4. A Supabase Edge Function verifies the transaction on-chain.
5. Inventory is awarded atomically and the transaction hash cannot be replayed for another reward.

The verifier checks the network, recipient, amount, payment reference, confirmation state, account ownership, and transaction hash before granting inventory. Pending payments can be recovered without asking the player to pay twice.

## Technology

- **Engine:** Unity 6 (`6000.0.61f1`)
- **Client:** Unity WebGL, optimized Brotli release under 100 MiB
- **Backend:** Supabase Auth, PostgreSQL, Row Level Security, and Edge Functions
- **Payments:** Nimiq Pay Mini App SDK and native NIM
- **Hosting:** GitHub Pages with Git LFS for the WebGL data bundle

## Repository layout

This `main` branch is the deployable production release:

```text
Build/                         Compiled Unity WebGL files
TemplateData/                  WebGL shell artwork and styling
index.html                     Responsive game shell and loading experience
nimiq-connection.js            Nimiq Pay browser bridge
supabase/functions/            Production payment verifier source
supabase/migrations/           Account/profile safety migrations
.github/workflows/             GitHub Pages deployment workflow
```


## Security

- Supabase service-role credentials and wallet recovery phrases are never shipped in the WebGL client.
- Client-visible Supabase keys are publishable keys protected by authenticated RPCs and Row Level Security.
- Paid inventory is granted only after server-side on-chain verification.
- Purchase confirmation is idempotent, preventing duplicate rewards from the same transaction.
- Production requests are restricted to approved origins, with private-network origins available for documented local testing.

## Studio

Developed by **WovenPath Studios**.
