# Migration Roadmap: Converting UPI Offline Mesh from Spring Boot to TypeScript and Express

> **Target Architecture** · Node.js 20 LTS · TypeScript 5.x · Express 4.x · SQLite (`:memory:`) · `node:crypto`

## 1. Runtime & Ecosystem Translation

Migrating `com.demo.upimesh` from Java 17 / Spring Boot 3.3.5 to TypeScript / Express shifts the execution model from a multi-threaded JVM servlet container to a single-threaded, event-driven Node.js runtime while preserving every cryptographic, concurrency, and transactional invariant of the proof-of-concept.

| Architectural Concern | Spring Boot 3.3.5 / Java 17 (Source) | TypeScript / Express (Target) | Migration Rationale |
| :--- | :--- | :--- | :--- |
| **Web Framework** | `spring-boot-starter-web` (Tomcat) | `express` + `cors` + `helmet` | Lightweight routing, header parsing, and static file serving on port `8080`. |
| **Database Engine** | H2 In-Memory (`jdbc:h2:mem:...`) | `better-sqlite3` (`:memory:`) | Zero-setup, in-process relational database with deterministic transactional semantics. |
| **ORM / Data Access** | Spring Data JPA / Hibernate | `typeorm` or `drizzle-orm` (with SQLite) | Supports entity repositories, `@VersionColumn` optimistic locking, and declarative transactions. |
| **Financial Math** | `java.math.BigDecimal` (`19, 2`) | `decimal.js` (`Decimal`) | Prevents IEEE-754 floating-point drift during rupee/paise debit and credit arithmetic. |
| **Cryptography** | JCA (`javax.crypto`, `java.security`) | Built-in `node:crypto` | Native OpenSSL bindings for RSA-2048 OAEP (`sha256`), AES-256-GCM, and SHA-256 hashing. |
| **Validation** | `spring-boot-starter-validation` | `zod` | Runtime schema validation and static TypeScript type inference for inbound JSON payloads. |
| **Idempotency Cache** | `ConcurrentHashMap<String, Instant>` | Native `Map<string, number>` | Synchronous check-and-set before the first `await` is atomic on the Node.js event loop. |
| **Background Tasks** | `@EnableScheduling` / `@Scheduled` | `setInterval(...).unref()` | Evicts expired idempotency hashes every `60_000` ms without blocking process exit. |
| **Dashboard View** | `spring-boot-starter-thymeleaf` | `express.static` (`public/index.html`) | Serves the existing dark-theme HTML/JS polling UI directly at `GET /`. |
| **Test Suite** | `spring-boot-starter-test` (JUnit 5) | `vitest` + `supertest` | Fast TypeScript execution for unit, cryptographic, and concurrent ingestion tests. |

## 2. Source-to-Target File Mapping

Every class in the 1,450-line Java codebase maps cleanly to a modular TypeScript structure under `src/`.

