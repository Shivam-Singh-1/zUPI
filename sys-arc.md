# System Architecture — UPI Offline Mesh

> **Reverse-engineered from source** · `com.demo.upimesh` · Spring Boot 3.3.5 / Java 17

---

## 1. Executive Summary

This project is a **proof-of-concept backend** that demonstrates how UPI (Unified Payments Interface) payment requests could be relayed between nearby devices in the absence of internet connectivity. The core idea:

1. A sender phone **encrypts** a payment instruction using the server's public key.
2. The encrypted packet **gossips** across a simulated Bluetooth mesh of virtual devices.
3. When any device ("bridge node") regains internet, it **uploads** the packet to the backend.
4. The backend **deduplicates**, **decrypts**, **validates freshness**, and **settles** the payment atomically.

The system solves the "three bridges deliver simultaneously" problem — even if the same encrypted packet arrives from multiple bridge nodes at the same instant, **exactly one** settlement occurs.

---

## 2. High-Level Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────────┐
│                           SENDER PHONE (Simulated)                        │
│                                                                            │
│  PaymentInstruction ──► HybridCryptoService.encrypt() ──► MeshPacket      │
│  (JSON: sender, receiver,    RSA-OAEP + AES-256-GCM         (packetId,    │
│   amount, nonce, signedAt,                                    ttl,         │
│   pinHash)                                                    createdAt,   │
│                                                               ciphertext)  │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │ inject()
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        BLUETOOTH MESH (Simulated)                         │
│                                                                            │
│   phone-alice ◄──► phone-stranger1 ◄──► phone-stranger2                   │
│        │                  │                    │                            │
│        ▼                  ▼                    ▼                            │
│   phone-stranger3 ◄──────────────────► phone-bridge (has 4G)              │
│                                                                            │
│   Gossip Protocol: Each round, every device shares all packets with        │
│   every other device. TTL decremented per hop. TTL=0 → stop forwarding.   │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │ flush() / bridge uploads
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        BACKEND SERVER (Spring Boot)                        │
│                                                                            │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────────────┐  │
│  │   API Layer  │───►│ BridgeIngestion  │───►│   SettlementService     │  │
│  │ (Controller) │    │    Service        │    │   (@Transactional)      │  │
│  └──────────────┘    │                  │    │                          │  │
│                      │ 1. Hash cipher   │    │ 1. Check nonce unique   │  │
│                      │ 2. Idempotency   │    │ 2. Lookup accounts      │  │
│                      │    claim (CAS)   │    │ 3. Check balance        │  │
│                      │ 3. Decrypt       │    │ 4. Debit + Credit       │  │
│                      │ 4. Freshness ✓   │    │ 5. Record transaction   │  │
│                      │ 5. → Settle      │    │ (Optimistic locking)    │  │
│                      └──────────────────┘    └──────────────────────────┘  │
│                              │                                             │
│                      ┌───────┴───────┐                                     │
│                      │ Idempotency   │     ┌──────────────┐                │
│                      │   Service     │     │  H2 Database │                │
│                      │ (ConcurrentHashMap) │  (in-memory) │                │
│                      └───────────────┘     └──────────────┘                │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Package Structure

```
com.demo.upimesh
├── UpiMeshApplication.java            # Spring Boot entry point
│
├── config/
│   └── AppConfig.java                 # @EnableScheduling for idempotency TTL eviction
│
├── controller/
│   ├── ApiController.java             # REST API surface (/api/**)
│   └── DashboardController.java       # Thymeleaf view controller (/ → dashboard)
│
├── crypto/
│   ├── ServerKeyHolder.java           # RSA-2048 keypair (generated on startup)
│   └── HybridCryptoService.java       # RSA-OAEP + AES-256-GCM encrypt/decrypt
│
├── model/
│   ├── Account.java                   # JPA entity — simulated bank account
│   ├── AccountRepository.java         # Spring Data JPA repository
│   ├── MeshPacket.java                # POJO — the over-the-wire packet
│   ├── PaymentInstruction.java        # POJO — decrypted payment payload
│   ├── Transaction.java               # JPA entity — settlement record
│   └── TransactionRepository.java     # Spring Data JPA repository
│
├── service/
│   ├── DemoService.java               # Seeds accounts + simulates sender phone
│   ├── MeshSimulatorService.java      # Virtual Bluetooth mesh + gossip
│   ├── VirtualDevice.java             # One simulated phone in the mesh
│   ├── BridgeIngestionService.java    # Orchestrates ingestion pipeline
│   ├── IdempotencyService.java        # In-memory CAS dedup cache
│   └── SettlementService.java         # Atomic debit/credit + transaction record
│
└── (test)
    └── IdempotencyConcurrencyTest.java  # 4 tests covering core security invariants
```

