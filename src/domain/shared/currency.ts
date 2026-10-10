export const CurrencyCode = {
  BRL: 'BRL',
  USD: 'USD',
} as const;
export type CurrencyCode = (typeof CurrencyCode)[keyof typeof CurrencyCode];
