const DECIMAL_MONEY = /^(0|[1-9]\d*)\.(\d{2})$/;

export function decimalToMinorUnits(value: string): number {
  const match = DECIMAL_MONEY.exec(value);
  if (!match) {
    throw new Error("Money must be a non-negative decimal with exactly two fractional digits.");
  }

  const whole = Number(match[1]);
  const fraction = Number(match[2]);
  const result = whole * 100 + fraction;

  if (!Number.isSafeInteger(result)) {
    throw new Error("Money amount exceeds the safe integer range.");
  }

  return result;
}

export function minorUnitsToDecimal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Minor-unit amount must be a non-negative safe integer.");
  }

  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}
