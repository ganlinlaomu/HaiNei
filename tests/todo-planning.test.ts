import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PrivateSpaceRecord } from "@/db/dexie";
import { openTodoTasks } from "@/services/privateFeed";
import { describeDue, startOfWeek, taskCalendarFile, todoIcon, validTaskDue } from "@/utils/todoPlanning";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("to-do planning", () => {
  it("validates due times and starts weeks on Monday", () => {
    expect(validTaskDue(at(2026, 10, 23, 14))).toBe(true);
    expect([undefined, -1, 1.5, "1", 5_000_000_000_000].some(validTaskDue)).toBe(false);
    expect(startOfWeek(at(2026, 10, 25, 9))).toBe(at(2026, 10, 19)); // Sunday -> Monday 19th
    expect(startOfWeek(at(2026, 10, 19, 9))).toBe(at(2026, 10, 19));
  });

  it("labels due times relative to today and flags overdue ones", () => {
    const now = at(2026, 10, 23, 12);
    expect(describeDue(at(2026, 10, 23, 14), now)).toEqual({ label: "今天 14:00", overdue: false, today: true });
    expect(describeDue(at(2026, 10, 24, 9, 5), now).label).toBe("明天 09:05");
    expect(describeDue(at(2026, 10, 22, 18, 30), now)).toMatchObject({ label: "昨天 18:30", overdue: true });
    expect(describeDue(at(2026, 11, 2, 8), now).label).toBe("11月2日 08:00");
  });

  it("picks an icon from the task text", () => {
    expect(todoIcon("下午开会")).toBe("💼");
    expect(todoIcon("去超市买牛奶")).toBe("🛒");
    expect(todoIcon("Gym session")).toBe("🏃");
    expect(todoIcon("随便什么")).toBe("🗒️");
  });

  it("exports a calendar event with an on-time alert and escaped text", () => {
    const ics = taskCalendarFile({ id: "abc", text: "开会; 带电脑, 投影", due: Date.UTC(2026, 9, 23, 6, 0) }, "工作", Date.UTC(2026, 9, 23));
    expect(ics).toContain("UID:hainei-todo-abc@hainei");
    expect(ics).toContain("DTSTART:20261023T060000Z");
    expect(ics).toContain("SUMMARY:开会\\; 带电脑\\, 投影");
    expect(ics).toContain("TRIGGER:PT0M");
    expect(ics.split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
  });

  it("puts timed tasks first on the home bar, soonest (overdue) leading", () => {
    const record = (id: string, tasks: PrivateSpaceRecord["tasks"], pinned = false): PrivateSpaceRecord => ({
      accountPubkey: "a".repeat(64), id, kind: "todo", title: id, body: "", tasks, pinned,
      createdAt: 1, updatedAt: 1, revision: 1,
    });
    const tasks = openTodoTasks([
      record("pinned", [{ id: "p", text: "置顶无时间", done: false }], true),
      record("plain", [{ id: "late", text: "明天", done: false, due: 2_000 }, { id: "early", text: "逾期", done: false, due: 1_000 }]),
    ]);
    expect(tasks.map(task => task.taskId)).toEqual(["early", "late", "p"]);
    expect(tasks[0].due).toBe(1_000);
  });

  it("wires the planner into the private space to-do filter", () => {
    const view = readFileSync("src/views/PrivateSpace.vue", "utf8");
    expect(view).toMatch(/<TodoPlanner v-if="filter === 'todo'/);
    const planner = readFileSync("src/components/TodoPlanner.vue", "utf8");
    expect(planner).toContain("今日计划");
    expect(planner).toContain("todoIcon");
    // The invisible iOS date input is clipped to its button and never covers the check.
    expect(planner).toMatch(/\.time-button\)\{[^}]*overflow:hidden/);
    expect(planner).toMatch(/\.time-button input\)\{[^}]*min-width:0/);
    expect(view).toMatch(/\.task-due\{[^}]*overflow:hidden/);
  });
});
