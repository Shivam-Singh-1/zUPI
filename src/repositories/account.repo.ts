import { getDatabase } from '../config/database.js';
import { Account, AccountRow, toAccountEntity } from '../models/account.entity.js';

export class OptimisticLockError extends Error {
  constructor(vpa: string, expectedVersion: number) {
    super(`Optimistic lock conflict on account '${vpa}' with version ${expectedVersion}`);
    this.name = 'OptimisticLockError';
  }
}

export class AccountRepository {
  public findById(vpa: string): Account | null {
    const db = getDatabase();
    const stmt = db.prepare('SELECT vpa, holder_name, balance, version FROM accounts WHERE vpa = ?');
    const row = stmt.get(vpa) as AccountRow | undefined;
    if (!row) {
      return null;
    }
    return toAccountEntity(row);
  }

  public findAll(): Account[] {
    const db = getDatabase();
    const stmt = db.prepare('SELECT vpa, holder_name, balance, version FROM accounts ORDER BY vpa ASC');
    const rows = stmt.all() as AccountRow[];
    return rows.map(toAccountEntity);
  }

  public save(account: Account): void {
    const db = getDatabase();
    const existing = this.findById(account.vpa);

    if (!existing) {
      const insertStmt = db.prepare(`
        INSERT INTO accounts (vpa, holder_name, balance, version)
        VALUES (?, ?, ?, ?)
      `);
      insertStmt.run(account.vpa, account.holderName, account.balance, account.version ?? 0);
      return;
    }

    const updateStmt = db.prepare(`
      UPDATE accounts
      SET balance = ?, version = version + 1
      WHERE vpa = ? AND version = ?
    `);
    const result = updateStmt.run(account.balance, account.vpa, account.version);

    if (result.changes === 0) {
      throw new OptimisticLockError(account.vpa, account.version);
    }

    // Increment local version to mirror the DB change
    account.version += 1;
  }

  public count(): number {
    const db = getDatabase();
    const stmt = db.prepare('SELECT COUNT(*) as count FROM accounts');
    const row = stmt.get() as { count: number };
    return row.count;
  }
}

export const accountRepository = new AccountRepository();