| Java Source File | Role in Original System | Target TypeScript File | Key Implementation Notes |
| :--- | :--- | :--- | :--- |
| `UpiMeshApplication.java` | Spring Boot entry point | `src/index.ts` & `src/app.ts` | Initializes DB, keys, seed data, scheduler, and starts Express server. |
| `AppConfig.java` | Enables `@Scheduled` tasks | `src/config/env.ts` | Parses environment variables and configures TTL/freshness constants. |
| `ApiController.java` | REST API surface (9 endpoints) | `src/controllers/api.controller.ts` | Express router handling `/api/server-key`, `/api/demo/*`, `/api/mesh/*`, `/api/bridge/*`. |
| `DashboardController.java` | Serves `dashboard.html` at `/` | `src/app.ts` (Static Route) | Serves `public/dashboard.html` on `GET /`. |
| `ServerKeyHolder.java` | RSA-2048 keypair lifecycle | `src/crypto/serverKeyHolder.ts` | Calls `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })` at startup. |
| `HybridCryptoService.java` | RSA-OAEP + AES-256-GCM | `src/crypto/hybridCrypto.service.ts` | Packs/unpacks `[256B RSA-Encrypted Key \| 12B IV \| Ciphertext \| 16B GCM Tag]`. |
| `Account.java` | JPA entity with `@Version` | `src/models/account.entity.ts` | Table `accounts` (`vpa` PK, `holderName`, `balance`, `version`). |
| `Transaction.java` | Immutable settlement ledger | `src/models/transaction.entity.ts` | Table `transactions` with `UNIQUE` constraints on `packetHash` and `paymentNonce`. |
| `MeshPacket.java` | Wire-format POJO | `src/types/mesh.types.ts` | Zod schema + TypeScript interface `{ packetId, ttl, createdAt, ciphertext }`. |
| `PaymentInstruction.java` | Decrypted payload POJO | `src/types/mesh.types.ts` | Interface `{ senderVpa, receiverVpa, amount, pinHash, nonce, signedAt }`. |
| `AccountRepository.java` | Account CRUD | `src/repositories/account.repo.ts` | Queries accounts and executes version-checked balance updates. |
| `TransactionRepository.java` | Transaction CRUD + queries | `src/repositories/transaction.repo.ts` | Implements `existsByPaymentNonce()` and `findTop20ByOrderBySettledAtDesc()`. |
| `DemoService.java` | Account seeding + packet factory | `src/services/demo.service.ts` | Seeds `alice`, `bob`, `carol`, `dave` and constructs encrypted `MeshPacket` objects. |
| `VirtualDevice.java` | Simulated phone node | `src/services/virtualDevice.ts` | Holds device metadata (`id`, `hasInternet`) and a `Map<string, MeshPacket>`. |
| `MeshSimulatorService.java` | Virtual BLE mesh + gossip | `src/services/meshSimulator.service.ts` | Manages the 5 devices, snapshot-based `gossipOnce()`, and `collectBridgeUploads()`. |
| `IdempotencyService.java` | CAS dedup cache + TTL eviction | `src/services/idempotency.service.ts` | Atomic synchronous `claim(hash)` + 60s `evictExpired()` interval. |
| `BridgeIngestionService.java` | Ingestion pipeline orchestrator | `src/services/bridgeIngestion.service.ts` | Coordinates hashing, idempotency claim, decryption, freshness check, and settlement. |
| `SettlementService.java` | Atomic debit/credit | `src/services/settlement.service.ts` | Runs inside an atomic DB transaction with optimistic lock enforcement. |
| `IdempotencyConcurrencyTest.java` | 4 core security tests | `tests/idempotencyConcurrency.test.ts` | Validates simultaneous bridge delivery, tamper rejection, round-trip, and nonce replay. |

## 3. Target Directory Layout

```text
upi-offline-mesh-ts/
├── package.json
├── tsconfig.json
├── Dockerfile
├── public/
│   └── dashboard.html                 # Ported directly from src/main/resources/templates/dashboard.html
├── src/
│   ├── index.ts                       # Bootstrap sequence & server listen
│   ├── app.ts                         # Express app, middleware, CORS, routes
│   ├── config/
│   │   ├── env.ts                     # Port, TTL, max-age, and CORS configuration
│   │   └── database.ts                # SQLite (:memory:) connection & schema initialization
│   ├── types/
│   │   └── mesh.types.ts              # MeshPacket, PaymentInstruction, IngestResult, Zod schemas
│   ├── crypto/
│   │   ├── serverKeyHolder.ts         # In-memory RSA-2048 keypair + SHA-256 fingerprint
│   │   └── hybridCrypto.service.ts    # RSA-OAEP + AES-256-GCM encrypt/decrypt/hash
│   ├── models/
│   │   ├── account.entity.ts          # Account model with version column
│   │   └── transaction.entity.ts      # Transaction model with unique constraints
│   ├── repositories/
│   │   ├── account.repo.ts            # Optimistic-locked account persistence
│   │   └── transaction.repo.ts        # Ledger persistence & nonce lookup
│   ├── services/
│   │   ├── idempotency.service.ts     # In-memory CAS cache + scheduled eviction
│   │   ├── virtualDevice.ts           # Single virtual BLE node state
│   │   ├── meshSimulator.service.ts   # 5-node topology, gossipOnce(), bridge collection
│   │   ├── settlement.service.ts      # Transactional debit/credit engine
│   │   ├── bridgeIngestion.service.ts # 5-step ingestion pipeline
│   │   └── demo.service.ts            # Startup account seeding & demo packet creation
│   └── controllers/
│       └── api.controller.ts          # 9 REST endpoints under /api
└── tests/
    └── idempotencyConcurrency.test.ts # 4 security & concurrency invariant tests
```

## 4. Phase-by-Phase Implementation Plan

### Phase 1: Project Scaffolding & Configuration Setup

Initialize the TypeScript project, configure strict compiler flags, and map `application.properties` into a typed configuration module.