---

## 4. Data Models

### 4.1 `MeshPacket` — The Wire Format

Not persisted. This is what hops phone-to-phone via Bluetooth.

| Field        | Type     | Purpose                                                       |
|-------------|----------|---------------------------------------------------------------|
| `packetId`  | `String` | UUID — used by intermediate devices for gossip-level dedup    |
| `ttl`       | `int`    | Hops remaining; decremented each hop, 0 = stop forwarding    |
| `createdAt` | `Long`   | Epoch millis — when the sender created the packet             |
| `ciphertext`| `String` | Base64-encoded hybrid-encrypted `PaymentInstruction`          |

> **Design decision**: Outer fields (`packetId`, `ttl`, `createdAt`) are **unencrypted** because intermediate devices need them for routing/dedup. The server does **not** trust these fields — idempotency is keyed on the SHA-256 of the `ciphertext`, not on `packetId`.

### 4.2 `PaymentInstruction` — The Decrypted Payload

Exists only in memory after decryption. Never stored as plaintext.

| Field         | Type         | Purpose                                              |
|--------------|-------------|------------------------------------------------------|
| `senderVpa`  | `String`    | e.g. `alice@demo` — the payer's VPA                  |
| `receiverVpa`| `String`    | e.g. `bob@demo` — the payee's VPA                    |
| `amount`     | `BigDecimal`| Payment amount                                        |
| `pinHash`    | `String`    | SHA-256 hex of the UPI PIN (simulated)                |
| `nonce`      | `String`    | UUID — unique per payment intent (replay protection)  |
| `signedAt`   | `Long`      | Epoch millis — freshness window anchor                |

### 4.3 `Account` — JPA Entity

Stored in H2 (`accounts` table). Seeded on startup with 4 demo users.

| Field        | Type         | Notes                                             |
|-------------|-------------|---------------------------------------------------|
| `vpa`       | `String` PK | Virtual Payment Address                            |
| `holderName`| `String`    | Display name                                       |
| `balance`   | `BigDecimal` | `precision=19, scale=2`                           |
| `version`   | `Long`      | `@Version` — JPA optimistic locking               |

### 4.4 `Transaction` — JPA Entity

Stored in H2 (`transactions` table). Immutable once written.

| Field          | Type                    | Notes                                             |
|---------------|------------------------|---------------------------------------------------|
| `id`          | `Long` (auto-gen)      | Primary key                                        |
| `packetHash`  | `String` (unique, 64)  | SHA-256 hex of ciphertext — **idempotency key**   |
| `paymentNonce`| `String` (unique, 36)  | From `PaymentInstruction.nonce` — replay protection|
| `senderVpa`   | `String`               |                                                    |
| `receiverVpa` | `String`               |                                                    |
| `amount`      | `BigDecimal`           |                                                    |
| `signedAt`    | `Instant`              | When sender signed offline                         |
| `settledAt`   | `Instant`              | When backend processed                             |
| `bridgeNodeId`| `String`               | Which device delivered                             |
| `hopCount`    | `int`                  | How many hops it took                              |
| `status`      | `SETTLED` or `REJECTED`| Enum                                               |

**Two unique constraints** act as defense-in-depth at the database level:
- `packetHash` — prevents identical ciphertexts from settling twice.
- `paymentNonce` — prevents replay with re-encrypted identical instructions.

---

## 5. Encryption Pipeline (Hybrid Crypto)

### Why Hybrid?

