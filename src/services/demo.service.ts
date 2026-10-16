import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { HybridCryptoService, hybridCryptoService } from '../crypto/hybridCrypto.service.js';
import { ServerKeyHolder, serverKeyHolder } from '../crypto/serverKeyHolder.js';
import { AccountRepository, accountRepository } from '../repositories/account.repo.js';
import { MeshPacket, PaymentInstruction } from '../types/mesh.types.js';

export class DemoService {
  constructor(
    private readonly accounts: AccountRepository = accountRepository,
    private readonly crypto: HybridCryptoService = hybridCryptoService,
    private readonly serverKey: ServerKeyHolder = serverKeyHolder
  ) {}

  public seedAccounts(): void {
    if (this.accounts.count() === 0) {
      this.accounts.save({ vpa: 'alice@demo', holderName: 'Alice', balance: '5000.00', version: 0 });
      this.accounts.save({ vpa: 'bob@demo', holderName: 'Bob', balance: '1000.00', version: 0 });
      this.accounts.save({ vpa: 'carol@demo', holderName: 'Carol', balance: '2500.00', version: 0 });
      this.accounts.save({ vpa: 'dave@demo', holderName: 'Dave', balance: '500.00', version: 0 });
      console.info({ count: 4 }, 'Seeded demo accounts');
    }
  }

  /**
   * Simulates the sender phone offline wallet:
   * 1. Constructs PaymentInstruction with unique nonce and signedAt.
   * 2. Encrypts with server's RSA public key (hybrid RSA+AES).
   * 3. Wraps in MeshPacket with TTL.
   */
  public createPacket(
    senderVpa: string,
    receiverVpa: string,
    amount: string | number,
    pin: string,
    ttl: number = 5
  ): MeshPacket {
    const amountStr = typeof amount === 'number' ? amount.toFixed(2) : String(amount);

    const instruction: PaymentInstruction = {
      senderVpa,
      receiverVpa,
      amount: amountStr,
      pinHash: this.sha256Hex(pin),
      nonce: uuidv4(),
      signedAt: Date.now(),
    };

    const ciphertext = this.crypto.encrypt(instruction, this.serverKey.getPublicKey());

    return {
      packetId: uuidv4(),
      ttl,
      createdAt: Date.now(),
      ciphertext,
    };
  }

  private sha256Hex(input: string): string {
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
  }
}

export const demoService = new DemoService();
