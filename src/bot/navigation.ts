import { Markup } from 'telegraf';
import { features } from '../features/index.js';

export function dashboardKeyboard() {
  const featureButtons = features.map((feature) =>
    Markup.button.callback(feature.title, `feature:${feature.id}`),
  );
  const rows = [];
  for (let index = 0; index < featureButtons.length; index += 2) {
    rows.push(featureButtons.slice(index, index + 2));
  }
  rows.push([Markup.button.callback('Cancel', 'nav:cancel')]);
  return Markup.inlineKeyboard(rows);
}

export function featureKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Back', 'nav:back'),
      Markup.button.callback('Home', 'nav:home'),
      Markup.button.callback('Cancel', 'nav:cancel'),
    ],
  ]);
}

export function cancelledKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Home', 'nav:home')],
  ]);
}