1. **Initialize Dependencies**:
   - Runtime dependencies: `express`, `cors`, `better-sqlite3` (or `typeorm` + `reflect-metadata`), `decimal.js`, `zod`, `uuid`.
   - Development dependencies: `typescript`, `@types/node`, `@types/express`, `@types/cors`, `@types/better-sqlite3`, `@types/uuid`, `tsx`, `vitest`, `supertest`, `@types/supertest`.
2. **Configure `src/config/env.ts`**:
   - Map `server.port` to `process.env.PORT ? Number(process.env.PORT) : 8080`.
   - Map `FRONTEND_ORIGIN` to `process.env.FRONTEND_ORIGIN ?? 'http://localhost:5174'`.
   - Map `upi.mesh.idempotency-ttl-seconds` to `IDEMPOTENCY_TTL_SECONDS = 86400`.
   - Map `upi.mesh.packet-max-age-seconds` to `PACKET_MAX_AGE_SECONDS = 86400`.
   - Define `CLOCK_SKEW_TOLERANCE_SECONDS = 300` for future-dated packet rejection.

### Phase 2: Data Models, SQLite Schema & Optimistic Locking

Replace H2 and Spring Data JPA with an in-memory SQLite database (`new Database(':memory:')`) while preserving both database-level uniqueness constraints and `@Version` optimistic locking.

1. **Define Domain Types & Zod Schemas (`src/types/mesh.types.ts`)**:
   - `MeshPacket`: `{ packetId: string; ttl: number; createdAt: number; ciphertext: string }`.
   - `PaymentInstruction`: `{ senderVpa: string; receiverVpa: string; amount: string; pinHash: string; nonce: string; signedAt: number }` (serialize `amount` as a string or `Decimal` to avoid float imprecision).
   - `IngestOutcome`: `'SETTLED' | 'DUPLICATE_DROPPED' | 'INVALID'`.
   - `IngestResult`: `{ outcome: IngestOutcome; packetHash: string; reason: string | null; transactionId: number | null }`.
2. **Create Database Tables (`src/config/database.ts`)**:
   ```sql
   CREATE TABLE accounts (
     vpa TEXT PRIMARY KEY,
     holder_name TEXT NOT NULL,
     balance TEXT NOT NULL, -- Stored as exact decimal string (scale=2)
     version INTEGER NOT NULL DEFAULT 0
   );

   CREATE TABLE transactions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     packet_hash TEXT NOT NULL UNIQUE,
     payment_nonce TEXT NOT NULL UNIQUE,
     sender_vpa TEXT NOT NULL,
     receiver_vpa TEXT NOT NULL,
     amount TEXT NOT NULL,
     signed_at TEXT NOT NULL,
     settled_at TEXT NOT NULL,
     bridge_node_id TEXT NOT NULL,
     hop_count INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('SETTLED', 'REJECTED'))
   );
   ```
3. **Enforce Optimistic Locking in `AccountRepository`**:
   - When updating an account balance, execute:
     ```sql
     UPDATE accounts
     SET balance = ?, version = version + 1
     WHERE vpa = ? AND version = ?
     ```
   - Inspect `result.changes`. If `changes === 0`, throw an `OptimisticLockError` to roll back the surrounding transaction, matching JPA's `@Version` `OptimisticLockException`.

### Phase 3: Hybrid Cryptography Pipeline (`node:crypto`)

Port `ServerKeyHolder` and `HybridCryptoService` using Node's native `node:crypto` module. Pay special attention to how Java's `AES/GCM/NoPadding` appends the 16-byte authentication tag to the ciphertext automatically, whereas Node's `CipherGCM` handles the authentication tag via explicit `getAuthTag()` and `setAuthTag()` calls.

| Crypto Operation | Java JCA Implementation | Node.js `node:crypto` Implementation |
| :--- | :--- | :--- |
| **RSA Keypair Gen** | `KeyPairGenerator.getInstance("RSA")` (2048-bit) | `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })` |
| **Public Key Export** | `publicKey.getEncoded()` → Base64 X.509 SPKI | `publicKey.export({ type: 'spki', format: 'der' }).toString('base64')` |
| **RSA-OAEP Encrypt** | `RSA/ECB/OAEPWithSHA-256AndMGF1Padding` | `crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey)` |
| **RSA-OAEP Decrypt** | `Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding")` | `crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, encKey)` |
| **AES-256-GCM Encrypt** | `Cipher.getInstance("AES/GCM/NoPadding")`, `GCMParameterSpec(128, iv)` | `crypto.createCipheriv('aes-256-gcm', aesKey, iv)` + `Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()])` |
| **AES-256-GCM Decrypt** | `cipher.doFinal(aesCiphertextWithTag)` | Slice last 16 bytes for `decipher.setAuthTag(tag)`, then `Buffer.concat([decipher.update(ct), decipher.final()])` |
| **Ciphertext Hash** | `MessageDigest.getInstance("SHA-256")` → 64-char hex | `crypto.createHash('sha256').update(ciphertextBuffer).digest('hex')` |

