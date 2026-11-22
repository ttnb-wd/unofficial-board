export const MAX_POLL_OPTIONS = 10;

export function validatePollQuestion(value: string): string {
  const question = value.trim();
  if (question.length === 0 || question.length > 300) {
    throw new Error('Question must contain 1 to 300 characters.');
  }
  return question;
}

export function validatePollOption(
  value: string,
  existingOptions: string[],
): string {
  const option = value.trim();
  if (option.length === 0 || option.length > 100) {
    throw new Error('Each answer must contain 1 to 100 characters.');
  }
  if (existingOptions.length >= MAX_POLL_OPTIONS) {
    throw new Error(`A poll can have at most ${MAX_POLL_OPTIONS} answers.`);
  }
  if (
    existingOptions.some(
      (existing) => existing.toLocaleLowerCase() === option.toLocaleLowerCase(),
    )
  ) {
    throw new Error('That answer has already been added.');
  }
  return option;
}
