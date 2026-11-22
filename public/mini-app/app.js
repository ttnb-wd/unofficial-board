const webApp = window.Telegram?.WebApp;
const apiOrigin = window.BOARD_API_ORIGIN ?? '';
const wakeTimeoutMs = 75_000;
const saveTimeoutMs = 50_000;
const feature = new URLSearchParams(window.location.search).get('feature');
const isBudget = feature === 'budget';
const labels = isBudget
  ? { title: 'Create Budget Vote', question: 'Title', choices: 'Amounts (MMK)', add: 'Add amount', remove: 'Remove amount', choice: 'Amount' }
  : { title: 'Create Poll', question: 'Question', choices: 'Answer options', add: 'Add option', remove: 'Remove option', choice: 'Option' };

const form = document.querySelector('#feature-form');
const fields = document.querySelector('#fields');
const question = document.querySelector('#question');
const choices = document.querySelector('#choices');
const add = document.querySelector('#add-choice');
const done = document.querySelector('#done');
const error = document.querySelector('#form-error');
const success = document.querySelector('#success-message');
const maxMmk = 9_223_372_036_854_775_807n;
let pendingBody;
let saveAttempted = false;
let saved = false;
webApp?.BackButton?.onClick(() => webApp.close());
webApp?.BackButton?.show();

function refreshChoiceControls() {
  const count = choices.children.length;
  add.disabled = count >= 10;
  for (const [index, row] of [...choices.children].entries()) {
    const input = row.querySelector('input');
    const remove = row.querySelector('button');
    input.placeholder = `${labels.choice} ${index + 1}`;
    input.setAttribute('aria-label', input.placeholder);
    remove.setAttribute('aria-label', `${labels.remove} ${index + 1}`);
    remove.disabled = count <= 2;
  }
}

function addChoice(value = '') {
  if (choices.children.length >= 10) return;
  const row = document.createElement('div');
  row.className = 'choice-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.required = true;
  input.autocomplete = 'off';
  input.maxLength = isBudget ? 19 : 100;
  if (isBudget) input.inputMode = 'numeric';
  input.value = value;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-button';
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    const next = row.nextElementSibling ?? row.previousElementSibling;
    row.remove();
    refreshChoiceControls();
    next?.querySelector('input').focus();
  });
  row.append(input, remove);
  choices.append(row);
  refreshChoiceControls();
  return input;
}

function showError(message, input) {
  error.textContent = message;
  error.hidden = false;
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = webApp?.colorScheme ?? 'light';
}

applyTheme();
webApp?.onEvent('themeChanged', applyTheme);

if ((feature !== 'poll' && feature !== 'budget') || !webApp?.initData) {
  const launchError = document.querySelector('#launch-error');
  launchError.textContent = 'Open a form from the bot’s private chat in Telegram.';
  launchError.hidden = false;
} else {
  document.querySelector('#page-title').textContent = labels.title;
  document.querySelector('#question-label').textContent = labels.question;
  document.querySelector('#choices-title').textContent = labels.choices;
  question.maxLength = isBudget ? 200 : 300;
  add.textContent = `+ ${labels.add}`;
  if (isBudget) {
    addChoice('10000');
    addChoice('20000');
    addChoice('30000');
  } else {
    addChoice();
    addChoice();
    addChoice();
  }
  form.hidden = false;
  webApp.expand();
}

webApp?.ready();
add.addEventListener('click', () => addChoice()?.focus());
form.addEventListener('input', (event) => {
  event.target.removeAttribute('aria-invalid');
  error.hidden = true;
});

function buildSubmission() {
  error.hidden = true;
  form.querySelector('[aria-invalid]')?.removeAttribute('aria-invalid');

  const title = question.value.trim();
  if (!title) {
    showError(isBudget ? 'Enter a title or question.' : 'Enter a question.', question);
    return;
  }

  const values = [];
  const seenAmounts = new Set();
  for (const input of choices.querySelectorAll('input')) {
    const value = input.value.trim();
    if (isBudget) {
      if (!/^\d{1,19}$/.test(value) || BigInt(value) <= 0n || BigInt(value) > maxMmk) {
        showError('Enter a positive whole MMK amount up to 9,223,372,036,854,775,807.', input);
        return;
      }
      const amount = BigInt(value);
      if (seenAmounts.has(amount)) {
        showError('Enter a different amount for each choice.', input);
        return;
      }
      seenAmounts.add(amount);
    } else if (!value) {
      showError('Enter an answer or remove the empty option.', input);
      return;
    }
    values.push(value);
  }

  return JSON.stringify({
    requestId: crypto.randomUUID(),
    question: title,
    [isBudget ? 'amounts' : 'options']: values,
  });
}

async function waitForApi() {
  const signal = AbortSignal.timeout(wakeTimeoutMs);
  while (!signal.aborted) {
    try {
      const response = await fetch(`${apiOrigin}/healthz`, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal,
      });
      if (response.ok && (await response.json()).status === 'ok') return true;
    } catch {
      // Render's startup response may be HTML or omit CORS headers.
    }
    if (!signal.aborted) {
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }
  }
  return false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (done.disabled || saved) return;
  pendingBody ??= buildSubmission();
  if (!pendingBody) return;

  error.hidden = true;
  fields.disabled = true;
  done.disabled = true;
  try {
    if (apiOrigin) {
      done.textContent = 'Connecting…';
      if (!(await waitForApi())) {
        showError('The server is still waking up. Tap Done to try again.');
        return;
      }
    }
    done.textContent = 'Saving…';
    const endpoint = isBudget ? '/api/budget-votes' : '/api/smart-polls';
    const wasAttempted = saveAttempted;
    saveAttempted = true;
    const response = await fetch(`${apiOrigin}${endpoint}`, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(saveTimeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `tma ${webApp.initData}`,
      },
      body: pendingBody,
    });
    const result = await response.json();
    if (!response.ok) {
      if (!wasAttempted && [400, 403, 413, 415].includes(response.status)) {
        saveAttempted = false;
      }
      showError(result.error ?? 'Could not confirm the save. Tap Done to retry.');
      return;
    }
    if (typeof result.id !== 'string' || typeof result.created !== 'boolean') {
      throw new Error('Unexpected save response.');
    }
    saved = true;
    form.hidden = true;
    success.textContent = result.message ?? (isBudget ? 'Budget vote saved' : 'Poll saved');
    success.hidden = false;
    success.focus();
    window.setTimeout(() => webApp.close(), 1100);
  } catch {
    showError('Could not confirm the save. Tap Done to retry.');
  } finally {
    if (!saved) {
      if (!saveAttempted) pendingBody = undefined;
      fields.disabled = saveAttempted;
      done.disabled = false;
      done.textContent = 'Done';
    }
  }
});
