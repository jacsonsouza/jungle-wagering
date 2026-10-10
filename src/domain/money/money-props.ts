import { CurrencyCode } from '../shared/currency.js';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: CurrencyCode;
}
