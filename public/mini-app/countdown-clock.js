export function countdownParts(startsAt, now) {
  const seconds = Math.max(0, Math.ceil((startsAt - now) / 1000));
  return [
    Math.floor(seconds / 86400),
    Math.floor(seconds / 3600) % 24,
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ];
}

export function yangonTimestamp(date, time) {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || time >= '24:00') return NaN;
  const timestamp = Date.parse(`${date}T${time}:00+06:30`);
  if (!Number.isFinite(timestamp)) return NaN;
  const local = new Date(timestamp + 23_400_000).toISOString();
  return local.slice(0, 16) === `${date}T${time}` ? timestamp : NaN;
}
