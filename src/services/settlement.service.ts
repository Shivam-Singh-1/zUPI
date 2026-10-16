import { Decimal } from 'decimal.js';
import { getDatabase } from '../config/database.js';
import { Transaction } from '../models/transaction.entity.js';
import { PaymentInstruction } from '../types/mesh.types.js';
import { AccountRepository, accountRepository } from '../repositories/account.repo.js';
import { TransactionRepository, transactionRepository } from '../repositories/transaction.repo.js';

export class SettlementService {
  constructor(
    private readonly accounts: AccountRepository = accountRepository,
    private readonly transactions: TransactionRepository = transactionRepository
  ) {}

  /**
   * Executes atomic balance transfer within an immediate SQLite transaction.
   * Enforces nonce uniqueness and optimistic version locking.
   */
  public settle(
    instruction: PaymentInstruction,
    packetHash: string,
    bridgeNodeId: string,
    hopCount: number
  ): Transaction {
    const db = getDatabase();

    const executeSettlement = db.transaction((): Transaction => {
      // 1. Prevent reuse of a previously processed payment nonce
      if (this.transactions.existsByPaymentNonce(instruction.nonce)) {
        throw new Error('DUPLICATE_PAYMENT_NONCE');
      }

      const sender = this.accounts.findById(instruction.senderVpa);
      if (!sender) {
        throw new Error(`Unknown sender VPA: ${instruction.senderVpa}`);
      }

      const receiver = this.accounts.findById(instruction.receiverVpa);
      if (!receiver) {
        throw new Error(`Unknown receiver VPA: ${instruction.receiverVpa}`);
      }

      const amount = new Decimal(instruction.amount);
      if (amount.lte(0)) {
        throw new Error('Amount must be positive');
      }

      const senderBalance = new Decimal(sender.balance);
      const receiverBalance = new Decimal(receiver.balance);

      // Check sufficient funds
      if (senderBalance.lt(amount)) {
        console.warn(
          { senderVpa: sender.vpa, balance: sender.balance, amount: instruction.amount },
          'Insufficient balance — recording REJECTED transaction'
        );
        return this.recordRejected(instruction, packetHash, bridgeNodeId, hopCount);
      }

      // 2. Perform exact decimal balance arithmetic
      sender.balance = senderBalance.minus(amount).toFixed(2);
      receiver.balance = receiverBalance.plus(amount).toFixed(2);

      // 3. Persist updated balances with optimistic locking checks
      this.accounts.save(sender);
      this.accounts.save(receiver);

      // 4. Record settled ledger entry
      const settledTx: Transaction = {
        packetHash,
        paymentNonce: instruction.nonce,
        senderVpa: instruction.senderVpa,
        receiverVpa: instruction.receiverVpa,
        amount: amount.toFixed(2),
        signedAt: new Date(instruction.signedAt).toISOString(),
        settledAt: new Date().toISOString(),
        bridgeNodeId,
        hopCount,
        status: 'SETTLED',
      };

      const savedTx = this.transactions.save(settledTx);

      console.info(
        {
          amount: instruction.amount,
          senderVpa: sender.vpa,
          receiverVpa: receiver.vpa,
          packetHashPreview: packetHash.substring(0, 12),
          bridgeNodeId,
          hopCount,
        },
        'Transaction SETTLED successfully'
      );

      return savedTx;
    });

    return executeSettlement();
  }

  private recordRejected(
    instruction: PaymentInstruction,
    packetHash: string,
    bridgeNodeId: string,
    hopCount: number
  ): Transaction {
    const rejectedTx: Transaction = {
      packetHash,
      paymentNonce: instruction.nonce,
      senderVpa: instruction.senderVpa,
      receiverVpa: instruction.receiverVpa,
      amount: new Decimal(instruction.amount).toFixed(2),
      signedAt: new Date(instruction.signedAt).toISOString(),
      settledAt: new Date().toISOString(),
      bridgeNodeId,
      hopCount,
      status: 'REJECTED',
    };
    return this.transactions.save(rejectedTx);
  }
}

export const settlementService = new SettlementService();
