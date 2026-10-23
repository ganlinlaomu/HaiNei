// Dates, icons and calendar export for to-do tasks (planner, home bar).

/** A plausible task due time (Unix ms between 2000 and 2100). */
export function validTaskDue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 946_684_800_000 && value < 4_102_444_800_000;
}

export function startOfDay(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Monday 00:00 of the week containing `ms` (local time). */
export function startOfWeek(ms: number) {
  const date = new Date(startOfDay(ms));
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

export function sameDay(a: number, b: number) {
  return startOfDay(a) === startOfDay(b);
}

const pad = (value: number) => String(value).padStart(2, "0");

export function timeOfDay(ms: number) {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 今天 14:00 / 明天 09:00 / 昨天 18:30 / 10月25日 14:00, and whether overdue. */
export function describeDue(due: number, now = Date.now()) {
  const today = startOfDay(now);
  const day = startOfDay(due);
  const dayMs = 24 * 60 * 60 * 1000;
  const date = new Date(due);
  const prefix = day === today ? "今天" : day === today + dayMs ? "明天" : day === today - dayMs ? "昨天"
    : `${date.getMonth() + 1}月${date.getDate()}日`;
  return { label: `${prefix} ${timeOfDay(due)}`, overdue: due < now, today: day === today };
}

// Keyword -> emoji, first match wins. Chinese and English; default 🗒️.
const ICONS: Array<[RegExp, string]> = [
  [/会议|开会|例会|站会|review|meeting|stand-?up|评审|讨论/i, "💼"],
  [/电话|通话|打给|回电|call/i, "📞"],
  [/邮件|邮箱|email|mail|回复/i, "✉️"],
  [/买|购|超市|菜|shopping|buy/i, "🛒"],
  [/吃|饭|餐|早餐|午餐|晚餐|做饭|lunch|dinner|breakfast/i, "🍽️"],
  [/健身|跑步|运动|锻炼|游泳|瑜伽|gym|run|workout/i, "🏃"],
  [/医|药|体检|看病|牙|doctor|medicine/i, "💊"],
  [/学|读|书|课|作业|考试|study|read|book/i, "📚"],
  [/写|文档|报告|稿|笔记|write|doc|report/i, "📝"],
  [/代码|修|bug|开发|上线|部署|发布|code|fix|deploy/i, "💻"],
  [/钱|付|账单|房租|缴|还款|转账|pay|bill|rent/i, "💳"],
  [/打扫|洗|收拾|家务|倒垃圾|clean|laundry/i, "🧹"],
  [/生日|礼物|纪念日|birthday|gift/i, "🎁"],
  [/旅行|机票|酒店|出发|行李|trip|flight|hotel/i, "✈️"],
  [/快递|取件|寄|包裹|parcel|package/i, "📦"],
  [/计划|安排|规划|日程|plan|schedule/i, "🗓️"],
];

export function todoIcon(text: string) {
  return ICONS.find(([pattern]) => pattern.test(text))?.[1] || "🗒️";
}

function icsDate(ms: number) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00Z`;
}

function icsText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/**
 * A one-event calendar file with an alert at the due time, so the system
 * calendar reminds on time even when HaiNei is closed. The stable UID lets a
 * re-import update the same event.
 */
export function taskCalendarFile(task: { id: string; text: string; due: number }, listTitle = "", now = Date.now()) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//HaiNei//Todo//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:hainei-todo-${task.id}@hainei`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(task.due)}`,
    `DTEND:${icsDate(task.due + 30 * 60 * 1000)}`,
    `SUMMARY:${icsText(task.text)}`,
    ...(listTitle ? [`DESCRIPTION:${icsText(`海内待办 · ${listTitle}`)}`] : []),
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(task.text)}`, "TRIGGER:PT0M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

/** Offer the calendar file to the system (Calendar opens it on iOS). */
export function openTaskInCalendar(task: { id: string; text: string; due: number }, listTitle = "") {
  const blob = new Blob([taskCalendarFile(task, listTitle)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${task.text.slice(0, 40) || "待办"}.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
