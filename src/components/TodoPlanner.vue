<template>
  <section class="planner" aria-label="待办计划">
    <div class="week-head">
      <button type="button" class="week-nav" aria-label="上一周" @click="shiftWeek(-1)">‹</button>
      <strong>{{ weekLabel }}</strong>
      <button type="button" class="week-nav" aria-label="下一周" @click="shiftWeek(1)">›</button>
    </div>
    <div class="week" role="tablist" aria-label="选择日期">
      <button v-for="day in days" :key="day.start" type="button" role="tab" class="day"
        :class="{ selected: day.start === selectedDay, today: day.isToday, future: day.future }"
        :aria-selected="day.start === selectedDay" :aria-label="`${day.label}，${day.summary}`" @click="selectedDay = day.start">
        <span class="weekday">{{ day.weekday }}</span>
        <svg class="ring" viewBox="0 0 36 36" aria-hidden="true">
          <circle cx="18" cy="18" r="14" class="ring-track" :class="{ empty: !day.total }" />
          <circle v-if="day.total" cx="18" cy="18" r="14" class="ring-fill" :class="{ complete: day.done === day.total }"
            :stroke-dasharray="`${(day.done / day.total) * 88} 88`" />
        </svg>
        <span class="date">{{ day.date }}</span>
      </button>
    </div>

    <div class="plan-head">
      <strong>{{ selectedIsToday ? "今日计划" : selectedLabel }}</strong>
      <button type="button" class="add" @click="ui.openPostEditor('todo')">添加 ＋</button>
    </div>
    <p v-if="!planned.length && !unscheduled.length" class="plan-empty">{{ selectedIsToday ? "今天没有安排，点「添加」写下要做的事" : "这一天没有安排" }}</p>
    <ul class="cards">
      <li v-for="item in planned" :key="item.task.id" class="card" :class="{ done: item.task.done }">
        <ItemCard :item="item" />
      </li>
    </ul>
    <template v-if="unscheduled.length">
      <p class="section-label">未安排时间</p>
      <ul class="cards">
        <li v-for="item in unscheduled" :key="item.task.id" class="card" :class="{ done: item.task.done }">
          <ItemCard :item="item" />
        </li>
      </ul>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, ref } from "vue";
import type { PrivateSpaceRecord, PrivateSpaceTask } from "@/db/dexie";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { describeDue, openTaskInCalendar, sameDay, startOfDay, startOfWeek, timeOfDay, todoIcon } from "@/utils/todoPlanning";

type PlanItem = { task: PrivateSpaceTask; record: PrivateSpaceRecord };
const props = defineProps<{ records: PrivateSpaceRecord[] }>();
const emit = defineEmits<{ open: [recordId: string]; changed: [] }>();
const keys = useKeyStore();
const ui = useUIStore();
const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

const today = startOfDay(Date.now());
const weekStart = ref(startOfWeek(today));
const selectedDay = ref(today);
const saving = ref("");

const items = computed<PlanItem[]>(() => props.records
  .filter(record => record.kind === "todo" && !record.deletedAt && !record.archivedAt)
  .flatMap(record => record.tasks.filter(task => task.text.trim()).map(task => ({ task, record }))));

const days = computed(() => Array.from({ length: 7 }, (_, index) => {
  // Offset by two hours so a daylight-saving shift cannot land on the wrong day.
  const dayStart = startOfDay(weekStart.value + index * DAY + 2 * 60 * 60 * 1000);
  const due = items.value.filter(item => item.task.due && sameDay(item.task.due, dayStart));
  const done = due.filter(item => item.task.done).length;
  const date = new Date(dayStart);
  return {
    start: dayStart, weekday: WEEKDAYS[index], date: date.getDate(), total: due.length, done,
    isToday: dayStart === today, future: dayStart > today,
    label: `${date.getMonth() + 1}月${date.getDate()}日 星期${WEEKDAYS[index]}`,
    summary: due.length ? `${done}/${due.length} 已完成` : "没有安排",
  };
}));
const weekLabel = computed(() => {
  const first = new Date(weekStart.value);
  return weekStart.value === startOfWeek(today) ? "本周" : `${first.getMonth() + 1}月${first.getDate()}日 这一周`;
});
const selectedIsToday = computed(() => selectedDay.value === today);
const selectedLabel = computed(() => days.value.find(day => day.start === selectedDay.value)?.label || "");

