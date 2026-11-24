import type { Money } from 'sportsbook-contracts';

const SCALE = 8;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

const toUnits = (amount: string): bigint => {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
};

const fromUnits = (units: bigint): string => {
  const whole = units / SCALE_FACTOR;
  const fraction = (units % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${whole}.${fraction.padEnd(2, '0')}`;
};

/** Integer math on eight decimal places. Floats never touch money. Rounds half up. */
export const commissionOn = (stake: Money, basisPoints: number): Money => {
  const raw = toUnits(stake.amount) * BigInt(basisPoints);
  const units = (raw + 5_000n) / 10_000n;
  return { currency: stake.currency, amount: fromUnits(units) };
};

export interface LedgerRow {
  betId: string;
  accountId: string;
  confirmationRef: string;
  stake: Money;
  commission: Money;
  rateBasisPoints: number;
  recordedAt: string;
}

export interface CommissionLedger {
  /** One row per bet. Recording the same bet again returns the existing row. */
  record(row: Omit<LedgerRow, 'commission' | 'recordedAt'>): Promise<LedgerRow>;
}

export class InMemoryLedger implements CommissionLedger {
  private readonly byBet = new Map<string, LedgerRow>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async record(row: Omit<LedgerRow, 'commission' | 'recordedAt'>): Promise<LedgerRow> {
    const existing = this.byBet.get(row.betId);
    if (existing) return existing;
    const written: LedgerRow = {
      ...row,
      commission: commissionOn(row.stake, row.rateBasisPoints),
      recordedAt: this.now().toISOString(),
    };
    this.byBet.set(row.betId, written);
    return written;
  }

  get rows(): readonly LedgerRow[] {
    return [...this.byBet.values()];
  }
}