RSA-2048 can only encrypt ~245 bytes. A `PaymentInstruction` JSON may exceed that. The solution mirrors TLS/PGP/Signal:

```
                    Sender Side                          Server Side
                    ──────────                           ───────────
PaymentInstruction
    │
    ▼ JSON serialize
 plaintext bytes
    │
    ├──► AES-256-GCM encrypt ──► aesCiphertext + tag
    │    (random IV, random key)
    │
    └──► RSA-OAEP encrypt(AES key) ──► encryptedKey

 Wire format (base64):
 ┌─────────────────┬──────────┬────────────────────┐
 │ encryptedAesKey  │   IV     │ aesCiphertext+tag  │
 │   (256 bytes)    │ (12 B)  │  (variable)         │
 └─────────────────┴──────────┴────────────────────┘
         │
         ▼ Decryption reverses the process
    RSA-OAEP decrypt → AES key
    AES-GCM decrypt + authenticate → plaintext
    JSON deserialize → PaymentInstruction
```

### Key Details

| Parameter          | Value                                    |
|-------------------|------------------------------------------|
| RSA Key Size      | 2048-bit                                  |
| RSA Padding       | OAEP with SHA-256 and MGF1-SHA-256        |
| AES Key Size      | 256-bit                                   |
| AES Mode          | GCM (Galois/Counter Mode)                 |
| GCM IV            | 12 bytes (random per packet)              |
| GCM Tag           | 128-bit (16 bytes)                        |
| Encrypted Key Size| 256 bytes (for 2048-bit RSA)              |

### Tamper Detection

AES-GCM is **authenticated encryption**. If any single bit of the ciphertext is modified, `doFinal()` throws `AEADBadTagException`. This is why untrusted intermediates can safely relay packets — they can hold the ciphertext but cannot forge or modify it.

### Idempotency Hashing

```java
SHA-256(ciphertext_bytes) → 64-char hex string
```