// The selected day's timed tasks; today also gathers overdue open tasks.
const planned = computed(() => items.value
  .filter(item => item.task.due && (sameDay(item.task.due, selectedDay.value)
    || (selectedIsToday.value && !item.task.done && item.task.due < today)))
  .sort((a, b) => Number(a.task.done) - Number(b.task.done) || a.task.due! - b.task.due!));
// Untimed open tasks belong to "today".
const unscheduled = computed(() => selectedIsToday.value
  ? items.value.filter(item => !item.task.due && !item.task.done).sort((a, b) => Number(b.record.pinned) - Number(a.record.pinned))
  : []);

function shiftWeek(delta: number) {
  weekStart.value = startOfWeek(weekStart.value + delta * 7 * DAY + 12 * 60 * 60 * 1000);
  // Back to this week selects today; other weeks start on their Monday.
  selectedDay.value = weekStart.value === startOfWeek(today) ? today : weekStart.value;
}

async function updateTask(item: PlanItem, change: Partial<PrivateSpaceTask>) {
  const account = keys.pkHex;
  if (saving.value) return;
  saving.value = item.task.id;
  try {
    const [{ privateSpaceRepository }, { notePrivateSpaceMutation }] = await Promise.all([
      import("@/repositories/privateSpaceRepository"), import("@/services/privateSpaceSync"),
    ]);
    const current = await privateSpaceRepository.get(account, item.record.id);
    if (!current || keys.pkHex !== account) return;
    const tasks = current.tasks.map(task => {
      if (task.id !== item.task.id) return task;
      const next = { ...task, ...change };
      if (!next.due) delete next.due;
      return next;
    });
    await privateSpaceRepository.update(account, current.id, { tasks });
    notePrivateSpaceMutation(keys);
    emit("changed");
  } catch {
    ui.addToast("无法更新待办，请确认账号已解锁", 2_200, "error");
  } finally {
    saving.value = "";
  }
}

