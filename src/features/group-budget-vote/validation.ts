export const MAX_BUDGET_RANGES = 10;

export type BudgetRangeInput = {
  minMmk: bigint;
  maxMmk: bigint;
};

export function validateBudgetTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > 200) {
    throw new Error('Budget question must contain 1 to 200 characters.');
  }
  return title;
}

export function parseBudgetRange(value: string): BudgetRangeInput {
  const match = /^\s*(\d{1,15})\s*-\s*(\d{1,15})\s*$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error('Enter one MMK range as minimum-maximum, using whole numbers.');
  }
  const minMmk = BigInt(match[1]);
  const maxMmk = BigInt(match[2]);
  if (minMmk <= 0n || maxMmk <= minMmk) {
    throw new Error('The minimum must be positive and lower than the maximum.');
  }
  return { minMmk, maxMmk };
}

export function validateBudgetRange(
  range: BudgetRangeInput,
  existingRanges: BudgetRangeInput[],
): void {
  if (existingRanges.length >= MAX_BUDGET_RANGES) {
    throw new Error(`A budget vote can have at most ${MAX_BUDGET_RANGES} ranges.`);
  }
  const overlaps = existingRanges.some(
    (existing) =>
      range.minMmk <= existing.maxMmk &&
      range.maxMmk >= existing.minMmk,
  );
  if (overlaps) {
    throw new Error('Budget ranges cannot overlap, including shared endpoints.');
  }
}

export function validateHangoutId(value: string): string | null {
  const hangoutId = value.trim();
  if (hangoutId.toLocaleLowerCase() === 'skip') {
    return null;
  }
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(hangoutId)) {
    throw new Error('Enter a valid hangout ID or reply with "skip".');
  }
  return hangoutId;
}