1. **Wire Format Byte Layout**:
   - Bytes `0..255` (256 bytes): RSA-OAEP encrypted 32-byte AES key.
   - Bytes `256..267` (12 bytes): Random GCM initialization vector (`crypto.randomBytes(12)`).
   - Bytes `268..(N-17)`: AES-256-GCM encrypted UTF-8 JSON bytes of `PaymentInstruction`.
   - Bytes `(N-16)..(N-1)` (16 bytes): 128-bit GCM authentication tag.
2. **Tamper Detection**:
   - Before slicing, validate `rawBuffer.length > 256 + 12 + 16`.
   - If any byte in the encrypted key, IV, ciphertext, or tag is modified, `privateDecrypt` or `decipher.final()` throws an error, which `BridgeIngestionService` catches and maps to `INVALID` (`decryption_failed`).

### Phase 4: Idempotency Service & Virtual Mesh Simulation

Port the in-memory deduplication cache and the 5-device Bluetooth gossip simulator.

1. **`IdempotencyService` (`src/services/idempotency.service.ts`)**:
   - Store state in `private readonly seen = new Map<string, number>()` (mapping `packetHash` to epoch milliseconds).
   - `claim(hash: string): boolean`:
     ```typescript
     if (this.seen.has(hash)) {
       return false;
     }
     this.seen.set(hash, Date.now());
     return true;
     ```
     Because JavaScript executes synchronously between `await` points, checking `has()` and calling `set()` synchronously without yielding to the event loop provides the exact same atomic Compare-And-Swap (CAS) guarantee as `ConcurrentHashMap.putIfAbsent` in Java.
   - `evictExpired()`: Iterate over `this.seen.entries()` every 60 seconds via `setInterval` and delete entries where `Date.now() - timestamp > IDEMPOTENCY_TTL_SECONDS * 1000`.
2. **`VirtualDevice` & `MeshSimulatorService`**:
   - Initialize the 5 topological nodes on construction:
     - `phone-alice` (`hasInternet: false`)
     - `phone-stranger1` (`hasInternet: false`)
     - `phone-stranger2` (`hasInternet: false`)
     - `phone-stranger3` (`hasInternet: false`)
     - `phone-bridge` (`hasInternet: true`)
   - `gossipOnce(): number`:
     - Take an immutable snapshot of all packets across all 5 devices at the start of the round (`Map<string, MeshPacket[]>`).
     - For each device and each snapshot packet with `ttl > 0`, copy a clone with `ttl: packet.ttl - 1` to every other device that does not already hold `packetId`.
     - Increment and return the total transfer count.
   - `collectBridgeUploads()`:
     - Filter devices where `hasInternet === true` and return their held packets along with `bridgeNodeId` and computed `hopCount`.

### Phase 5: Ingestion Pipeline & Atomic Settlement Engine

Implement the 5-stage ingestion orchestrator and the transactional settlement service.

1. **`BridgeIngestionService.ingest(packet, bridgeNodeId, hopCount)`**:
   - **Step 1 (Hash)**: Compute `packetHash = hybridCrypto.hashCiphertext(packet.ciphertext)`.
   - **Step 2 (Idempotency Claim)**: Call `idempotencyService.claim(packetHash)`. If `false`, immediately return `{ outcome: 'DUPLICATE_DROPPED', packetHash, reason: 'duplicate_packet_hash', transactionId: null }`.
   - **Step 3 (Decrypt)**: Call `hybridCrypto.decrypt(packet.ciphertext)`. On error, return `{ outcome: 'INVALID', packetHash, reason: 'decryption_failed', transactionId: null }`.
   - **Step 4 (Freshness Check)**: Compute `ageSeconds = (Date.now() - instruction.signedAt) / 1000`.
     - If `ageSeconds > 86400`, return `{ outcome: 'INVALID', packetHash, reason: 'stale_packet', transactionId: null }`.
     - If `ageSeconds < -300`, return `{ outcome: 'INVALID', packetHash, reason: 'future_dated', transactionId: null }`.
   - **Step 5 (Settlement)**: Delegate to `settlementService.settle(instruction, packetHash, bridgeNodeId, hopCount)`. Catch `DUPLICATE_PAYMENT_NONCE` (or SQLite `SQLITE_CONSTRAINT_UNIQUE` on `payment_nonce`) and return `{ outcome: 'DUPLICATE_DROPPED', packetHash, reason: 'duplicate_payment_nonce', transactionId: null }`.
