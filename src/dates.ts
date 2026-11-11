// Turns "Monday", "last Tuesday", "3 November" into real day ranges.
// Done in code, not by the model: date maths is cheap to get right here
// and expensive to get wrong there.

import * as chrono from "chrono-node";

export type DayRange = { label: string; start: Date; end: Date };

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function day(label: string, d: Date): DayRange {
  return { label, start: startOfDay(d), end: addDays(d, 1) };
}

export function resolveDates(text: string, now: Date): DayRange[] {
  const ranges: DayRange[] = [];
  const today = startOfDay(now);

  // chrono reads "last week" as one day, we want the whole week (Mon-Sun)
  let rest = text;
  if (/\blast week\b/i.test(text)) {
    const monday = addDays(today, -((today.getDay() + 6) % 7) - 7);
    ranges.push({ label: "last week", start: monday, end: addDays(monday, 7) });
    rest = rest.replace(/\blast week\b/gi, " ");
  }

  for (const hit of chrono.parse(rest, now, { forwardDate: false })) {
    const parts = hit.start;
    let date = parts.date();

    // "in March" - the whole month
    if (parts.isCertain("month") && !parts.isCertain("day") && !parts.isCertain("weekday")) {
      let year = date.getFullYear();
      if (new Date(year, date.getMonth(), 1) > now) year -= 1;
      ranges.push({
        label: hit.text,
        start: new Date(year, date.getMonth(), 1),
        end: new Date(year, date.getMonth() + 1, 1),
      });
      continue;
    }

    // memory is always about the past, so pull anything in the future back
    const weekdayOnly = parts.isCertain("weekday") && !parts.isCertain("day");
    if (startOfDay(date) > today) {
      date = weekdayOnly
        ? addDays(date, -7)
        : new Date(date.getFullYear() - 1, date.getMonth(), date.getDate());
    }

    if (hit.end) {
      ranges.push({ label: hit.text, start: startOfDay(date), end: addDays(hit.end.date(), 1) });
      continue;
    }

    ranges.push(day(hit.text, date));

    // "last Tuesday" on a Wednesday: yesterday, or a week before? people mean both.
    // keep both and let the stored chats decide.
    if (weekdayOnly && /\blast\b/i.test(hit.text)) {
      ranges.push(day(hit.text, addDays(date, -7)));
    }
  }

  return dedupe(ranges);
}

function dedupe(ranges: DayRange[]): DayRange[] {
  const seen = new Set<string>();
  return ranges.filter((r) => {
    const key = `${r.start.getTime()}-${r.end.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
