# zUPI: Offline UPI via Bluetooth Mesh & Opportunistic Settlement 📡

A production-grade, zero-internet payment protocol port built with **TypeScript / Node.js 20+ / Express**.

Enables offline, internet-free digital transactions where encrypted payments hop phone-to-phone via simulated Bluetooth Low Energy (BLE) gossip until an internet-connected bridge node uploads the payment to the backend for idempotent settlement.

---

## 🏗 System Architecture

```text
  [Phone Alice] (Offline)
        │
        │ BLE Gossip (TTL=5)
        ▼
[Phone Stranger 1] ───► [Phone Stranger 2] ───► [Phone Stranger 3]
                                                       │
                                                       │ BLE Gossip
                                                       ▼
                                              [Phone Bridge] (4G Connected)
                                                       │
                                                       │ HTTPS POST /api/bridge/ingest
                                                       ▼
                                         ┌───────────────────────────┐
                                         │ Express Backend           │
                                         │ 1. SHA-256 Hash           │
                                         │ 2. Idempotency Gate (CAS) │
                                         │ 3. Hybrid RSA+AES Decrypt │
                                         │ 4. Freshness Validation   │
                                         │ 5. Atomic Ledger Settle   │
                                         │    (SQLite :memory:)      │
                                         └───────────────────────────┘
```

---

## 🎬 End-to-End Lifecycle & Functioning (Step-by-Step)

### Step 1: Offline Payment Composition & Hybrid Encryption
Alice's phone is in an underground basement with **zero cellular connectivity**. The app creates a cryptographic `PaymentInstruction` and seals it using hybrid encryption before broadcasting.

![Step 1: Offline Encryption](docs/assets/step1-offline-encryption.svg)

- **One-Time Session Key:** Phone generates a random 256-bit AES key and encrypts the payload via **AES-256-GCM** (authenticated encryption).
- **Asymmetric Envelope:** Encrypts only the AES key with the Bank Server's **RSA-2048 Public Key** (cached during an earlier online session).
- **Wire Layout:** Packed into `[256B Encrypted Key | 12B IV | Ciphertext | 16B GCM Tag]` and assigned `TTL = 5`.

---

### Step 2: Peer-to-Peer Bluetooth Mesh Gossip
The encrypted packet hops device-to-device via simulated BLE advertisements. Intermediate phones act as relays without having access to plaintext data.

![Step 2: Mesh Gossip](docs/assets/step2-mesh-gossip.svg)

- **Zero-Trust Relays:** Strangers cannot read the sender/receiver VPA, amount, or PIN.
- **Tamper Rejection:** Any bit flipped in transit invalidates the GCM auth tag, causing the server to reject the packet upon arrival.
- **TTL Decrementing:** Each hop decrements TTL by 1 (`5 → 4 → 3 → 2 → 1`), preventing infinite routing loops.

---

### Step 3: Opportunistic 4G Bridge Upload & Duplicate Storm
When any device in the mesh moves within range of mobile data (4G/5G/Wi-Fi), it acts as an unauthenticated **Bridge Node**, uploading all held packets to the backend.

![Step 3: Bridge Upload](docs/assets/step3-bridge-upload.svg)

- **Concurrent Uploads:** If multiple bridge devices surface simultaneously, they dispatch parallel `POST /api/bridge/ingest` requests containing the identical ciphertext.
- **Header Metadata:** Transmits `X-Bridge-Node-Id` and `X-Hop-Count` for ledger auditing.

---

### Step 4: Atomic CAS Idempotency Gate & Deterministic Settlement
The backend processes inbound requests through a 5-stage verification and settlement pipeline, eliminating double-spending.

![Step 4: Idempotency & Settlement](docs/assets/step4-idempotency-settlement.svg)

- **1. SHA-256 Hash:** Computes `packetHash = SHA-256(ciphertext)`.
- **2. Atomic In-Memory CAS Gate:** The first request acquires the lock synchronously (`claim(hash) === true`). The concurrent duplicate request is dropped in 0ms (`claim(hash) === false` → `DUPLICATE_DROPPED`).
- **3. Decryption & Freshness Check:** Validates `signedAt` timestamp against a 24-hour freshness window.
- **4. Atomic ACID Settlement:** Checks `payment_nonce` uniqueness, executes exact decimal arithmetic (`Decimal.js`), updates optimistic lock version `v+1`, and records a permanent `SETTLED` ledger record.

---

## 🚀 Quick Start

### 1. Install & Test
```bash
npm install
npm test
```

### 2. Run in Development Mode
```bash
npm run dev
```

### 3. Build & Run Production Bundle
```bash
npm run build
npm start
```

Open [http://localhost:8080](http://localhost:8080) to interact with the Live Demo Dashboard.

---

## 🛡 Security Invariants Verified

| Test | Objective | Result |
| :--- | :--- | :--- |
| `singlePacketDeliveredByThreeBridgesSettlesExactlyOnce` | Simulates 3 bridges simultaneously delivering the exact same packet. | **Passed** (1 Settled, 2 Duplicate Dropped, exactly ₹100 transferred). |
| `tamperedCiphertextIsRejected` | Modifies bits inside encrypted ciphertext. | **Passed** (`INVALID` with `decryption_failed`). |
| `encryptDecryptRoundTrip` | Roundtrip encryption/decryption of `PaymentInstruction`. | **Passed** (Exact field and payload integrity). |
| `sameNonceWithDifferentCiphertextCannotSettleTwice` | Re-encryption with fresh AES key but identical nonce. | **Passed** (Second attempt rejected via database unique constraint). |

---

## 📡 REST API Surface

- `GET /` — Serves live demo dashboard
- `GET /api/server-key` — RSA-2048 SPKI Base64 public key
- `POST /api/demo/send` — Encrypts and injects payment packet into the mesh
- `GET /api/mesh/state` — Returns mesh topology, device buffers, and idempotency cache size
- `POST /api/mesh/gossip` — Executes 1 round of Bluetooth gossip propagation
- `POST /api/mesh/flush` — Bridge nodes upload held packets concurrently
- `POST /api/mesh/reset` — Clears device buffers and idempotency cache
- `POST /api/bridge/ingest` — Ingestion endpoint used by bridge nodes
- `GET /api/accounts` — Lists all seeded account balances
- `GET /api/transactions` — Returns last 20 settled/rejected transactions
