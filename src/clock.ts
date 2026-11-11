// One place that knows what time it is.
// FAKE_NOW lets you pretend it's another day, so "last Tuesday" can be tested today.

const realStart = Date.now();
const fakeStart = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW).getTime() : null;

if (fakeStart !== null && Number.isNaN(fakeStart)) {
  throw new Error(`FAKE_NOW is not a date: ${process.env.FAKE_NOW}`);
}

export function now(): Date {
  // the fake clock still ticks, it just starts somewhere else
  return fakeStart === null ? new Date() : new Date(fakeStart + (Date.now() - realStart));
}

const DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

// "Tuesday 3 November 2026" - spelled out so the model never has to do date maths
export function formatDay(d: Date): string {
  return DAY.format(d).replace(",", "");
}

export function formatDayTime(d: Date): string {
  return `${formatDay(d)}, ${TIME.format(d)}`;
}