2. **`SettlementService.settle(...)`**:
   - Wrap the entire operation in a synchronous `db.transaction(() => { ... })()` block (using `better-sqlite3` immediate transactions) or TypeORM `dataSource.transaction()`.
   - Verify `transactionRepo.existsByPaymentNonce(instruction.nonce)` is `false`; otherwise throw `new Error('DUPLICATE_PAYMENT_NONCE')`.
   - Load `sender` and `receiver` accounts; throw if either is missing or if `Decimal(instruction.amount).lte(0)`.
   - Compare balances using `new Decimal(sender.balance).gte(new Decimal(instruction.amount))`:
     - If insufficient, insert a `Transaction` record with `status = 'REJECTED'` and return it.
     - If sufficient, subtract `amount` from `sender.balance`, add `amount` to `receiver.balance`, persist both using optimistic locking (`version`), and insert a `Transaction` record with `status = 'SETTLED'`.

### Phase 6: REST API Surface & Dashboard Integration

Expose the 9 REST endpoints in `src/controllers/api.controller.ts` with identical JSON contracts so `dashboard.html` works without modification.

| HTTP Method & Route | Request Contract | Controller Action & Response |
| :--- | :--- | :--- |
| `GET /api/server-key` | None | Returns `{ publicKey: base64Spki, algorithm: 'RSA-OAEP-256 + AES-256-GCM', keySize: 2048 }`. |
| `POST /api/demo/send` | `{ senderVpa, receiverVpa, amount, pin, ttl?, startDevice? }` | Calls `demoService.createAndInjectPacket()`, returns `{ packetId, ciphertextPreview, ttl, injectedAt }`. |
| `GET /api/mesh/state` | None | Returns `{ devices: [...], idempotencyCacheSize: idempotency.size() }`. |
| `POST /api/mesh/gossip` | None | Calls `meshSimulator.gossipOnce()`, returns `{ transfers, devices }`. |
| `POST /api/mesh/flush` | None | Collects bridge packets, runs `await Promise.all(uploads.map(...))`, returns list of `IngestResult`. |
| `POST /api/mesh/reset` | None | Clears all virtual device buffers and calls `idempotency.clear()`. |
| `POST /api/bridge/ingest` | Headers: `X-Bridge-Node-Id`, `X-Hop-Count`; Body: `MeshPacket` | Validates payload via Zod, invokes `bridgeIngestion.ingest()`, returns `IngestResult`. |
| `GET /api/accounts` | None | Returns all 4 seeded accounts (`alice@demo`, `bob@demo`, `carol@demo`, `dave@demo`) with balances. |
| `GET /api/transactions` | None | Returns the latest 20 transactions ordered by `settledAt DESC`. |

### Phase 7: Security Invariant Test Suite & Dockerization

Port `IdempotencyConcurrencyTest.java` to `tests/idempotencyConcurrency.test.ts` using Vitest and package the app with a multi-stage Docker build.

1. **Port the 4 Security Invariant Tests**:
   - **Test 1 (`singlePacketDeliveredByThreeBridgesSettlesExactlyOnce`)**: Create one valid `MeshPacket`, invoke `Promise.all([ingest(pkt, 'bridge-1', 1), ingest(pkt, 'bridge-2', 2), ingest(pkt, 'bridge-3', 3)])`, assert exactly one result has `outcome === 'SETTLED'` and two have `outcome === 'DUPLICATE_DROPPED'`, and verify `alice@demo` decreased by exactly `100.00` and `bob@demo` increased by `100.00`.
   - **Test 2 (`tamperedCiphertextIsRejected`)**: Decode base64 `ciphertext` into a `Buffer`, XOR one byte in the payload region (`buf[buf.length - 20] ^= 0xff`), re-encode to base64, call `ingest()`, and assert `outcome === 'INVALID'` with `reason === 'decryption_failed'`.
   - **Test 3 (`encryptDecryptRoundTrip`)**: Encrypt a `PaymentInstruction` with `hybridCrypto.encrypt()` and decrypt with `hybridCrypto.decrypt()`, asserting deep equality across `senderVpa`, `receiverVpa`, `amount`, `pinHash`, `nonce`, and `signedAt`.
   - **Test 4 (`sameNonceWithDifferentCiphertextCannotSettleTwice`)**: Construct two `PaymentInstruction` payloads sharing the exact same `nonce`, encrypt them separately (producing two distinct ciphertexts and distinct `packetHash` values due to random AES keys and IVs), ingest both, and assert the first settles (`SETTLED`) while the second is dropped (`DUPLICATE_DROPPED` via `DUPLICATE_PAYMENT_NONCE`), moving only `100.00` total.