The ciphertext hash (not `packetId`) is the idempotency key because:
- Intermediates **can** rewrite `packetId` (it's an outer unencrypted field).
- Intermediates **cannot** forge a valid ciphertext for a different payload.
- Two copies of the same packet have **identical** ciphertexts → identical hashes.

---

## 6. Mesh Simulation

### Device Topology

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ phone-alice  │◄──►│ phone-stranger1   │◄──►│ phone-stranger2   │
│ (offline)    │     │ (offline)         │     │ (offline)         │
└─────┬───────┘     └────────┬─────────┘     └────────┬─────────┘
      │                      │                         │
      ▼                      ▼                         ▼
┌─────────────────┐     ┌──────────────────────────────────────┐
│ phone-stranger3 │◄──►│ phone-bridge                          │
│ (offline)        │     │ (HAS INTERNET — 4G)                  │
└─────────────────┘     └──────────────────────────────────────┘
```

5 virtual devices: 4 offline phones + 1 bridge node with internet.

### Gossip Protocol

Each call to `gossipOnce()`:

1. **Snapshot** all packets on all devices at the start of the round (prevents multi-hop in a single round).
2. For each device, for each packet with `TTL > 0`:
   - Copy to every other device that doesn't already hold it.
   - Decrement TTL on the copy.
3. Packets at `TTL = 0` are retained but **not forwarded**.

This is an **all-to-all** gossip round — equivalent to fast-forwarding many rounds of pairwise BLE gossip.

### Bridge Flush

`collectBridgeUploads()` gathers every packet held by every device where `hasInternet == true`. The controller then uploads them **in parallel** (`parallelStream`) to exercise the concurrent idempotency path.

---

## 7. Ingestion Pipeline (`BridgeIngestionService`)

This is the critical path — the orchestrator that processes every inbound packet:

```
ingest(MeshPacket, bridgeNodeId, hopCount)
    │
    ▼
1. Hash the ciphertext  ──────────────────────────► SHA-256 hex
    │
    ▼
2. Idempotency claim(hash)  ──────────────────────► ConcurrentHashMap.putIfAbsent
    │                                                 ├─ null → first caller (proceed)
    │                                                 └─ non-null → DUPLICATE_DROPPED
    ▼
3. Decrypt ciphertext  ───────────────────────────► RSA-OAEP → AES-GCM → PaymentInstruction
    │                                                 └─ Exception → INVALID (decryption_failed)
    ▼
4. Freshness check  ──────────────────────────────► age = now - signedAt
    │                                                 ├─ > 86400s → INVALID (stale_packet)
    │                                                 └─ < -300s  → INVALID (future_dated)
    ▼
5. Settlement  ───────────────────────────────────► SettlementService.settle()
    │                                                 ├─ Success → SETTLED
    │                                                 └─ DUPLICATE_PAYMENT_NONCE → DUPLICATE_DROPPED
    ▼
6. Return IngestResult(outcome, packetHash, reason, transactionId)
```

### `IngestResult` (Java Record)

| Outcome            | When                                             |
|-------------------|--------------------------------------------------|
| `SETTLED`         | Payment debit + credit completed successfully     |
| `DUPLICATE_DROPPED`| Ciphertext hash already claimed OR nonce reused  |
| `INVALID`         | Decryption failed, stale packet, or future-dated  |

---

## 8. Settlement Engine (`SettlementService`)

Wrapped in `@Transactional` — either **both** debit and credit happen, or neither does.

```
settle(instruction, packetHash, bridgeNodeId, hopCount)
    │
    ▼
1. Check paymentNonce uniqueness  ──────► existsByPaymentNonce()
    │                                       └─ true → throw "DUPLICATE_PAYMENT_NONCE"
    ▼
2. Lookup sender account  ──────────────► findById(senderVpa)
    │                                       └─ not found → throw IllegalArgumentException
    ▼
3. Lookup receiver account  ────────────► findById(receiverVpa)
    │                                       └─ not found → throw IllegalArgumentException
    ▼
4. Validate amount > 0
    │
    ▼
5. Check sender balance ≥ amount
    │  ├─ No  → Record REJECTED transaction, return
    │  └─ Yes → Continue
    ▼
6. Debit sender, Credit receiver  ──────► accounts.save(sender), accounts.save(receiver)
    │                                       └─ @Version (optimistic lock) prevents lost updates
    ▼
7. Record Transaction (SETTLED)  ───────► transactions.save(tx)
    │
    ▼
8. Return Transaction
```

### Concurrency Safety — Three Layers of Defense

| Layer | Mechanism | What it prevents |
|-------|-----------|-----------------|
| **1. Idempotency Cache** | `ConcurrentHashMap.putIfAbsent` (atomic CAS) | Duplicate ciphertext delivery (same packet from multiple bridges) |
| **2. Payment Nonce (DB)** | `UNIQUE` constraint on `Transaction.paymentNonce` | Re-encrypted replays (same logical payment, different ciphertext) |
| **3. Optimistic Locking** | `@Version` on `Account` entity | Lost-update race conditions on concurrent balance modifications |

---

## 9. Idempotency Service

```java
Map<String, Instant> seen = new ConcurrentHashMap<>();
```

| Method   | Semantics                                                    |
|---------|--------------------------------------------------------------|
| `claim(hash)` | `putIfAbsent(hash, now)` — returns `true` for first caller only (atomic) |
| `evictExpired()` | `@Scheduled(fixedDelay = 60_000)` — removes entries older than TTL |
| `clear()` | Test/demo reset                                             |
| `size()` | For dashboard display                                        |

**Production note**: This would be replaced by Redis `SETNX` + TTL for multi-instance deployments. The semantics are identical.

---

## 10. REST API Surface

All endpoints under `/api`, CORS configured for `${FRONTEND_ORIGIN:http://localhost:5174}`.

### Key Endpoints

| Method | Path                 | Purpose                                                   |
|--------|---------------------|-----------------------------------------------------------|
| `GET`  | `/api/server-key`   | Returns server's RSA public key (base64) + algorithm info |
| `POST` | `/api/demo/send`    | Simulates sender: creates encrypted packet, injects into mesh |
| `GET`  | `/api/mesh/state`   | Returns all devices, their packet counts, and cache size  |
| `POST` | `/api/mesh/gossip`  | Runs one gossip round, returns transfer count             |
| `POST` | `/api/mesh/flush`   | All bridge nodes upload packets in parallel to backend    |
| `POST` | `/api/mesh/reset`   | Clears all device packets + idempotency cache             |
| `POST` | `/api/bridge/ingest`| **Production endpoint** — accepts a `MeshPacket` from a real bridge |
| `GET`  | `/api/accounts`     | Lists all accounts with balances                          |
| `GET`  | `/api/transactions` | Returns last 20 transactions (newest first)               |

### `POST /api/bridge/ingest` — The Production Endpoint

```
Headers:
  X-Bridge-Node-Id: string (default: "unknown")
  X-Hop-Count: int (default: 0)

Body: MeshPacket JSON
  { packetId, ttl, createdAt, ciphertext }

Response: IngestResult JSON
  { outcome, packetHash, reason, transactionId }
```

### `POST /api/demo/send` — Demo Helper

```
Body:
  { senderVpa, receiverVpa, amount, pin, ttl?, startDevice? }

Response:
  { packetId, ciphertextPreview, ttl, injectedAt }
```

---

## 11. Frontend Dashboard

Single Thymeleaf-served HTML page at `/` (`dashboard.html`).

### UI Sections

```
┌─────────────────────────────────────────────────────────┐
│  Demo Flow Controls                                      │
│  Step 1: Compose payment (sender, receiver, amount, PIN) │
│  Step 2: Run Gossip Round                                │
│  Step 3: Bridges Upload to Backend                       │
│  [Reset Mesh + Cache]                                    │
├─────────────────────────┬───────────────────────────────┤
│  Mesh Devices            │  Account Balances              │
│  (live device state)     │  (VPA, holder, balance)        │
├─────────────────────────┴───────────────────────────────┤
│  Transaction Ledger                                      │
│  (ID, From, To, Amount, Status, Bridge, Hops, Settled)   │
├─────────────────────────────────────────────────────────┤
│  Activity Log                                            │
│  (timestamped event stream)                              │
└─────────────────────────────────────────────────────────┘
```

### Client-side Behavior

- **Auto-refresh**: `setInterval(refresh, 3000)` polls `/api/mesh/state`, `/api/accounts`, `/api/transactions` every 3 seconds.
- **Action buttons** call `fetch()` to the respective API endpoints and append results to the activity log.
- **Dark theme** with GitHub-inspired colors (`#0d1117`, `#161b22`, `#30363d`).

---

## 12. Configuration

Defined in `application.properties`:

| Property                              | Default   | Purpose                                     |
|--------------------------------------|-----------|---------------------------------------------|
| `server.port`                        | `8080`    | HTTP port                                    |
| `spring.datasource.url`             | H2 mem    | In-memory database (zero setup)              |
| `spring.jpa.hibernate.ddl-auto`     | `create-drop` | Schema recreated on each restart         |
| `spring.h2.console.enabled`         | `true`    | H2 web console at `/h2-console`              |
| `upi.mesh.idempotency-ttl-seconds`  | `86400`   | How long a packet hash stays in the cache (24h) |
| `upi.mesh.packet-max-age-seconds`   | `86400`   | Maximum age for a valid packet (24h)         |

---

## 13. Startup Sequence

```
1. Spring Boot starts (UpiMeshApplication.main)
2. @Configuration AppConfig enables @Scheduled tasks
3. @PostConstruct ServerKeyHolder.init()
   └─ Generates RSA-2048 keypair (logged with fingerprint)
4. @PostConstruct DemoService.seedAccounts()
   └─ Creates 4 accounts: alice(₹5000), bob(₹1000), carol(₹2500), dave(₹500)
5. MeshSimulatorService constructor
   └─ Creates 5 VirtualDevices (4 offline + 1 bridge)
6. IdempotencyService.evictExpired() scheduled every 60s
7. Server listens on port 8080
   └─ Dashboard at /
   └─ REST API at /api/**
   └─ H2 Console at /h2-console
```

---

## 14. Testing Strategy

Single test class: `IdempotencyConcurrencyTest.java` — 4 tests targeting the most critical security invariants:

### Test 1: `singlePacketDeliveredByThreeBridgesSettlesExactlyOnce`

| Aspect     | Detail                                                    |
|-----------|-----------------------------------------------------------|
| **Setup** | One packet, 3 threads, `CountDownLatch` for simultaneous start |
| **Assert**| Exactly 1 `SETTLED`, exactly 2 `DUPLICATE_DROPPED`        |
| **Assert**| Balance moved by exactly ₹100 (not ₹200 or ₹300)         |
| **Why**   | Validates the core concurrency guarantee of the system     |

### Test 2: `tamperedCiphertextIsRejected`

| Aspect     | Detail                                               |
|-----------|------------------------------------------------------|
| **Setup** | Create valid packet, flip one byte in ciphertext      |
| **Assert**| Result outcome is `INVALID`                           |
| **Why**   | Validates AES-GCM authentication detects tampering    |

### Test 3: `encryptDecryptRoundTrip`

| Aspect     | Detail                                               |
|-----------|------------------------------------------------------|
| **Setup** | Encrypt a `PaymentInstruction`, then decrypt          |
| **Assert**| All fields match original                             |
| **Why**   | Validates the hybrid crypto pipeline end-to-end       |

### Test 4: `sameNonceWithDifferentCiphertextCannotSettleTwice`

| Aspect     | Detail                                                    |
|-----------|-----------------------------------------------------------|
| **Setup** | Two instructions with **same nonce**, encrypted separately (different ciphertexts due to random AES key/IV) |
| **Assert**| First settles, second is **not** `SETTLED`                |
| **Assert**| Balance moved by exactly ₹100 (not ₹200)                 |
| **Why**   | Validates nonce-based replay protection even when idempotency cache doesn't catch it (different hashes) |

---

## 15. Deployment

### Docker

`Dockerfile` uses a **multi-stage build**:

```
Stage 1 (build): eclipse-temurin:17-jdk
  → Copy Maven wrapper + POM → resolve dependencies offline
  → Copy source → package (skip tests)

Stage 2 (runtime): eclipse-temurin:17-jre
  → Copy JAR from stage 1
  → EXPOSE 8080
  → java -Dserver.port=${PORT:-8080} -jar app.jar
```

The `PORT` environment variable override supports platforms like Heroku/Cloud Run that assign dynamic ports.

---

## 16. Security Analysis

### What's Protected

| Threat                        | Mitigation                                          |
|------------------------------|-----------------------------------------------------|
| Eavesdropping on mesh        | Hybrid encryption (RSA-OAEP + AES-256-GCM)          |
| Ciphertext tampering         | AES-GCM authentication tag (128-bit)                 |
| Duplicate delivery           | Idempotency cache (SHA-256 of ciphertext) + DB unique constraint |
| Replay attack (re-encrypted) | `paymentNonce` unique constraint at DB level         |
| Stale packet replay          | Freshness window (86400s default, 300s clock-skew tolerance) |
| Balance corruption           | `@Transactional` + `@Version` optimistic locking     |
| Outer field tampering         | Server ignores `packetId`; uses ciphertext hash instead |

### Known Limitations (Acknowledged in README)

| Gap                                  | Note                                              |
|--------------------------------------|--------------------------------------------------|
| No real UPI PIN verification         | `pinHash` recorded but not verified against bank  |
| No sender authentication             | Bridge requests are unauthenticated               |
| Simulated mesh only                  | No real BLE/Bluetooth communication               |
| In-memory idempotency                | Would need Redis for multi-instance deployment    |
| Single-instance only                 | No distributed coordination                       |
| RSA key regenerated on restart       | No key persistence (by design for demo)           |

---

## 17. Dependency Map

```
pom.xml dependencies:
├── spring-boot-starter-web         → REST APIs + embedded Tomcat
├── spring-boot-starter-thymeleaf   → Server-side HTML rendering
├── spring-boot-starter-data-jpa    → JPA / Hibernate ORM
├── h2                              → In-memory SQL database (runtime)
├── spring-boot-starter-validation  → Jakarta Bean Validation
├── jackson-databind                → JSON serialization/deserialization
└── spring-boot-starter-test        → JUnit 5 + Spring Test Context
```

---

## 18. Data Flow — Complete End-to-End Trace

```
User clicks "Inject into Mesh" on dashboard
    │
    ▼
POST /api/demo/send { senderVpa, receiverVpa, amount, pin, ttl, startDevice }
    │
    ▼
DemoService.createPacket()
    ├─ Build PaymentInstruction(sender, receiver, amount, sha256(pin), UUID nonce, now)
    ├─ HybridCryptoService.encrypt(instruction, serverPublicKey)
    │   ├─ Generate random AES-256 key
    │   ├─ AES-GCM encrypt JSON payload → aesCiphertext
    │   ├─ RSA-OAEP encrypt AES key → encryptedAesKey
    │   └─ Pack [encryptedAesKey | IV | aesCiphertext] → base64
    └─ Wrap in MeshPacket(UUID packetId, ttl, now, ciphertext)
    │
    ▼
MeshSimulatorService.inject("phone-alice", packet)
    └─ phone-alice.hold(packet)
    │
    ▼ (User clicks "Gossip")
    │
MeshSimulatorService.gossipOnce()
    ├─ Snapshot all devices
    └─ For each packet with TTL > 0, copy to all other devices (TTL - 1)
       → After 1 round: all 5 devices hold the packet
    │
    ▼ (User clicks "Bridges Upload")
    │
MeshSimulatorService.collectBridgeUploads()
    └─ Returns packets from phone-bridge (the only device with internet)
    │
    ▼ (parallel upload)
    │
BridgeIngestionService.ingest(packet, "phone-bridge", hopCount)
    ├─ crypto.hashCiphertext(ciphertext) → packetHash
    ├─ idempotency.claim(packetHash) → true (first time)
    ├─ crypto.decrypt(ciphertext) → PaymentInstruction
    ├─ Freshness check passes
    └─ settlement.settle(instruction, packetHash, bridgeNodeId, hopCount)
        ├─ Check nonce not already used
        ├─ Load sender + receiver accounts
        ├─ sender.balance -= amount
        ├─ receiver.balance += amount
        ├─ Save both accounts
        └─ Save Transaction(SETTLED)
    │
    ▼
Dashboard refreshes → shows updated balances + transaction record
```

---

## 19. File Reference Index

| File | Role | Lines |
|------|------|-------|
| `UpiMeshApplication.java` | Spring Boot entry point | 21 |
| `AppConfig.java` | Enables `@Scheduled` | 10 |
| `ApiController.java` | REST surface (9 endpoints) | 178 |
| `DashboardController.java` | Serves Thymeleaf dashboard | 14 |
| `ServerKeyHolder.java` | RSA-2048 keypair lifecycle | 52 |
| `HybridCryptoService.java` | Encrypt / Decrypt / Hash | 145 |
| `Account.java` | JPA entity (optimistic lock) | 47 |
| `MeshPacket.java` | Wire-format POJO | 48 |
| `PaymentInstruction.java` | Decrypted payload POJO | 57 |
| `Transaction.java` | JPA entity (immutable ledger) | 95 |
| `AccountRepository.java` | Spring Data JPA | 7 |
| `TransactionRepository.java` | Spring Data JPA (with queries) | 12 |
| `DemoService.java` | Account seeding + packet factory | 84 |
| `MeshSimulatorService.java` | Virtual BLE mesh + gossip | 132 |
| `VirtualDevice.java` | Simulated phone | 49 |
| `BridgeIngestionService.java` | Ingestion pipeline orchestrator | 103 |
| `IdempotencyService.java` | CAS dedup cache + TTL eviction | 58 |
| `SettlementService.java` | Atomic debit/credit | 104 |
| `IdempotencyConcurrencyTest.java` | 4 security-critical tests | 165 |
| `dashboard.html` | Interactive demo UI | 244 |
| `application.properties` | Config | 26 |
| `pom.xml` | Maven build (7 dependencies) | 77 |
| `Dockerfile` | Multi-stage Docker build | 17 |

**Total source**: ~1,450 lines across 18 Java files + 1 HTML + 1 properties + 1 POM + 1 Dockerfile.
