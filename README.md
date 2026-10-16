# zUPI: Offline UPI via Bluetooth Mesh & Opportunistic Settlement 📡

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.19-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite WAL](https://img.shields.io/badge/SQLite-WAL%20Mode-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/wal.html)
[![Vitest](https://img.shields.io/badge/Tests-11%20Passed-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**zUPI** is a production-grade, zero-internet digital payment protocol built in **strict TypeScript / Node.js 20+ / Express**.

It enables offline UPI payments in scenarios where users have **zero cellular reception or Wi-Fi** (e.g. underground metro basements, remote hiking trails, disaster zones, or crowded stadiums). Encrypted payment tokens hop peer-to-peer across nearby devices via simulated **Bluetooth Low Energy (BLE)** gossip until an internet-connected device surfaces as a **Bridge Node**, opportunistically uploading the packet to the banking backend for deterministic, exactly-once ACID settlement.

---

## 🏗 System Architecture

```text
  [Phone Alice] (Offline Basement)
        │
        │ 1. AES-256-GCM + RSA-2048 Hybrid Encryption
        ▼
  [BLE Gossip Mesh] (TTL=5, seenHashes Filter)
        │
        ├─► [Stranger 1] ───► [Stranger 2] ───► [Stranger 3]
        │                                             │
        │                                             │ BLE Hops
        │                                             ▼
        │                                    [Phone Bridge] (Surfaces into 4G)
        │                                             │
        │                                             │ 2. HTTPS POST /api/bridge/ingest
        │                                             │    (X-Bridge-Node-Id: phone-bridge)
        │                                             ▼
        │                              ┌──────────────────────────────────────────────┐
        │                              │ zUPI Express Banking Gateway                 │
        │                              │                                              │
        │                              │ • Compute SHA-256(ciphertext)                │
        │                              │ • Tier 1: In-Memory Lock (0ms fast path)     │
        │                              │ • Tier 2: SQLite WAL `processed_packets`     │
        │                              │ • Decrypt Session Key (RSA-2048 Private)     │
        │                              │ • Decrypt Payload (AES-256-GCM + Auth Tag)   │
        │                              │ • Verify Signed Timestamp & 24h Freshness    │
        │                              │ • ACID Atomic Settlement (Decimal.js):       │
        │                              │     Alice: -₹250.00                          │
        │                              │     Bob:   +₹250.00                          │
        │                              │     Bridge: +₹0.50 Protocol Bounty 💰        │
        │                              └──────────────────────┬───────────────────────┘
        │                                                     │
        │                                                     │ 3. Settlement ACK Emitted
        │                                                     ▼
        └◄───────── ↺ REVERSE SETTLEMENT ACK (PURGES ALL DEVICE BUFFERS) ─────────────┘
```

---

## ⚡ Three Architectural Core Upgrades

### 1. Loop-Free BLE Gossip & Reverse ACK Mesh Purge
* **Seen-Packet Loop Blocker:** Each device maintains a local `seenHashes: Set<string>`. When a packet arrives, if its SHA-256 hash has already been observed, it is dropped immediately. This guarantees that devices in proximity never get stuck in infinite ping-pong relay loops.
* **Reverse Settlement ACK Kill-Switch:** Once the backend settles a transaction, it returns an ACK containing `{ packetHash, status: "SETTLED" }`. As bridge devices relay this ACK back into the BLE mesh, intermediate phones match the settled hash against their internal storage and immediately purge the buffered packet (`buffer.delete(packetHash)`). This frees device RAM across the network and permanently suppresses dead gossip traffic.

### 2. Bridge Node Micro-Bounty Incentive (₹0.50 Protocol Reward)
* **Decentralized Carrier Economics:** Why would strangers relay payment packets on behalf of others? zUPI introduces an automatic **₹0.50 Protocol Micro-Bounty** credited to the first bridge node that successfully surfaces with mobile data and delivers the transaction to the bank.
* **Sybil & Race Resistant:** If multiple bridge nodes surface simultaneously and submit identical ciphertexts, only the first arrival acquires the idempotency lock and earns the bounty. The concurrent duplicate upload receives HTTP 200 `DUPLICATE_DROPPED` with `bountyEarned: "₹0.00"`.
* **Auditable Ledger:** Bounty credits are recorded in the `bridge_rewards` table and can be inspected in real time via `GET /api/bridges/rewards`.

### 3. SQLite WAL Mode & Persistent CAS Idempotency Gate
* **Survives Server Reboots & Crashes:** Memory-only caches lose state when servers restart. zUPI couples an in-memory 0ms atomic compare-and-swap (CAS) gate with a persistent SQLite table (`processed_packets`) featuring `packet_hash TEXT PRIMARY KEY`.
* **High-Concurrency WAL Mode:** SQLite runs with Write-Ahead Logging (`PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, and `busy_timeout = 5000ms`), enabling continuous non-blocking concurrent reads and resilient crash durability.

---

## 🎬 End-to-End Lifecycle & Functioning (Step-by-Step)

### Step 1: Offline Payment Composition & Hybrid Encryption
Alice is in an underground basement food court with **0 bars of reception**. She enters Bob’s VPA (`bob@demo`), the amount (₹250.00), and her UPI PIN.

![Step 1: Offline Encryption](docs/assets/step1-offline-encryption.svg)

1. **Ephemeral Session Key:** Alice's device generates a cryptographically secure 256-bit AES key.
2. **Authenticated Symmetric Encryption:** The payment instruction is encrypted using **AES-256-GCM**, producing the ciphertext and a 16-byte authentication tag that detects any transit tampering.
3. **Asymmetric Key Encapsulation:** The 32-byte AES key is encrypted using the Bank Server's cached **RSA-2048 Public Key** with OAEP (SHA-256) padding.
4. **Wire Format Construction:** The packet is packed into a compact wire envelope:
   `[256-byte RSA Key | 12-byte IV | Variable Ciphertext | 16-byte GCM Tag]` and assigned `TTL = 5`.

---

### Step 2: Peer-to-Peer Bluetooth Mesh Gossip
Because Alice has no internet, her device advertises the packet over simulated Bluetooth Low Energy (BLE) / Wi-Fi Direct.

![Step 2: Mesh Gossip](docs/assets/step2-mesh-gossip.svg)

1. **Zero-Trust Relays:** Relaying devices (`stranger-1`, `stranger-2`, `stranger-3`) only see opaque ciphertext. They have zero access to the sender, receiver, amount, or PIN.
2. **Seen-Packet Deduplication:** Each phone checks `seenHashes.has(hash)`. If seen, it ignores the advertisement, preventing battery-draining loops.
3. **Hop Limit:** Each transmission decrements the TTL (`5 → 4 → 3 → 2 → 1`). Packets reaching `TTL = 0` are discarded.
4. **Reverse ACK Readiness:** Phones hold the encrypted packet in volatile memory while awaiting the reverse settlement ACK.

---

### Step 3: Opportunistic 4G Bridge Upload & Micro-Bounty Incentive
A delivery rider (`phone-bridge`) carrying the packet ascends an escalator and enters an area with 4G/5G mobile connectivity.

![Step 3: Bridge Upload](docs/assets/step3-bridge-upload.svg)

1. **Opportunistic Ingestion:** The bridge device flushes its buffer by dispatching an HTTPS `POST /api/bridge/ingest` with `X-Bridge-Node-Id: phone-bridge`.
2. **The Duplicate Storm:** If another stranger (`stranger-2`) also catches 4G reception 2 milliseconds later, both phones submit parallel requests containing the identical ciphertext.
3. **Economic Incentive:** The winning bridge node is rewarded with a **₹0.50 protocol bounty**, turning every mobile user into an incentivized offline payment carrier. The duplicate bridge receives a friendly `DUPLICATE_DROPPED` response.

---

### Step 4: Two-Tier CAS Idempotency Gate & Deterministic Settlement
The banking backend processes incoming requests through an atomic verification pipeline, guaranteeing zero double-spending.

![Step 4: Idempotency & Settlement](docs/assets/step4-idempotency-settlement.svg)

1. **Two-Tier Idempotency Gate:**
   * **Tier 1 (RAM):** The server checks an atomic hash set. If the hash is already active or settled, it rejects the duplicate in **0ms**.
   * **Tier 2 (SQLite WAL):** The hash is inserted into `processed_packets`. If the server crashed and rebooted moments prior, the database unique constraint stops duplicates from ever re-executing.
2. **Hybrid Decryption:** The server uses its RSA-2048 private key to recover the AES session key, then verifies the GCM auth tag and decrypts the instruction.
3. **Freshness & Nonce Verification:** Rejects any packet signed more than 24 hours ago, and verifies that the client-generated UUID `paymentNonce` has never been used.
4. **Atomic 3-Way ACID Transfer:**
   * Alice's account is debited ₹250.00.
   * Bob's account is credited ₹250.00.
   * `phone-bridge` is credited the **₹0.50 Protocol Bounty** in `bridge_rewards`.
   * Executed with exact-precision `Decimal.js` arithmetic (eliminating floating-point drift) and optimistic concurrency locks.
5. **Reverse ACK Emission:** Emits `{ packetHash, status: "SETTLED" }` back to the bridge node, propagating across the mesh to purge all relay device buffers.

---

## 🚀 Quick Start

### Prerequisites
* **Node.js 20+**
* **npm 9+**

### 1. Installation
```bash
git clone https://github.com/Shivam-Singh-1/zUPI.git
cd zUPI
npm install
```

### 2. Run Test Suite
Verify cryptographic invariants, concurrent duplicate storms, and mesh ACK purges:
```bash
npm test
```

### 3. Run Development Server
```bash
npm run dev
```

### 4. Build & Run Production Bundle
```bash
npm run build
npm start
```

Visit **[http://localhost:8080](http://localhost:8080)** to access the **Interactive Live Control Dashboard**.

---

## 🧪 Security & Correctness Invariants (11/11 Vitest Tests)

| Test Suite | Scenario Verified | Outcome |
| :--- | :--- | :--- |
| `singlePacketDeliveredByThreeBridgesSettlesExactlyOnce` | 3 bridge nodes simultaneously upload the exact same packet with 0ms delay. | **Passed** — Exactly 1 settles (₹100.00 debited); 2 concurrent duplicates dropped. |
| `tamperedCiphertextIsRejected` | Single-bit alteration in ciphertext during mesh transit. | **Passed** — AES-GCM auth tag verification fails; transaction rejected as `INVALID`. |
| `encryptDecryptRoundTrip` | Roundtrip cryptographic serialization, hybrid encryption, and decryption. | **Passed** — Plaintext instruction recovered with bit-for-bit fidelity. |
| `sameNonceWithDifferentCiphertextCannotSettleTwice` | Malicious actor encrypts the same nonce under a fresh AES session key. | **Passed** — CAS gate passes, but ledger unique constraint stops the second debit. |
| `firstBridgeWinsBountyAndBroadcastsAckToClearMesh` | 3 bridge nodes race to upload; winning bridge receives ₹0.50; reverse ACK clears mesh. | **Passed** — Winner earns ₹0.50; mesh packet buffer count drops from 4 to 0. |
| `GET /` | Dashboard HTML static serving. | **Passed** — HTTP 200 with complete interactive interface. |
| `GET /api/server-key` | RSA-2048 SPKI public key retrieval. | **Passed** — Base64 DER public key returned for client-side encryption. |
| `GET /api/accounts` | Query seeded demo accounts. | **Passed** — Returns Alice (₹5,000), Bob (₹1,000), Charlie, and Merchant accounts. |
| `full demo lifecycle: send -> gossip -> flush` | End-to-end integration across all endpoints. | **Passed** — Packet created, gossiped across 5 hops, uploaded, and balances updated. |
| `direct POST /api/bridge/ingest` | Direct ingestion validation with bridge headers. | **Passed** — Settles cleanly, drops subsequent replay with 200 OK `DUPLICATE_DROPPED`. |
| `GET /api/bridges/rewards` | Protocol micro-bounty queries. | **Passed** — Accurately returns breakdown of bounties per bridge node. |

---

## 📡 REST API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Serves the interactive web dashboard. |
| `GET` | `/api/server-key` | Retrieves the bank's active 2048-bit RSA SPKI public key. |
| `GET` | `/api/accounts` | Lists current balances for all seeded demo accounts. |
| `GET` | `/api/transactions` | Lists the 20 most recent settled or rejected transactions. |
| `GET` | `/api/bridges/rewards` | Returns total micro-bounties earned by relaying bridge nodes. |
| `POST` | `/api/demo/send` | Offline simulator: creates and encrypts a payment from Alice to Bob. |
| `GET` | `/api/mesh/state` | Returns the current topology, device buffers, and idempotency status. |
| `POST` | `/api/mesh/gossip` | Simulates 1 round of peer-to-peer BLE gossip propagation. |
| `POST` | `/api/mesh/flush` | Triggers all surfaced 4G bridge nodes to upload held packets. |
| `POST` | `/api/mesh/reset` | Resets mesh device buffers, account balances, and idempotency caches. |
| `POST` | `/api/bridge/ingest` | Primary bridge ingestion endpoint (`X-Bridge-Node-Id` authenticated). |

---

## 🔒 Cryptographic Specifications

* **Symmetric Encryption:** AES-256-GCM (Galois/Counter Mode) with 96-bit random IVs and 128-bit authentication tags.
* **Asymmetric Encryption:** RSA-2048 with Optimal Asymmetric Encryption Padding (OAEP) utilizing SHA-256.
* **Hash Digests:** SHA-256 for packet idempotency tagging and PIN hashing.
* **Numeric Precision:** `Decimal.js` used exclusively for balance computations to eliminate floating-point rounding errors.
* **Storage Engine:** SQLite 3 in Write-Ahead Logging (`WAL`) mode with prepared statements to prevent SQL injection.

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
