(() => {
  const params = new URLSearchParams(location.search);
  const feature = params.get('feature');
  if (!['poll', 'budget'].includes(feature) || !['votes', 'mine'].includes(params.get('view'))) return;
  const ui = window.BoardUI;
  const { element, icon } = ui;
  const telegram = window.Telegram?.WebApp;
  const kind = feature === 'poll' ? 'poll' : 'bv';
  const title = document.querySelector('#page-title');
  const hero = document.querySelector('#form-hero');
  const intro = hero.querySelector('.hero-intro');
  const root = document.querySelector('#vote-content');
  const error = document.querySelector('#launch-error');
  const id = params.get('id');
  const page = Math.min(9999, Math.max(0, Number.parseInt(params.get('page'), 10) || 0));
  const mine = params.get('view') === 'mine';
  const mineLabel = feature === 'poll' ? 'My Polls' : 'My Budget Votes';
  const browse = `?feature=${feature}&view=${mine ? 'mine' : 'votes'}`;
  const overview = feature === 'poll' ? 'Smart Poll' : 'Group Budget Vote';
  const destination = (path) => ui.returnTab ? ui.featureUrl(path, ui.returnTab) : '/mini-app' + path;
  let busy = false;
  let loading = false;
  let refreshing = false;
  let lastData;
  let editing = false;
  let mutation = 0;

  function button(label, onClick, className) {
    const control = element('button', className, label);
    control.type = 'button';
    control.addEventListener('click', onClick);
    return control;
  }

  function link(label, path) {
    const anchor = element('a', 'secondary-button', label);
    anchor.href = destination(path);
    return anchor;
  }

  function listPath(page) {
    return page > 0 ? `${browse}&page=${page}` : browse;
  }

  function goBack() {
    if (busy) return;
    if (id || page > 0) location.replace(destination(listPath(id ? page : page - 1)));
    else if (!ui.backToBoard()) telegram?.close();
  }

  function notice(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }

  async function request(body) {
    const response = await fetch(`${window.BOARD_API_ORIGIN ?? ''}/api/votes`, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { Authorization: `tma ${telegram.initData}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, ...body }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.error ?? 'Could not reach the voting service. Try again.');
    return data;
  }

  function showPreview(preview) {
    const existing = hero.querySelector('.bill-badge');
    if (existing || !preview) return;
    title.before(element('p', 'bill-badge', 'PRELAUNCH · Simulation'));
  }

  function statusLabel(status) {
    return ({ OPEN: 'Open', CLOSED: 'Closed', DRAFT: 'Saved · Unpublished',
      PUBLISHING: 'Delivery unconfirmed', CANCELLED: 'Cancelled' })[status] ?? status;
  }

  function showList({ records, preview, more }) {
    showPreview(preview);
    intro.textContent = preview ? 'Try a saved ballot in the owner preview.'
      : mine ? 'Open a saved ballot to see its publication status.' : 'Open a published ballot to vote or see the results.';
    const actions = element('section', 'dashboard-card');
    actions.append(element('h2', '', preview ? 'Preview ballots' : mine ? mineLabel : 'Published ballots'));
    for (const record of records) {
      const row = element('a', 'dashboard-row');
      row.href = destination(`${listPath(page)}&id=${encodeURIComponent(record.id)}`);
      row.append(icon(feature), element('strong', 'row-copy', record.title),
        element('span', 'status-chip', preview ? 'Preview' : statusLabel(record.status)),
        icon('next', 'disclosure'));
      actions.append(row);
    }
    if (!records.length) actions.append(element('p', 'dashboard-note', preview ? 'Create a ballot to preview it here.' : mine ? 'No saved ballots on this page.' : 'No published ballots on this page.'));
    if (page > 0 || more) {
      const pages = element('div', 'bill-actions vote-pages');
      if (page > 0) pages.append(link('Previous', listPath(page - 1)));
      if (more) pages.append(link('Next', listPath(page + 1)));
      actions.append(pages);
    }
    const create = link(feature === 'poll' ? 'Create a Poll' : 'Create Budget Vote',
      `?feature=${feature}${ui.returnTab ? '' : `&from=${mine ? 'mine' : 'votes'}`}`);
    const controls = element('div', 'bill-actions');
    controls.append(create);
    controls.append(link(mine ? 'Voting and results' : mineLabel,
      `?feature=${feature}&view=${mine ? 'votes' : 'mine'}`));
    root.replaceChildren(controls, actions);
  }

  function budgetEditor(data) {
    const form = element('form', 'dashboard-card ballot');
    const title = element('input');
    title.required = true;
    title.maxLength = 200;
    title.value = data.title;
    const label = element('label', '', 'Budget title');
    label.append(title);
    const amounts = element('div', 'choice-list');
    function add(value = '') {
      if (amounts.children.length === 10) return;
      const row = element('div', 'choice-row');
      const input = element('input');
      input.required = true;
      input.inputMode = 'numeric';
      input.maxLength = 19;
      input.value = value;
      input.setAttribute('aria-label', 'Amount in MMK');
      row.append(input, button('Remove', () => { if (amounts.children.length > 2) row.remove(); }));
      amounts.append(row);
    }
    data.amounts.forEach(add);
    const submit = element('button', 'primary-button', 'Save Changes');
    submit.type = 'submit';
    form.append(label, amounts, button('Add amount', () => add()), submit, button('Cancel edit', () => {
      editing = false;
      void load();
    }));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = submit.disabled = true;
      mutation++;
      notice();
      try {
        const values = Array.from(amounts.querySelectorAll('input'), (input) => input.value.trim());
        await request({ action: 'editBudget', id, title: title.value.trim(), amounts: values });
        editing = false;
        busy = false;
        await load();
      } catch (failure) {
        notice(failure.message);
      } finally {
        busy = submit.disabled = false;
      }
    });
    return form;
  }

  function showSaved(data) {
    title.textContent = data.title;
    intro.textContent = statusLabel(data.status);
    const card = element('section', 'dashboard-card');
    card.append(element('h2', '', 'Options'));
    for (const choice of data.choices) card.append(element('p', 'dashboard-row', choice.label));
    if (data.status === 'PUBLISHING') {
      card.append(element('p', 'dashboard-note',
        'Telegram may have received the announcement. Check the group and refresh this page. Resending is disabled to prevent a duplicate.'));
    }
    const controls = element('div', 'bill-actions');
    if (data.amounts?.length >= 2) controls.append(button('Edit budget options', () => {
      editing = true;
      root.replaceChildren(budgetEditor(data));
    }));
    if (data.canPublish) {
      const publish = button('Publish to group', async () => {
        if (busy) return;
        busy = publish.disabled = true;
        mutation++;
        notice();
        try {
          const outcome = await request({ action: 'publish', id });
          busy = false;
          await load(outcome.publication === 'published');
          if (outcome.publication !== 'published') notice(outcome.message);
        } catch (failure) {
          notice(failure.message);
        } finally {
          busy = publish.disabled = false;
        }
      }, 'primary-button');
      controls.append(publish);
    }
    controls.append(button('Refresh status', () => void load(), 'secondary-button'));
    controls.append(link(mineLabel, listPath(page)));
    root.replaceChildren(card, controls);
  }

  function resultCard(data, hidden) {
    const card = element('section', 'dashboard-card vote-results');
    card.hidden = hidden;
    const heading = element('h2', '', 'Results');
    heading.tabIndex = -1;
    card.append(heading);
    for (const { label, count } of data.choices) {
      const row = element('div', 'dashboard-row');
      row.append(element('strong', 'row-copy', label));
      if (count !== null) {
        const percent = data.total ? Math.round(1000 * count / data.total) / 10 : 0;
        row.append(element('span', 'status-chip', `${count} · ${percent}%`));
      }
      card.append(row);
    }
    card.append(element('p', 'dashboard-note', `Total voters: ${data.total}`));
    if (data.multiple) card.append(element('p', 'dashboard-note', 'Percentages use total voters.'));
    if (data.choices.some(({ count }) => count === null)) {
      card.append(element('p', 'dashboard-note', 'Answer counts are shown on the original Telegram poll.'));
    }
    return card;
  }

  function ballot(data) {
    const form = element('form', 'ballot');
    const fields = element('fieldset', 'ballot-options');
    fields.append(element('legend', '', data.multiple ? 'Choose one or more answers' : 'Choose one option'));
    const controls = data.choices.map(({ label }, index) => {
      const row = element('label', 'ballot-option');
      const input = element('input');
      input.type = data.multiple ? 'checkbox' : 'radio';
      input.name = 'selection';
      input.checked = Boolean(data.mask & (1 << index));
      const mark = element('span', 'ballot-mark');
      mark.append(icon('check'));
      row.append(input, element('strong', '', label), mark);
      fields.append(row);
      return input;
    });
    const submit = element('button', 'primary-button');
    const saveLabel = data.preview ? 'Submit Preview Vote' : 'Submit Vote';
    submit.type = 'submit';
    submit.append(icon('check'), document.createTextNode(saveLabel));
    const selected = () => controls.reduce((mask, input, index) => input.checked ? mask | (1 << index) : mask, 0);
    submit.disabled = !selected();
    fields.addEventListener('change', () => { editing = true; submit.disabled = !selected(); });
    form.append(fields, submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const mask = selected();
      if (!mask || busy) return;
      busy = fields.disabled = submit.disabled = true;
      mutation++;
      submit.textContent = 'Saving…';
      notice();
      try {
        const updated = await request({ action: 'submit', id, mask });
        editing = false;
        lastData = JSON.stringify(updated);
        showBallot(updated, true);
      } catch (error) {
        notice(error.message);
      } finally {
        busy = fields.disabled = submit.disabled = false;
        submit.replaceChildren(icon('check'), document.createTextNode(saveLabel));
      }
    });
    return form;
  }

  function showBallot(data, submitted = false, showResults = false) {
    title.textContent = data.title;
    showPreview(data.preview);
    const eligible = data.open && (data.preview || data.custom);
    intro.textContent = data.preview ? 'Try the ballot in simulation.'
      : eligible ? 'You can update your vote while voting is open.'
        : data.open ? 'Vote using the original message in Telegram.' : 'Voting is closed.';
    const results = resultCard(data, eligible && !submitted && !showResults);
    const action = button('View results', () => {
      results.hidden = false;
      action.hidden = true;
      results.querySelector('h2').focus();
    });
    const items = [];
    if (submitted) {
      const status = element('p', 'success');
      status.setAttribute('role', 'status');
      status.append(icon('check'), document.createTextNode(data.preview ? 'Simulated vote submitted.' : 'Vote saved.'));
      items.push(status);
    }
    if (eligible) items.push(ballot(data));
    if (data.canClose) items.push(button('Close voting', async () => {
      if (busy || !window.confirm('Close voting for this ballot?')) return;
      busy = true;
      mutation++;
      notice();
      try {
        await request({ action: 'close', id });
        editing = false;
        busy = false;
        await load(true);
      } catch (failure) {
        notice(failure.message);
      } finally {
        busy = false;
      }
    }, 'secondary-button'));
    if (results.hidden) items.push(action);
    items.push(results);
    if (!data.preview) items.push(button('Refresh ballot and results', () => { editing = false; void load(true); }, 'secondary-button'));
    if (data.botUrl) {
      const bot = element('a', 'secondary-button', 'Open in Telegram');
      bot.href = data.botUrl;
      bot.addEventListener('click', ui.openBot);
      items.push(bot);
    }
    root.replaceChildren(...items);
    if (submitted) results.querySelector('h2').focus();
  }

  async function load(showResults = false) {
    if (busy) return;
    const token = ++mutation;
    loading = true;
    notice();
    const indicator = element('p', 'dashboard-card loading-status', 'Loading ballots…');
    indicator.setAttribute('role', 'status');
    root.replaceChildren(indicator);
    try {
      const data = await read();
      if (token === mutation) render(data, showResults);
    } catch (error) {
      if (token !== mutation) return;
      notice(error.message);
      root.replaceChildren(button('Try again', () => void load()));
    } finally {
      if (token === mutation) loading = false;
    }
  }

  function read() {
    return request({ ...(id ? { action: 'detail', id } : { action: 'list', page }), ...(mine ? { mine } : {}) });
  }

  function render(data, showResults = false) {
    lastData = JSON.stringify(data);
    if (id) {
      if (data.status) showSaved(data);
      else showBallot(data, false, showResults);
    } else showList(data);
  }

  ui.refreshVisible(async () => {
    if (!telegram?.initData || loading || refreshing || busy || editing || !lastData) return;
    refreshing = true;
    const token = mutation;
    try {
      const data = await read();
      if (token !== mutation || busy || editing) return;
      if (JSON.stringify(data) !== lastData) render(data, Boolean(root.querySelector('.vote-results:not([hidden])')));
      notice();
    } catch (failure) {
      if (token === mutation && !busy && !editing) notice(failure.message);
    } finally {
      refreshing = false;
    }
  });

  title.textContent = mine ? mineLabel : overview;
  hero.hidden = root.hidden = false;
  ui.onFeatureBack = goBack;
  telegram?.ready();
  if (telegram?.initData) {
    telegram?.BackButton?.onClick(goBack);
    telegram?.BackButton?.show();
    telegram?.expand();
    void load();
  } else {
    notice('Open The Board in Telegram to see ballots and results.');
  }
})();
