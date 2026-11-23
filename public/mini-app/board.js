(() => {
  const tg = window.Telegram?.WebApp;
  const base = '/mini-app';
  const params = new URLSearchParams(location.search);
  const tabs = ['home', 'activity', 'create', 'mine', 'more'];
  const features = {
    poll: { icon: 'poll', label: 'Smart Poll', action: 'Create a Poll', description: 'Create polls & decide together', intro: 'Get everyone’s opinion, easily.', path: '?feature=poll', art: 'poll' },
    budget: { icon: 'budget', label: 'Group Budget Vote', action: 'Group Budget Vote', description: 'Vote on a group budget', intro: 'Choose the amounts for your next group vote.', path: '?feature=budget', browse: '?feature=budget&view=votes', art: 'budget' },
    'bill-splitter': { icon: 'bill', label: 'Bill Splitter', action: 'Split a Bill', description: 'Split expenses easily', intro: 'Add members, enter the amount, and split it easily.', path: '/bills?view=create', art: 'bill' },
    'birthday-reminder': { icon: 'birthday', label: 'Birthday Reminder', action: 'Birthday Reminder', description: 'Never miss a birthday', intro: 'Save your birthday and see who’s celebrating next.', path: '/birthday' },
    'plan-countdown': { icon: 'countdown', label: 'Plan Countdown', action: 'Plan Countdown', description: 'Count down to your next plan', intro: 'Keep track of what the group has planned.', path: '/countdown' },
    'one-tap-hangout': { icon: 'hangout', label: 'One Tap Hangout', action: 'One Tap Hangout', description: 'Quickly plan a hangout', intro: 'Make a plan and see who’s coming.', path: '/hangout' },
    'shared-memory-vault': { icon: 'vault', label: 'Shared Memory Vault', description: 'Coming soon' },
  };
  const feature = document.documentElement.dataset.feature || params.get('feature');
  const from = params.get('from');
  const returnTab = tabs.includes(from) ? from : null;

  // Browsers can match :focus-visible on text fields even after a tap.
  document.addEventListener('pointerdown', () => {
    document.documentElement.setAttribute('data-pointer-focus', '');
  }, { capture: true, passive: true });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' || event.key.startsWith('Arrow')) {
      document.documentElement.removeAttribute('data-pointer-focus');
    }
  }, { capture: true });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function icon(name, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS(svg.namespaceURI, 'use');
    svg.setAttribute('class', `board-icon ${className}`);
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', `${base}/icons.svg#${name}`);
    svg.append(use);
    return svg;
  }

  function art(name) {
    const image = element('img', 'hero-art');
    image.src = `${base}/${name}.webp`;
    image.alt = '';
    image.decoding = 'async';
    return image;
  }

  function tabUrl(tab) {
    return tab === 'home' ? base : `${base}?tab=${tab}`;
  }

  function featureUrl(path, tab) {
    const url = new URL(base + path, location.origin);
    url.searchParams.set('from', tab);
    return url.pathname + url.search;
  }

  function backToBoard() {
    if (!returnTab) return false;
    location.replace(tabUrl(returnTab));
    return true;
  }

  function header(title, symbol, back) {
    const bar = element('div', back ? 'app-bar app-bar-feature' : 'app-bar');
    if (back) {
      const control = element('button', 'icon-button app-back');
      control.type = 'button';
      control.setAttribute('aria-label', 'Back');
      control.append(icon('back'));
      control.addEventListener('click', back);
      bar.append(control);
    }
    const brand = element('div', 'app-brand');
    const mark = symbol === 'board' ? element('img', 'board-logo') : icon(symbol);
    if (symbol === 'board') {
      mark.src = base + '/board-logo.png';
      mark.alt = '';
      mark.width = 40;
      mark.height = 40;
    }
    brand.append(mark, element('span', '', title));
    bar.append(brand);
    return bar;
  }

  function openBot(event) {
    if (typeof tg?.openTelegramLink !== 'function' || event.metaKey || event.ctrlKey ||
        event.shiftKey || event.altKey || !event.currentTarget.href) return;
    event.preventDefault();
    tg.openTelegramLink(event.currentTarget.href);
  }

  window.BoardUI = { tabs, features, element, icon, art, tabUrl, featureUrl, returnTab, backToBoard, header, openBot };

  if (!Object.hasOwn(features, feature)) return;
  const theme = features[feature];
  document.documentElement.dataset.feature = feature;
  const hero = document.querySelector('.feature-hero');
  const title = hero.querySelector('h1');
  const intro = element('p', 'hero-intro', theme.intro);
  title.after(intro);
  if (theme.art) {
    hero.classList.add('illustrated');
    hero.prepend(art(theme.art));
  } else {
    hero.prepend(icon(theme.icon, 'hero-icon'));
  }
  const back = () => {
    if (window.BoardUI.onFeatureBack) return window.BoardUI.onFeatureBack();
    const localBack = document.querySelector('#back:not([hidden]), #hangout-back:not([hidden]), #birthday-back, #bill-navigation button');
    if (localBack?.closest('[inert]')) return;
    if (localBack && localBack.getClientRects().length) localBack.click();
    else if (!backToBoard()) window.Telegram?.WebApp?.close();
  };
  hero.before(header(theme.label, theme.icon, back));
  document.title = `${theme.label} · The Unofficial Board`;
})();
