(() => {
  if (new URLSearchParams(location.search).has('feature')) return;
  const ui = window.BoardUI;
  const { tabs, features, element, icon, tabUrl, featureUrl } = ui;
  const telegram = window.Telegram?.WebApp;
  const backButton = telegram?.initData ? telegram.BackButton : null;
  const get = (id) => document.getElementById(id);
  const home = get('board-home');
  const nav = get('board-nav');
  const sheet = get('quick-sheet');
  const status = get('dashboard-status');
  const retry = get('dashboard-retry');
  const labels = { home: 'Home', activity: 'Activity', create: 'Create', mine: 'My Stuff', more: 'More' };
  const quick = [
    ['Create a poll', 'poll', '?feature=poll'],
    ['Split a bill', 'bill-splitter', '/bills?view=create'],
    ['Plan a hangout', 'one-tap-hangout', '/hangout?view=create'],
  ];
  const yangonDateTime = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Yangon', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const birthdayDate = new Intl.DateTimeFormat('en', { timeZone: 'UTC', month: 'long', day: 'numeric' });
  let activeTab;
  let snapshot;
  let requestInFlight;
  let failure = '';
  let refreshedAt = 0;

  function link(label, theme, path, tab, detail) {
    const node = element('a', 'dashboard-row');
    node.href = featureUrl(path, tab);
    if (theme) {
      node.dataset.feature = theme;
      node.append(icon(features[theme].icon));
    }
    const copy = element('span', 'row-copy');
    copy.append(element('strong', '', label));
    if (detail) copy.append(element('small', '', detail));
    node.append(copy, icon('next', 'disclosure'));
    return node;
  }

  function featureCard(key, tab) {
    const info = features[key];
    const card = element(info.path ? 'a' : 'div', 'feature-card');
    card.dataset.feature = key;
    if (info.path) {
      const path = tab === 'create' && ['plan-countdown', 'one-tap-hangout'].includes(key)
        ? `${info.path}?view=create` : tab === 'home' && info.browse ? info.browse : info.path;
      card.href = featureUrl(path, tab);
    }
    const copy = element('span', 'feature-card-copy');
    copy.append(element('strong', '', info.label), element('small', '', info.description));
    card.append(icon(info.icon, 'feature-card-icon'), copy);
    if (info.path) card.append(icon('next', 'disclosure'));
    return card;
  }

  function group(title, rows) {
    const card = element('section', 'dashboard-card');
    card.append(element('h2', '', title), ...rows);
    return card;
  }

  function note(value) {
    return element('p', 'dashboard-note', value);
  }

  function skeleton() {
    const node = element('div', 'skeleton');
    node.setAttribute('aria-hidden', 'true');
    return node;
  }

  function quickLinks(tab) {
    return quick.map(([label, theme, path]) => link(label, theme, path, tab));
  }

  function botLink(label) {
    const anchor = element('a', 'dashboard-row bot-link');
    anchor.href = snapshot.dashboardUrl;
    anchor.append(icon('telegram'), element('strong', 'row-copy', label), icon('next', 'disclosure'));
    anchor.addEventListener('click', ui.openBot);
    return anchor;
  }

  function events(records, theme, path) {
    if (!snapshot) return [failure ? note('Events are unavailable.') : skeleton()];
    if (snapshot.preview) return [note('Group events appear when the Board goes live.')];
    if (!records) return [note('Events could not load.')];
    return records.length ? records.map(({ id, title, startsAt }) =>
      link(title, theme, `${path}?view=detail&id=${encodeURIComponent(id)}`, 'home',
        `${yangonDateTime.format(new Date(startsAt))} · Yangon`)) : [note('No upcoming events.')];
  }

  function birthdays() {
    if (!snapshot) return [failure ? note('Upcoming birthdays are unavailable.') : skeleton()];
    if (snapshot.preview) return [note('Group birthdays appear when the Board goes live.')];
    if (!snapshot.birthdays) return [note('Birthdays could not load.')];
    return snapshot.birthdays.length ? snapshot.birthdays.map(({ name, year, month, day }) =>
      link(name, 'birthday-reminder', '/birthday?view=upcoming', 'home',
        birthdayDate.format(new Date(Date.UTC(year, month - 1, day))))) : [note('No upcoming birthdays.')];
  }

  function recentActivity(limit) {
    if (!snapshot) return [failure ? note('Recent activity is unavailable.') : skeleton()];
    const { polls, budgets } = snapshot;
    const records = [
      ...(polls ?? []).map((record) => ({ ...record, theme: 'poll' })),
      ...(budgets ?? []).map((record) => ({ ...record, theme: 'budget' })),
    ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
    const rows = records.map(({ id, title, createdAt, status, theme }) => {
      const row = element('a', 'dashboard-row');
      row.href = featureUrl(`?feature=${theme}&view=votes&id=${encodeURIComponent(id)}`, activeTab ?? 'home');
      row.dataset.feature = theme;
      const copy = element('span', 'row-copy');
      copy.append(element('strong', '', title), element('small', '', yangonDateTime.format(new Date(createdAt))));
      const label = status.toLowerCase().replace(/^prelaunch_/, '').replaceAll('_', ' ');
      row.append(icon(features[theme].icon), copy, element('span', 'status-chip', label));
      return row;
    });
    if (!polls || !budgets) rows.push(note('Some activity could not load.'));
    if (!rows.length) rows.push(note(snapshot.preview ? 'Your saved preview ballots will appear here.' : 'No recent published votes.'));
    return rows;
  }

  function renderData() {
    const birthday = snapshot?.birthday?.date;
    const bills = snapshot?.bills;
    const bot = snapshot?.dashboardUrl;
    const birthdayLabel = birthday
      ? birthdayDate.format(new Date(Date.UTC(2000, birthday.month - 1, birthday.day)))
      : snapshot?.birthday ? 'Add your birthday' : undefined;
    const debts = snapshot?.debts;
    const debtLabel = debts ? `${debts.count}${debts.more ? '+' : ''} outstanding` : undefined;
    const billLabel = bills ? `${bills.count}${bills.more ? '+' : ''} ${bills.count === 1 ? 'bill' : 'bills'}` : undefined;
    get('home-updates').replaceChildren(
      group('Upcoming countdowns', events(snapshot?.plans, 'plan-countdown', '/countdown')),
      group('Active hangouts', events(snapshot?.hangouts, 'one-tap-hangout', '/hangout')),
      group('Upcoming birthdays', birthdays()),
      group('Recent activity', recentActivity(3)),
      group('Quick actions', quickLinks('home')),
      group('My summary', [
        link('My birthday', 'birthday-reminder', '/birthday', 'home', birthdayLabel),
        link('My bills', 'bill-splitter', '/bills?view=mine', 'home', billLabel),
        link('My debts', 'bill-splitter', '/bills?view=debts', 'home', debtLabel),
      ]),
    );
    get('activity-content').replaceChildren(group('Recent activity', [
      ...recentActivity(8),
      ...(bills?.recent ?? []).map(({ id, title, total }) => link(title, 'bill-splitter',
        `/bills?view=bill%3A${encodeURIComponent(id)}`, 'activity', `${BigInt(total).toLocaleString('en-US')} MMK`)),
    ]), group('Voting and results', [
      link('Smart Poll', 'poll', '?feature=poll&view=votes', 'activity'),
      link('Group Budget Vote', 'budget', '?feature=budget&view=votes', 'activity'),
    ]));
    get('my-stuff').replaceChildren(group('Personal summary', [
      link('My bills', 'bill-splitter', '/bills?view=mine', 'mine', billLabel),
      link('My debts', 'bill-splitter', '/bills?view=debts', 'mine', debtLabel),
      link('My birthday', 'birthday-reminder', '/birthday', 'mine', birthdayLabel),
      link('My countdowns', 'plan-countdown', '/countdown?view=mine', 'mine'),
      link('My hangouts', 'one-tap-hangout', '/hangout?view=mine', 'mine'),
      ...(bot ? [botLink('My polls and budget votes in Telegram')] : []),
    ]));
    get('more-content').replaceChildren(group('The Board', [
      ...(bot ? [botLink('Open the Telegram bot')] : []),
      link('Group debt ledger', 'bill-splitter', '/bills?view=ledger', 'more'),
      link('Upcoming birthdays', 'birthday-reminder', '/birthday?view=upcoming', 'more'),
      link('Upcoming countdowns', 'plan-countdown', '/countdown?view=upcoming', 'more'),
      link('Active hangouts', 'one-tap-hangout', '/hangout?view=active', 'more'),
    ]));
  }

  function notice(value, canRetry = false) {
    status.textContent = value;
    status.hidden = !value;
    retry.hidden = !canRetry;
  }

  async function refresh(force = false) {
    if (requestInFlight || document.hidden || (!force && Date.now() - refreshedAt < 30_000)) return;
    if (!telegram?.initData) {
      failure = 'Open The Board in Telegram to see group and personal updates.';
      notice(failure);
      renderData();
      return;
    }
    requestInFlight = true;
    retry.disabled = true;
    notice(snapshot ? 'Refreshing Board updates…' : 'Loading Board updates…');
    try {
      const response = await fetch(`${window.BOARD_API_ORIGIN ?? ''}/api/dashboard`, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Authorization: `tma ${telegram.initData}` },
        signal: AbortSignal.timeout(60_000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      snapshot = data;
      failure = '';
      const partial = !data.polls || !data.budgets || !data.birthday ||
        (!data.preview && (!data.plans || !data.hangouts || !data.birthdays || !data.bills || !data.debts));
      notice(partial ? 'Some Board updates could not load. Try again.' : data.preview ? 'PRELAUNCH · Owner preview' : data.testGroup ? 'Test group mode' : '', partial);
    } catch (error) {
      snapshot = undefined;
      failure = error instanceof Error && error.message.startsWith('Access could not be verified')
        ? error.message : 'Could not refresh Board updates. Try again or reopen The Board in Telegram.';
      notice(failure, true);
    } finally {
      refreshedAt = Date.now();
      requestInFlight = false;
      retry.disabled = false;
      renderData();
    }
  }

  function select(tab, { push = false, focus = false } = {}) {
    if (tab === activeTab) return;
    if (push) history.pushState(null, '', tabUrl(tab));
    activeTab = tab;
    for (const link of nav.querySelectorAll('a')) {
      const selected = link.dataset.tab === tab;
      get(link.dataset.tab).hidden = !selected;
      if (selected) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (tab === 'home' && !sheet.open) backButton?.hide();
    else backButton?.show();
    if (focus) {
      window.scrollTo(0, 0);
      get(tab).querySelector('h1').focus({ preventScroll: true });
    }
  }

  function currentTab() {
    const tab = new URLSearchParams(location.search).get('tab');
    return tabs.includes(tab) ? tab : 'home';
  }

  const header = ui.header('The Unofficial Board', 'board');
  const actions = element('button', 'icon-button');
  actions.type = 'button';
  actions.setAttribute('aria-label', 'Quick actions');
  actions.setAttribute('aria-haspopup', 'dialog');
  actions.append(icon('more'));
  actions.addEventListener('click', () => {
    get('quick-actions').replaceChildren(...quickLinks(activeTab));
    sheet.showModal();
    backButton?.show();
  });
  sheet.querySelector('button').append(icon('close'));
  sheet.addEventListener('close', () => { if (activeTab === 'home') backButton?.hide(); });
  sheet.addEventListener('click', (event) => { if (event.target === sheet) sheet.close(); });
  header.append(actions);
  home.before(header);
  get('welcome-title').tabIndex = -1;
  get('home').querySelector('.welcome-hero').append(ui.art('welcome'));
  get('feature-grid').append(...Object.keys(features).map((key) => featureCard(key, 'home')));
  get('create-grid').append(...Object.keys(features).filter((key) => features[key].path).map((key) => featureCard(key, 'create')));

  for (const tab of tabs) {
    const anchor = element('a', 'nav-link');
    anchor.href = tabUrl(tab);
    anchor.dataset.tab = tab;
    anchor.append(icon(tab), element('span', '', labels[tab]));
    anchor.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      select(tab, { push: true, focus: true });
      void refresh();
    });
    nav.append(anchor);
  }
  document.documentElement.classList.add('board-dashboard');
  home.hidden = nav.hidden = false;
  select(currentTab());
  renderData();
  window.setInterval(() => void refresh(), 30_000);
  retry.addEventListener('click', () => void refresh(true));
  window.addEventListener('popstate', () => {
    if (sheet.open) sheet.close();
    select(currentTab(), { focus: true });
  });
  window.addEventListener('pageshow', (event) => { if (event.persisted) void refresh(true); });
  document.addEventListener('visibilitychange', () => void refresh());
  backButton?.onClick(() => {
    if (sheet.open) sheet.close();
    else if (activeTab !== 'home') select('home', { push: true, focus: true });
  });
  telegram?.ready();
  telegram?.expand();
  void refresh();
})();
