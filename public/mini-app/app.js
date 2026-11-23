(() => {
  const webApp = window.Telegram?.WebApp;
  const apiOrigin = window.BOARD_API_ORIGIN ?? '';
  const wakeTimeoutMs = 75_000;
  const saveTimeoutMs = 50_000;
  const params = new URLSearchParams(window.location.search);
  const feature = params.get('feature');
  const supported = feature === 'poll' || feature === 'budget';
  if (feature === null || (supported && params.get('view') === 'votes')) return;
  const ui = window.BoardUI;
  const fromVotes = supported && params.get('from') === 'votes';
  const votesPage = `?feature=${feature}&view=votes`;
  const leave = () => {
    if (fromVotes) location.replace('/mini-app' + votesPage);
    else if (!ui.backToBoard()) webApp?.close();
  };
  if (fromVotes) ui.onFeatureBack = leave;
  document.querySelector('#form-hero').hidden = false;
  const isBudget = feature === 'budget';
  const labels = isBudget
    ? { title: 'Group Budget Vote', question: 'Title', choices: 'Amounts (MMK)', add: 'Add amount', remove: 'Remove amount', choice: 'Amount' }
    : { title: 'Create a Poll', question: 'Question', choices: 'Options', add: 'Add option', remove: 'Remove option', choice: 'Option' };

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
  const saveLabel = isBudget ? 'Create Budget Vote' : 'Create Poll';
  function readyButton() {
    done.replaceChildren(ui.icon('send'), document.createTextNode(saveLabel));
  }
  webApp?.BackButton?.onClick(leave);
  if (supported) document.querySelector('#page-title').textContent = labels.title;
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
    if (isBudget) {
      input.inputMode = 'numeric';
      input.className = 'amount-input';
    }
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
    row.append(ui.icon(isBudget ? 'budget' : 'grip', 'choice-icon'), input, remove);
    choices.append(row);
    refreshChoiceControls();
    return input;
  }

  function showError(message, input) {
    error.textContent = message;
    error.hidden = false;
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', error.id);
      input.focus();
    }
  }

  if (!supported || !webApp?.initData) {
    const launchError = document.querySelector('#launch-error');
    launchError.textContent = 'Open a form from the bot’s private chat in Telegram.';
    launchError.hidden = false;
  } else {
    document.querySelector('#question-label').textContent = labels.question;
    document.querySelector('#choices-title').textContent = labels.choices;
    question.maxLength = isBudget ? 200 : 300;
    add.textContent = `+ ${labels.add}`;
    question.placeholder = isBudget ? 'e.g. Weekend trip budget' : 'e.g. Where should we go this weekend?';
    readyButton();
    if (isBudget) {
      addChoice('10000');
      addChoice('20000');
      addChoice('30000');
    } else {
      addChoice();
      addChoice();
    }
    const mine = document.querySelector('#form-my-stuff');
    const mineLabel = isBudget ? 'My Budget Votes' : 'My Polls';
    mine.href = ui.tabUrl('mine');
    mine.append(ui.icon('list'), document.createTextNode(mineLabel));
    mine.hidden = false;
    const votes = document.querySelector('#form-votes');
    votes.href = fromVotes ? '/mini-app' + votesPage : ui.featureUrl(votesPage, ui.returnTab ?? 'home');
    votes.append(ui.icon('check'), document.createTextNode('Voting and results'));
    votes.hidden = false;
    form.hidden = false;
    webApp.expand();
  }

  webApp?.ready();
  add.addEventListener('click', () => addChoice()?.focus());
  form.addEventListener('input', () => {
    const invalid = form.querySelector('[aria-invalid]');
    invalid?.removeAttribute('aria-invalid');
    invalid?.removeAttribute('aria-describedby');
    error.hidden = true;
  });

  function buildSubmission() {
    error.hidden = true;
    const invalid = form.querySelector('[aria-invalid]');
    invalid?.removeAttribute('aria-invalid');
    invalid?.removeAttribute('aria-describedby');

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
          showError('The server is still waking up. Try submitting again.');
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
        showError(result.error ?? 'Could not confirm the save. Try submitting again.');
        return;
      }
      if (typeof result.id !== 'string' || typeof result.created !== 'boolean') {
        throw new Error('Unexpected save response.');
      }
      saved = true;
      form.hidden = true;
      success.replaceChildren(ui.icon('check'), document.createTextNode(
        result.message ?? (isBudget ? 'Budget vote saved' : 'Poll saved'),
      ));
      success.hidden = false;
      success.focus();
      if (!ui.returnTab) window.setTimeout(leave, 1100);
    } catch {
      showError('Could not confirm the save. Try submitting again.');
    } finally {
      if (!saved) {
        if (!saveAttempted) pendingBody = undefined;
        fields.disabled = saveAttempted;
        done.disabled = false;
        readyButton();
      }
    }
  });
})();
