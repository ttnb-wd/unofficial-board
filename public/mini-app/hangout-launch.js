async function launchHangout() {
  const fallback = document.getElementById('hangout-launch-error');
  const loading = document.getElementById('hangout-loading');
  const scripts = [];
  const loadScript = (src) => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    scripts.push(script);
    document.head.append(script);
  });
  document.getElementById('hangout-reload').addEventListener('click', (event) => {
    event.preventDefault();
    location.reload();
  });
  fallback.hidden = true;
  loading.hidden = false;
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = window.setTimeout(reject, 15_000); });
    const assets = Promise.all([
      loadScript('https://telegram.org/js/telegram-web-app.js'),
      loadScript('/mini-app/config.js?v=2'),
      import('./hangout.js?v=event-time-1'),
    ]);
    const [, , app] = await Promise.race([assets, deadline]);
    window.clearTimeout(timer);
    await app.initialize();
  } catch {
    loading.hidden = true;
    fallback.hidden = false;
  } finally {
    window.clearTimeout(timer);
    for (const script of scripts) script.remove();
  }
}

void launchHangout();
