// -----------------------------------------------------------------------------
// Account Entity
// -----------------------------------------------------------------------------

export interface Account {
  /** Virtual Payment Address (e.g. "alice@demo"). Primary Key. */
  vpa: string;

  /** Human-readable name of account holder. */
  holderName: string;

  /** Balance stored as an exact decimal string (e.g. "5000.00"). */
  balance: string;

  /** Optimistic locking version counter. */
  version: number;
}

export interface AccountRow {
  vpa: string;
  holder_name: string;
  balance: string;
  version: number;
}

export function toAccountEntity(row: AccountRow): Account {
  return {
    vpa: row.vpa,
    holderName: row.holder_name,
    balance: row.balance,
    version: row.version,
  };
}
