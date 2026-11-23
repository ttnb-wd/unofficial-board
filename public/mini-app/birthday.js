(() => {
  const telegram = window.Telegram?.WebApp;
  const api = window.BOARD_API_ORIGIN ?? '';
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const ui = window.BoardUI;
  const titles = { upcoming: 'Upcoming Birthdays', preview: 'Group Announcement Preview' };
  const get = (id) => document.getElementById(`birthday-${id}`);
  const form = get('form');
  const month = get('month');
  const day = get('day');
  const fields = get('fields');
  const save = get('save');
  const remove = get('remove');
  const retry = get('retry');
  const dateLabel = new Intl.DateTimeFormat('en', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const monthLabel = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' });
  let busy = false;
  let birthday = null;

  function birthdayUrl(path) {
    return ui.returnTab ? ui.featureUrl(path, ui.returnTab) : '/mini-app' + path;
  }

  function message(id, value = '') {
    const node = get(id);
    node.textContent = value;
    node.hidden = !value;
  }

  function option(value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  month.append(option('', 'Choose month'));
  for (let index = 1; index <= 12; index++) {
    month.append(option(index, monthLabel.format(new Date(Date.UTC(2000, index - 1, 1)))));
  }

  function updateDays(value) {
    const max = month.value ? new Date(Date.UTC(2000, Number(month.value), 0)).getUTCDate() : 0;
    day.replaceChildren(option('', 'Day'));
    for (let index = 1; index <= max; index++) day.append(option(index, index));
    day.value = value && max ? String(Math.min(Number(value), max)) : '';
  }

  function renderBirthday(value) {
    birthday = value;
    get('title').textContent = value ? 'Edit My Birthday' : 'Add My Birthday';
    month.value = value ? String(value.month) : '';
    updateDays(value?.day);
    remove.hidden = !value;
  }

  async function request(action, payload = {}) {
    const response = await fetch(`${api}/api/birthdays`, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(80_000),
      headers: { 'Content-Type': 'application/json', Authorization: `tma ${telegram.initData}` },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new Error(result?.error ?? 'Could not reach Birthday Reminder. Try again.');
    return result;
  }

  async function run(work, loading, canRetry = false) {
    if (busy) return;
    busy = true;
    fields.disabled = save.disabled = remove.disabled = true;
    retry.hidden = true;
    message('error');
    const status = get('status');
    status.classList.add('loading-status');
    message('status', loading);
    try {
      await work();
    } catch (error) {
      message('status');
      message('error', error instanceof Error ? error.message : 'Try again.');
      retry.hidden = !canRetry;
    } finally {
      status.classList.remove('loading-status');
      fields.disabled = save.disabled = remove.disabled = false;
      busy = false;
    }
  }

  function renderItems(items) {
    const content = get('content');
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'bill-row';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const label = document.createElement('p');
      label.className = 'bill-muted';
      label.textContent = dateLabel.format(new Date(Date.UTC(item.year, item.month - 1, item.day)));
      row.append(name, label);
      content.append(row);
    }
    if (!items.length) content.textContent = 'No upcoming birthdays yet.';
  }

  function load() {
    return run(async () => {
      const session = await request('session');
      get('preview').hidden = !session.preview;
      if (view === 'upcoming' || view === 'preview') {
        const result = await request(view);
        if (view === 'preview') get('content').textContent = result.message;
        else renderItems(result.items);
        get('content').hidden = false;
      } else {
        renderBirthday(session.birthday);
        form.hidden = false;
        get('upcoming-link').href = birthdayUrl('/birthday?view=upcoming&parent=birthday');
        get('preview-link').href = birthdayUrl('/birthday?view=preview&parent=birthday');
        get('preview-link').hidden = !session.preview;
        get('views').hidden = false;
      }
      message('status');
    }, 'Connecting…', true);
  }

  month.addEventListener('change', () => updateDays(day.value));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      const result = await request('save', { month: Number(month.value), day: Number(day.value) });
      renderBirthday(result.birthday);
      message('status', 'Birthday saved.');
    }, 'Saving…');
  });
  remove.addEventListener('click', () => {
    if (!birthday || busy) return;
    const confirmRemoval = (confirmed) => {
      if (!confirmed) return;
      void run(async () => {
        await request('remove');
        renderBirthday(null);
        message('status', 'Birthday removed.');
      }, 'Removing…');
    };
    if (telegram?.isVersionAtLeast?.('6.2') && telegram.showConfirm) {
      telegram.showConfirm('Remove your birthday from Birthday Reminder?', confirmRemoval);
    } else {
      confirmRemoval(window.confirm('Remove your birthday from Birthday Reminder?'));
    }
  });

  retry.addEventListener('click', load);
  const back = () => {
    if (Object.hasOwn(titles, view) && params.get('parent') === 'birthday') {
      location.replace(birthdayUrl('/birthday'));
    } else if (!ui.backToBoard()) telegram?.close();
  };
  get('back').addEventListener('click', back);
  telegram?.BackButton?.onClick(back);
  telegram?.BackButton?.show();
  telegram?.ready();
  telegram?.expand();
  if (view === 'upcoming' || view === 'preview') get('title').textContent = titles[view];
  if (telegram?.initData) void load();
  else message('error', 'Open Birthday Reminder from the bot’s private chat in Telegram.');
})();
