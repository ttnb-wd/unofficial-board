export const yangon = 'Asia/Yangon';

export function parseYangonTime(date: string, time: string): Date | null {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || time >= '24:00') return null;
  const timestamp = new Date(`${date}T${time}:00+06:30`);
  if (!Number.isFinite(timestamp.getTime())) return null;
  return new Date(+timestamp + 23_400_000).toISOString().slice(0, 16) === `${date}T${time}` ? timestamp : null;
}
