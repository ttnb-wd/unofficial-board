import { countdownParts, yangonTimestamp } from './countdown-clock.js';
import { eventDateTimeParts, eventTimeZone, matchesEventDateTime, mountTimePicker } from './event-time.js?v=1';

const tg = window.Telegram?.WebApp;
const byId = (id) => document.getElementById(id);
const form = byId('plan-form');
const timePicker = mountTimePicker(byId('plan-time'));
const content = byId('content');
const heading = byId('heading');
const error = byId('error');
const save = byId('save');
const loading = byId('loading');
const navigation = byId('navigation');
const params = new URLSearchParams(location.search);
const timeZone = eventTimeZone;

let clockAt = Date.now();
let clockAnchor = performance.now();
let wallAnchor = Date.now();
let lastServerTime = -Infinity;
const now = () => clockAt + performance.now() - clockAnchor;
let preview = false;
let previewMessages = [];
let dashboardUrl;
let fixtures;
let current = { view: 'menu' };
let routeToken = 0;
let requestId;
let timers = [];
const tick = () => timers.forEach((update) => update());
const listViews = ['upcoming', 'mine', 'completed'];
let busy = false;
let syncing = false;

tg?.ready();
tg?.expand();

async function api(action, data = {}) {
  if (!tg?.initData) throw new Error('Open Plan Countdown from the bot’s private chat.');
  const started = performance.now();
  const response = await fetch(`${window.BOARD_API_ORIGIN || ''}/api/countdowns`, {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    headers: { Authorization: `tma ${tg.initData}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...data }),
    signal: AbortSignal.timeout(45_000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error || 'Could not reach Plan Countdown. Try again.');
  const received = performance.now();
  const serverTime = Date.parse(result.serverNow);
  if (Number.isFinite(serverTime) && serverTime >= lastServerTime) {
    lastServerTime = serverTime;
    clockAt = serverTime + Math.min(1000, (received - started) / 2);
    clockAnchor = received;
    wallAnchor = Date.now();
  }
  return result;
}

function fixturePlans() {
  let saved = [];
  try {
    const stored = JSON.parse(sessionStorage.getItem('countdown-simulation') || 'null');
    if (Array.isArray(stored)) saved = stored;
  } catch {
    // Storage is optional inside embedded browsers.
  }
  const reference = now();
  const examples = [
    ['picnic', 'Weekend picnic', 48], ['beach', 'Beach trip', 48],
    ['games', 'Board game evening', -1], ['coffee', 'Coffee catch-up', -24],
    ['brunch', 'Saturday brunch', 25], ['movie', 'Movie night', 30],
    ['market', 'Night market', 55], ['cake', 'Birthday cake tasting', 60],
    ['hike', 'Morning hike', 72], ['dinner', 'Group dinner', 96],
    ['karaoke', 'Karaoke night', 108], ['museum', 'Museum visit', 120],
  ];
  const picnicTime = saved.find((plan) => plan.id === 'fixture-picnic')?.startsAt;
  const defaults = examples.map(([id, title, hours], index) => ({
    id: `fixture-${id}`, title, description: '',
    startsAt: (id === 'beach' && picnicTime) || new Date(reference + hours * 3_600_000).toISOString(), owned: index % 2 === 0 && index !== 0, version: 1,
  }));
  return [...saved, ...defaults.filter(({ id }) => !saved.some((plan) => plan.id === id))];
}

function simulate(action, data = {}) {
  if (listViews.includes(action)) {
    const descending = action === 'completed';
    const ordered = fixtures.filter((plan) => {
      if (action === 'mine') return plan.owned;
      if (plan.cancelledAt) return false;
      return descending ? Date.parse(plan.startsAt) <= now() : Date.parse(plan.startsAt) > now();
    }).sort((a, b) => (descending ? -1 : 1) * (a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id)));
    const after = data.cursor ? ordered.findIndex((plan) => plan.id === data.cursor.id) + 1 : 0;
    const plans = ordered.slice(after, after + 8);
    const last = ordered.length > after + 8 ? plans.at(-1) : null;
    return { plans, nextCursor: last ? { startsAt: last.startsAt, id: last.id } : null };
  }
  const existing = fixtures.find((plan) => plan.id === (data.id || data.requestId));
  if (action === 'detail') {
    if (!existing) throw new Error('Countdown not found.');
    return { plan: existing };
  }
  if (action === 'create' && existing) return { plan: existing };
  if (action !== 'create' && (!existing?.owned || existing.cancelledAt || Date.parse(existing.startsAt) <= now())) {
    throw new Error('This countdown cannot be changed.');
  }
  let plan;
  if (action === 'cancel') {
    plan = { ...existing, cancelledAt: new Date(now()).toISOString(), version: existing.version + 1 };
  } else {
    const startsAt = yangonTimestamp(data.date, data.time);
    if (!data.title || !Number.isFinite(startsAt) || startsAt <= now()) {
      throw new Error('Enter a title and choose a valid future date and time in Yangon.');
    }
    plan = {
      id: existing?.id || data.requestId, title: data.title, description: data.description,
      startsAt: existing && matchesEventDateTime(existing.startsAt, data.date, data.time)
        ? existing.startsAt : new Date(startsAt).toISOString(),
      owned: true, version: (existing?.version || 0) + 1,
    };
  }
  fixtures = [...fixtures.filter((item) => item.id !== plan.id), plan];
  storeFixtures();
  return { plan };
}

function storeFixtures() {
  try { sessionStorage.setItem('countdown-simulation', JSON.stringify(fixtures)); } catch {
    // The current session still works without storage.
  }
}

const run = (action, data) => preview ? simulate(action, data) : api(action, data);

function showError(message = '') {
  error.textContent = message;
  error.hidden = !message;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, callback, className) {
  const node = element('button', label, className);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short', hour12: true });
const formatDate = (value) => `${dateFormat.format(new Date(value))} · Yangon`;
const labels = {
  create: 'Create Countdown', edit: 'Edit Countdown', upcoming: 'Upcoming Countdowns',
  mine: 'My Events', completed: 'Completed Events', detail: 'Countdown Details', member: 'Member View',
  preview: 'Preview Notifications', menu: 'Plan Countdown',
};

function renderForm(plan) {
  form.reset();
  requestId = params.get('draft') || crypto.randomUUID();
  if (plan) {
    const { date, time } = eventDateTimeParts(new Date(plan.startsAt));
    form.elements.title.value = plan.title;
    form.elements.description.value = plan.description;
    form.elements.date.value = date;
    timePicker.setValue(time);
  } else {
    const url = new URL(location.href);
    url.searchParams.set('draft', requestId);
    history.replaceState(null, '', url);
    params.set('draft', requestId);
  }
  save.textContent = plan ? 'Save Changes' : 'Create';
  form.hidden = false;
}

function renderTimer(plan, card, onStatus = () => {}) {
  const tiles = element('div', '', 'countdown-tiles');
  const values = ['Days', 'Hours', 'Minutes', 'Seconds'].map((unit) => {
    const tile = element('div', '', 'countdown-tile');
    const value = element('strong', '00');
    tile.append(value, element('span', unit));
    tiles.append(tile);
    return value;
  });
  const state = element('p', '', 'countdown-state');
  state.setAttribute('role', 'status');
  card.append(tiles, state);
  const startsAt = Date.parse(plan.startsAt);
  const update = () => {
    const parts = plan.cancelledAt ? [0, 0, 0, 0] : countdownParts(startsAt, now());
    parts.forEach((part, index) => {
      const value = String(part).padStart(2, '0');
      if (values[index].textContent !== value) values[index].textContent = value;
    });
    const status = plan.cancelledAt ? 'Cancelled' : startsAt <= now() ? 'Event started' : '';
    if (state.textContent !== status) state.textContent = status;
    state.hidden = !status;
    onStatus(status);
  };
  timers.push(update);
  update();
}

function renderDetail(plan, memberView, returnView, returnPage) {
  const card = element('article', '', 'bill-card');
  card.append(element('h2', plan.title), element('p', formatDate(plan.startsAt), 'countdown-muted'));
  if (plan.description) card.append(element('p', plan.description, 'countdown-copy'));
  const actions = element('div', '', 'bill-actions');
  content.append(card, actions);
  if (plan.owned && !memberView) {
    actions.append(
      button('Edit Countdown', () => void open('edit', { plan, id: plan.id, returnView, returnPage })),
      button('Cancel Countdown', () => {
        if (window.confirm('Cancel this shared countdown?')) void cancel(plan, returnView);
      }, 'danger-button'),
    );
  }
  renderTimer(plan, card, (status) => {
    actions.hidden = Boolean(status) || !actions.childElementCount;
  });
}

function renderList({ plans, nextCursor }, view, pages) {
  const empty = { mine: 'You have no events yet.', upcoming: 'No upcoming events.', completed: 'No completed events.' };
  if (!plans.length) content.append(element('p', empty[view], 'bill-card'));
  for (const plan of plans) {
    const row = element('article', '', 'bill-card countdown-list-card');
    const title = element('h2');
    title.append(button(plan.title, () => void open('detail', { id: plan.id, returnView: view, returnPage: pages }), 'countdown-list-title'));
    row.append(title, element('p', formatDate(plan.startsAt), 'countdown-muted'));
    renderTimer(plan, row);
    content.append(row);
  }
  if (pages.length || nextCursor) {
    const pager = element('nav', '', 'bill-actions countdown-pager');
    pager.setAttribute('aria-label', 'Event pages');
    const previous = button('Previous', () => void open(view, { pages: pages.slice(0, -1) }));
    const next = button('Next', () => void open(view, { pages: [...pages, nextCursor] }));
    previous.disabled = pages.length === 0;
    next.disabled = !nextCursor;
    pager.append(previous, element('span', `Page ${pages.length + 1}`), next);
    content.append(pager);
  }
}

async function open(view, options = {}) {
  if (!Object.hasOwn(labels, view) || (!preview && ['preview', 'member'].includes(view))) view = 'menu';
  const token = ++routeToken;
  current = { view, ...options };
  const url = new URL(location.href);
  url.searchParams.set('view', view === 'edit' ? 'detail' : view);
  if (options.id) url.searchParams.set('id', options.id);
  else url.searchParams.delete('id');
  if (view !== 'create') {
    url.searchParams.delete('draft');
    params.delete('draft');
  }
  history.replaceState(null, '', url);
  showError();
  timers = [];
  form.hidden = true;
  content.hidden = true;
  content.replaceChildren();
  byId('back').hidden = view === 'menu';
  if (view === 'menu' && !window.BoardUI.returnTab) tg?.BackButton?.hide();
  else tg?.BackButton?.show();
  heading.textContent = labels[view];
  loading.hidden = !['detail', ...listViews].includes(view);
  try {
    if (view === 'create' || view === 'edit') renderForm(options.plan);
    if (view === 'detail') {
      const { plan } = options.plan ? options : await run('detail', { id: options.id });
      if (token !== routeToken) return;
      renderDetail(plan, false, options.returnView, options.returnPage);
    }
    if (listViews.includes(view)) {
      const pages = options.pages || [];
      const result = await run(view, { cursor: pages.at(-1) });
      if (token !== routeToken) return;
      renderList(result, view, pages);
    }
    if (view === 'member') renderDetail(fixtures.find((plan) => plan.id === 'fixture-picnic'), true);
    if (view === 'preview') {
      const titles = { ANNOUNCEMENT: 'Group announcement', DAY_BEFORE: '24-hour reminder', SIX_HOURS_BEFORE: '6-hour reminder', HOUR_BEFORE: '1-hour reminder', AT_START: 'Event start' };
      for (const message of previewMessages) {
        const card = element('article', '', 'bill-card');
        card.append(element('h2', titles[message.kind]), element('p', message.text, 'countdown-copy'),
          button('View Countdown', () => void open('member', { returnView: 'preview' })));
        if (message.variants) {
          const variants = element('details');
          variants.append(element('summary', 'All celebration messages'));
          for (const text of message.variants) variants.append(element('p', text, 'countdown-copy'));
          card.append(variants);
        }
        content.append(card);
      }
    }
    if (view === 'menu') {
      const entries = preview ? ['create', ...listViews, 'preview', 'member'] : ['create', ...listViews];
      for (const entry of entries) content.append(button(labels[entry], () => void open(entry, { returnView: 'menu' }), entry === 'create' ? 'primary-button' : undefined));
    }
    content.hidden = !content.childElementCount;
  } catch (failure) {
    if (token === routeToken) {
      showError(failure.message);
      content.append(button('Try Again', () => void open(view, options)));
      content.hidden = false;
    }
  } finally {
    if (token === routeToken) loading.hidden = true;
  }
}

function setBusy(value) {
  busy = value;
  save.disabled = value;
  timePicker.setDisabled(value);
  navigation.inert = value;
  content.inert = value;
}

async function cancel(plan, returnView) {
  if (busy) return;
  setBusy(true);
  showError();
  try {
    const result = await run('cancel', { id: plan.id, version: plan.version });
    content.replaceChildren();
    timers = [];
    renderDetail(result.plan, false, returnView, current.returnPage);
  } catch (failure) {
    showError(failure.message);
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const data = Object.fromEntries(new FormData(form));
  data.title = data.title.trim();
  data.time = timePicker.value();
  const startsAt = yangonTimestamp(data.date, data.time);
  if (!data.title || !Number.isFinite(startsAt) || startsAt <= now()) {
    showError('Enter a title and choose a valid future date and time in Yangon.');
    return;
  }
  const { plan, returnView, returnPage } = current;
  setBusy(true);
  showError();
  try {
    const payload = { ...data, timeZone, ...(plan ? { id: plan.id, version: plan.version } : { requestId }) };
    const result = await run(plan ? 'edit' : 'create', payload);
    await open('detail', { id: result.plan.id, plan: result.plan, returnView: returnView || 'mine', returnPage });
  } catch (failure) {
    showError(failure.message);
  } finally {
    setBusy(false);
  }
});

byId('back').addEventListener('click', goBack);
function goBack() {
  if (busy) return;
  if (current.view === 'edit') void open('detail', { id: current.id, returnView: current.returnView, returnPage: current.returnPage });
  else if (current.returnView || !window.BoardUI.backToBoard()) void open(current.returnView || 'menu', { pages: current.returnPage });
}
byId('main-menu').addEventListener('click', () => {
  if (window.BoardUI.backToBoard()) return;
  if (dashboardUrl) tg?.openTelegramLink?.(dashboardUrl);
  tg?.close();
});

async function refreshClock() {
  if (document.hidden || syncing || !tg?.initData) return;
  syncing = true;
  try { await api('session'); } catch {
    // Continue using the last monotonic server reference while offline.
  } finally {
    syncing = false;
    tick();
  }
}

setInterval(() => { if (!document.hidden) tick(); }, 1000);
setInterval(() => void refreshClock(), 60_000);
function resume() {
  // Some browsers pause their monotonic clock while the device sleeps.
  const elapsed = performance.now() - clockAnchor;
  const wallElapsed = Date.now() - wallAnchor;
  if (wallElapsed > elapsed + 2000) {
    clockAt += wallElapsed;
    clockAnchor = performance.now();
    wallAnchor = Date.now();
  }
  tick();
  void refreshClock();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) resume(); });

async function initialize() {
  loading.hidden = false;
  showError();
  try {
    const session = await api('session');
    preview = session.preview;
    dashboardUrl = session.dashboardUrl;
    previewMessages = session.messages || [];
    byId('preview').hidden = !preview;
    if (preview) {
      fixtures = fixturePlans();
      storeFixtures();
    }
    navigation.hidden = false;
    tg?.BackButton?.onClick(goBack);
    await open(params.get('view') || 'menu', { id: params.get('id') || undefined });
  } catch (failure) {
    loading.hidden = true;
    showError(failure.message);
    content.replaceChildren(button('Try Again', () => void initialize()));
    content.hidden = false;
  }
}

void initialize();