2. **Multi-Stage `Dockerfile`**:
   ```dockerfile
   # Stage 1: Build TypeScript
   FROM node:20-alpine AS build
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY tsconfig.json ./
   COPY src ./src
   RUN npm run build

   # Stage 2: Production Runtime
   FROM node:20-alpine
   WORKDIR /app
   ENV NODE_ENV=production
   COPY package*.json ./
   RUN npm ci --omit=dev
   COPY --from=build /app/dist ./dist
   COPY public ./public
   EXPOSE 8080
   CMD ["node", "dist/index.js"]
   ```

## 5. Critical Java-to-TypeScript Pitfalls & Mitigations

| Potential Pitfall | Root Cause in Node.js / TypeScript | Required Mitigation |
| :--- | :--- | :--- |
| **Async Race Condition in Idempotency Claim** | If `claim(hash)` performs an `await` (e.g., querying SQLite or Redis) before setting the in-memory lock, concurrent `Promise.all` calls will interleave at the `await` boundary and both pass the check. | Keep `idempotencyService.claim(hash)` 100% synchronous (`Map.has` + `Map.set`) before any `await`, or use `SET NX EX` Lua/atomic command when upgrading to Redis. |
| **AES-GCM Tag Separation** | Java's `Cipher.doFinal()` concatenates `ciphertext || 16-byte tag` automatically, whereas Node's `CipherGCM` keeps the tag separate via `cipher.getAuthTag()`. | Explicitly concatenate `[encryptedKey (256B), iv (12B), ciphertext, authTag (16B)]` during encryption, and slice the trailing 16 bytes for `decipher.setAuthTag()` during decryption. |
| **RSA-OAEP MGF1 Digest Mismatch** | Java's `OAEPWithSHA-256AndMGF1Padding` defaults MGF1 to SHA-1 in some older JCA providers unless `OAEPParameterSpec` specifies MGF1-SHA-256, while Node's `oaepHash: 'sha256'` sets both OAEP and MGF1 to SHA-256. | Configure `oaepHash: 'sha256'` in `crypto.publicEncrypt` and `crypto.privateDecrypt` so both digest functions match the architecture spec (`OAEP with SHA-256 and MGF1-SHA-256`). |
| **Floating-Point Balance Drift** | Using native JS `number` for `BigDecimal` fields can yield `4999.999999999999` on repeated transfers. | Store balances as formatted decimal strings (`"5000.00"`) in SQLite, perform all math via `Decimal` from `decimal.js`, and serialize balances as numbers or strings matching the dashboard's `.toFixed(2)` expectations. |
| **SQLite Transaction Locking under Async I/O** | Async ORMs that share a single SQLite connection across concurrent promises can trigger `SQLITE_BUSY` or nested `BEGIN TRANSACTION` errors. | Use `better-sqlite3` synchronous transactions (`db.transaction(fn)`) for `SettlementService.settle()`, which executes the entire nonce check, balance check, debit/credit, and ledger insert atomically in a single tick. |

## 6. Verification Checklist Before Cutover

- [ ] `GET /api/server-key` returns a valid 2048-bit SPKI Base64 public key and logs its SHA-256 fingerprint on startup.
- [ ] Startup seeds `alice@demo` (₹5000.00), `bob@demo` (₹1000.00), `carol@demo` (₹2500.00), and `dave@demo` (₹500.00).
- [ ] `POST /api/demo/send` injects an encrypted packet into `phone-alice` with `ttl = 4`.
- [ ] `POST /api/mesh/gossip` propagates the packet across all 5 virtual devices in 1 round and decrements `ttl` to `3`.
- [ ] `POST /api/mesh/flush` triggers parallel bridge uploads and settles the payment exactly once.
- [ ] All 4 tests in `tests/idempotencyConcurrency.test.ts` pass via `npm test`.
- [ ] `GET /` renders `dashboard.html` and polls `/api/mesh/state`, `/api/accounts`, and `/api/transactions` every 3 seconds without console errors.