function toLocalInput(ms: number) {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

/** One task card: icon, text, time or list, round check; done ones fade. */
const ItemCard = defineComponent({
  props: { item: { type: Object as () => PlanItem, required: true } },
  setup(cardProps) {
    return () => {
      const { task, record } = cardProps.item;
      const due = task.due ? describeDue(task.due) : null;
      const defaultDue = task.due || (selectedDay.value + 9 * 60 * 60 * 1000);
      return [
        h("span", { class: "icon", "aria-hidden": "true" }, todoIcon(task.text)),
        h("button", { type: "button", class: "card-main", onClick: () => emit("open", record.id) }, [
          h("span", { class: "card-text" }, task.text),
          h("span", { class: "card-meta" }, [
            due ? h("span", { class: { overdue: due.overdue && !task.done } }, `🕒 ${sameDay(task.due!, selectedDay.value) ? timeOfDay(task.due!) : due.label}${due.overdue && !task.done ? " · 已逾期" : ""}`) : null,
            record.title.trim() ? h("span", null, `${due ? " · " : ""}${record.title.trim()}`) : null,
          ]),
        ]),
        h("label", { class: "time-button", title: "设置时间" }, [
          h("span", { "aria-hidden": "true" }, "⏰"),
          h("input", {
            type: "datetime-local", "aria-label": `设置「${task.text}」的时间`, value: toLocalInput(defaultDue),
            onChange: (event: Event) => {
              const value = (event.target as HTMLInputElement).value;
              void updateTask(cardProps.item, { due: value ? new Date(value).getTime() : undefined });
            },
          }),
        ]),
        task.due && !task.done ? h("button", {
          type: "button", class: "calendar-button", "aria-label": `把「${task.text}」加入系统日历`,
          onClick: () => openTaskInCalendar({ id: task.id, text: task.text, due: task.due! }, record.title.trim()),
        }, "📅") : null,
        h("button", {
          type: "button", class: { check: true, on: task.done }, disabled: saving.value === task.id,
          "aria-label": `${task.done ? "取消完成" : "完成"}：${task.text}`, "aria-pressed": task.done,
          onClick: () => void updateTask(cardProps.item, { done: !task.done }),
        }, task.done ? "✓" : ""),
      ];
    };
  },
});
</script>

<style scoped>
.planner{padding:4px 16px 8px}
.week-head{display:flex;align-items:center;justify-content:space-between;margin:6px 0 4px}
.week-head strong{font-size:14px;color:var(--fg-64748b)}
.week-nav{width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:var(--fg-64748b);font-size:20px;cursor:pointer}
.week{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.day{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0;border:0;border-radius:14px;background:transparent;color:var(--fg-0f1419);font:inherit;cursor:pointer}
.day.selected .weekday{padding:0 6px;border-radius:8px;background:var(--bg-eff3f4)}
.day.future{color:var(--fg-b0bac4)}
.weekday{font-size:12px;font-weight:600}
.date{font-size:13px}
.day.today .date{font-weight:700}
.ring{width:34px;height:34px;transform:rotate(-90deg)}
.ring circle{fill:none;stroke-width:4}
.ring-track{stroke:rgba(239,68,68,.16)}
.ring-track.empty{stroke:var(--bg-eff3f4);fill:var(--bg-eff3f4)}
.ring-fill{stroke:#ef6b6b;stroke-linecap:round}
.ring-fill.complete{stroke:#3fa86b}
.plan-head{display:flex;align-items:center;justify-content:space-between;margin:18px 0 10px}
.plan-head strong{font-size:20px}
.add{padding:6px 14px;border:0;border-radius:999px;background:var(--bg-eff3f4);color:var(--fg-0f1419);font:inherit;font-size:14px;cursor:pointer}
.plan-empty{margin:4px 0 12px;color:var(--fg-8b98a5);font-size:14px}
.section-label{margin:14px 0 8px;color:var(--fg-8b98a5);font-size:13px}
.cards{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}
.card{display:flex;align-items:center;gap:10px;padding:12px;border-radius:20px;background:var(--bg-fff);box-shadow:0 1px 2px rgba(15,23,42,.06);transition:opacity .2s}
.card.done{opacity:.45}
.card :deep(.icon){display:grid;width:44px;height:44px;flex:0 0 44px;place-items:center;border-radius:14px;background:var(--bg-f7f9f9);font-size:22px}
.card :deep(.card-main){display:flex;flex:1;min-width:0;flex-direction:column;gap:3px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.card :deep(.card-text){overflow:hidden;color:var(--fg-0f1419);font-size:16px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.card :deep(.card-meta){overflow:hidden;color:var(--fg-8b98a5);font-size:13px;text-overflow:ellipsis;white-space:nowrap}
.card :deep(.overdue){color:#e5484d}
/* iOS gives datetime-local an intrinsic min width that ignores width:100%; clip it to the button so it never covers the check. */
.card :deep(.time-button){position:relative;display:grid;width:32px;height:32px;flex:0 0 32px;place-items:center;overflow:hidden;border-radius:50%;font-size:16px;cursor:pointer}
.card :deep(.time-button input){position:absolute;inset:0;width:100%;min-width:0;max-width:100%;height:100%;margin:0;padding:0;border:0;opacity:0;-webkit-appearance:none;appearance:none;cursor:pointer}
.card :deep(.calendar-button){width:32px;height:32px;padding:0;border:0;border-radius:50%;background:transparent;font-size:16px;cursor:pointer}
.card :deep(.check){position:relative;z-index:1;display:grid;width:30px;height:30px;flex:0 0 30px;place-items:center;padding:0;border:2px solid var(--bd-d8dee5);border-radius:50%;background:transparent;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
.card :deep(.check.on){border-color:#3fa86b;background:#3fa86b}
</style>
