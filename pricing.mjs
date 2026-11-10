// Amounts are collected in whole KES. Round the payable amount up so a
// fractional KES is never silently discarded at the checkout boundary.
export function calculateAmountDue(airtimeAmount, discountPercent) {
  if (!Number.isSafeInteger(airtimeAmount) || airtimeAmount < 1) {
    throw new RangeError('airtimeAmount must be a positive whole KES amount.');
  }
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new RangeError('discountPercent must be between 0 and 100.');
  }

  // Use integer arithmetic to avoid floating-point rounding down whole KES.
  const scale = 1_000_000n;
  const hundredPercent = 100n * scale;
  const rate = BigInt(Math.round(discountPercent * Number(scale)));
  const numerator = BigInt(airtimeAmount) * (hundredPercent - rate);
  return Math.max(1, Number((numerator + hundredPercent - 1n) / hundredPercent));
}

// Daraja callbacks may serialize whole shillings as either 500 or 500.00.
export function parseWholeKes(value) {
  const text = String(value ?? '');
  if (!/^\d+(?:\.0+)?$/.test(text)) return null;
  const amount = Number(text.split('.')[0]);
  return Number.isSafeInteger(amount) ? amount : null;
}
