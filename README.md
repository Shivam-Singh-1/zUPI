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
