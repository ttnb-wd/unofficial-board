export const eventTimeZone = 'Asia/Yangon';

const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: eventTimeZone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const pad = (value) => String(value).padStart(2, '0');

export function eventDateTimeParts(date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function matchesEventDateTime(startsAt, date, time) {
  const saved = eventDateTimeParts(new Date(startsAt));
  return saved.date === date && saved.time === time;
}

export function to24Hour(hour, minute, period) {
  if (!/^(?:[1-9]|1[0-2])$/.test(hour) || !/^[0-5]\d$/.test(minute) ||
      (period !== 'AM' && period !== 'PM')) return null;
  return `${pad(Number(hour) % 12 + (period === 'PM' ? 12 : 0))}:${minute}`;
}

export function from24Hour(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  return { hour: String(hour % 12 || 12), minute: match[2], period: hour < 12 ? 'AM' : 'PM' };
}

export function mountTimePicker(field) {
  const picker = document.createElement('div');
  picker.className = 'time-picker';
  const makeSelect = (key, labelText, values) => {
    const wrapper = document.createElement('div');
    const select = document.createElement('select');
    select.id = `${field.id}-${key}`;
    select.required = true;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '–';
    placeholder.defaultSelected = true;
    placeholder.disabled = true;
    select.append(placeholder);
    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    const label = document.createElement('label');
    label.htmlFor = select.id;
    label.textContent = labelText;
    wrapper.append(label, select);
    picker.append(wrapper);
    return select;
  };

  const hour = makeSelect('hour', 'Hour', Array.from({ length: 12 }, (_, index) => String(index + 1)));
  const separator = document.createElement('span');
  separator.className = 'time-picker-separator';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = ':';
  picker.append(separator);
  const minute = makeSelect('minute', 'Minute', Array.from({ length: 60 }, (_, index) => pad(index)));
  const period = makeSelect('period', 'AM/PM', ['AM', 'PM']);
  field.append(picker);

  return {
    value: () => to24Hour(hour.value, minute.value, period.value),
    setValue(time) {
      const parts = from24Hour(time);
      hour.value = parts?.hour ?? '';
      minute.value = parts?.minute ?? '';
      period.value = parts?.period ?? '';
    },
    setDisabled(disabled) { field.disabled = disabled; },
    focus() { hour.focus(); },
  };
}
