// 轮机值班偏差复测台 —— 业务规则层
// 阈值判定、偏差单/复测/锁定/解除/三次失败原因、交接校验均在此处，纯函数无副作用。

export const DATA_VERSION = 1 as const;

export type MetricKey = "rpm" | "lubeOil" | "coolant" | "fuel";

export interface MetricSpec {
  key: MetricKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  digits: number;
  step: string;
}

// 正常区间为闭区间，超出 min/max 即判越界
export const METRICS: MetricSpec[] = [
  { key: "rpm", label: "主机转速", unit: "rpm", min: 65, max: 98, digits: 0, step: "1" },
  { key: "lubeOil", label: "滑油压力", unit: "MPa", min: 0.3, max: 0.5, digits: 2, step: "0.01" },
  { key: "coolant", label: "冷却水温", unit: "℃", min: 60, max: 85, digits: 1, step: "0.1" },
  { key: "fuel", label: "燃油累计", unit: "L", min: 0, max: 99999, digits: 1, step: "0.1" },
];

export const EQUIPMENT = ["主机", "发电机#1", "发电机#2", "舱底泵组"] as const;

export const WATCHES = [
  "00-04班",
  "04-08班",
  "08-12班",
  "12-16班",
  "16-20班",
  "20-24班",
] as const;

// 累计失败（原始越界算第 1 次）达到此次数后，再提交失败复测必须填写原因
export const REASON_REQUIRED_FAILURES = 3;

export type MetricValues = Record<MetricKey, number>;
export type MetricFields = Record<MetricKey, string>;

export function emptyFields(): MetricFields {
  return { rpm: "", lubeOil: "", coolant: "", fuel: "" };
}

export interface Reading {
  id: string;
  at: number;
  values: MetricValues;
}

/** 正常保存的本班读数 */
export interface RecordedReading extends Reading {
  shiftId: string;
  equipment: string;
}

/** 带越界判定的读数（偏差原始记录 / 复测共用） */
export interface JudgedReading extends Reading {
  failMetrics: MetricKey[];
}

export interface Retest extends JudgedReading {
  /** 第 3 次失败起强制填写的原因 */
  reason?: string;
}

export type DeviationStatus = "open" | "locked" | "resolved";

export interface Deviation {
  id: string;
  shiftId: string;
  equipment: string;
  /** 原始越界读数，建立后永不覆盖 */
  original: JudgedReading;
  retests: Retest[];
  status: DeviationStatus;
  /** 最近一次必填失败原因（三次失败留档） */
  lockReason?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface Shift {
  id: string;
  date: string; // yyyy-MM-dd
  watch: string;
  createdAt: number;
  handedOver: boolean;
  handedOverAt?: number;
  note?: string;
}

export interface AppData {
  version: typeof DATA_VERSION;
  shifts: Shift[];
  readings: RecordedReading[];
  deviations: Deviation[];
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function dateString(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatMetric(spec: MetricSpec, value: number): string {
  return `${value.toFixed(spec.digits)} ${spec.unit}`;
}

export function shiftLabel(shift: Shift | undefined): string {
  return shift ? `${shift.date} ${shift.watch}` : "未开班";
}

/** 返回越界指标，空数组表示全部正常 */
export function evaluate(values: MetricValues): MetricKey[] {
  const failed: MetricKey[] = [];
  for (const spec of METRICS) {
    const v = values[spec.key];
    if (!Number.isFinite(v) || v < spec.min || v > spec.max) failed.push(spec.key);
  }
  return failed;
}

export function isOpen(d: Deviation): boolean {
  return d.status !== "resolved";
}

/** 同班同设备的未结偏差（未结 = 未解除，含未结与已锁定） */
export function findOpenDeviation(
  deviations: Deviation[],
  shiftId: string,
  equipment: string,
): Deviation | undefined {
  return deviations.find(
    (d) => d.shiftId === shiftId && d.equipment === equipment && isOpen(d),
  );
}

export function lockedDeviations(deviations: Deviation[]): Deviation[] {
  return deviations.filter((d) => d.status === "locked");
}

/** 原始越界计第 1 次失败，之后每次复测越界累加 */
export function failureCount(d: Deviation): number {
  return 1 + d.retests.filter((r) => r.failMetrics.length > 0).length;
}

export interface SubmitInput {
  shiftId: string;
  equipment: string;
  values: MetricValues;
  reason?: string;
  at?: number;
}

export type SubmitResult =
  | { kind: "reading"; data: AppData; reading: RecordedReading }
  | { kind: "deviation"; data: AppData; deviation: Deviation }
  | { kind: "retest"; data: AppData; deviation: Deviation; retest: Retest }
  | { kind: "error"; message: string };

/**
 * 提交一组本班读数：
 * - 同班同设备有未结偏差：只能追加复测，原始记录不动；
 * - 复测仍越界：锁定设备；累计第 3 次失败起必须填原因；
 * - 复测全部正常：解除并保留全部历史；
 * - 无未结偏差且设备被其他班锁定：拒绝录入；
 * - 无未结偏差且越界：建立偏差单（原始记录即此次读数）；
 * - 全部正常：保存为普通读数。
 */
export function applySubmit(data: AppData, input: SubmitInput): SubmitResult {
  const at = input.at ?? Date.now();
  const shift = data.shifts.find((s) => s.id === input.shiftId);
  if (!shift) return { kind: "error", message: "请先选择值班班次" };
  if (shift.handedOver)
    return { kind: "error", message: "该班次已完成交接，不能再录入读数" };

  for (const spec of METRICS) {
    if (!Number.isFinite(input.values[spec.key]))
      return { kind: "error", message: `请填写有效的${spec.label}` };
  }

  const failMetrics = evaluate(input.values);
  const open = findOpenDeviation(data.deviations, input.shiftId, input.equipment);

  // —— 复测分支：只允许追加，不覆盖原始记录 ——
  if (open) {
    if (failMetrics.length > 0) {
      const failuresAfter = failureCount(open) + 1;
      const reason = input.reason?.trim();
      if (failuresAfter >= REASON_REQUIRED_FAILURES && !reason) {
        return {
          kind: "error",
          message: `复测仍越界且已是第 ${failuresAfter} 次失败，必须填写失败原因后才能提交`,
        };
      }
      const retest: Retest = {
        id: uid("retest"),
        at,
        values: { ...input.values },
        failMetrics,
        reason: reason || undefined,
      };
      const updated: Deviation = {
        ...open,
        status: "locked",
        retests: [...open.retests, retest],
        lockReason: failuresAfter >= REASON_REQUIRED_FAILURES ? reason : open.lockReason,
      };
      return {
        kind: "retest",
        data: replaceDeviation(data, updated),
        deviation: updated,
        retest,
      };
    }

    const retest: Retest = {
      id: uid("retest"),
      at,
      values: { ...input.values },
      failMetrics: [],
    };
    const updated: Deviation = {
      ...open,
      status: "resolved",
      retests: [...open.retests, retest],
      resolvedAt: at,
    };
    return {
      kind: "retest",
      data: replaceDeviation(data, updated),
      deviation: updated,
      retest,
    };
  }

  // 设备被其他班次的未结锁定单占用
  const lockedElsewhere = data.deviations.find(
    (d) => d.equipment === input.equipment && d.status === "locked",
  );
  if (lockedElsewhere) {
    const owner = data.shifts.find((s) => s.id === lockedElsewhere.shiftId);
    return {
      kind: "error",
      message: `${input.equipment} 已被 ${shiftLabel(owner)} 的偏差单锁定，请先在该班次复测解除`,
    };
  }

  if (failMetrics.length > 0) {
    const deviation: Deviation = {
      id: uid("dev"),
      shiftId: input.shiftId,
      equipment: input.equipment,
      original: {
        id: uid("orig"),
        at,
        values: { ...input.values },
        failMetrics,
      },
      retests: [],
      status: "open",
      createdAt: at,
    };
    return {
      kind: "deviation",
      data: { ...data, deviations: [...data.deviations, deviation] },
      deviation,
    };
  }

  const reading: RecordedReading = {
    id: uid("reading"),
    shiftId: input.shiftId,
    equipment: input.equipment,
    at,
    values: { ...input.values },
  };
  return {
    kind: "reading",
    data: { ...data, readings: [...data.readings, reading] },
    reading,
  };
}

function replaceDeviation(data: AppData, next: Deviation): AppData {
  return {
    ...data,
    deviations: data.deviations.map((d) => (d.id === next.id ? next : d)),
  };
}

export interface CreateShiftInput {
  date: string;
  watch: string;
  at?: number;
}

export function createShift(
  data: AppData,
  input: CreateShiftInput,
): { data: AppData; shift: Shift } | { error: string } {
  if (!input.date) return { error: "请选择值班日期" };
  if (data.shifts.some((s) => s.date === input.date && s.watch === input.watch))
    return { error: `${input.date} ${input.watch} 已经开班，请勿重复创建` };

  const shift: Shift = {
    id: uid("shift"),
    date: input.date,
    watch: input.watch,
    createdAt: input.at ?? Date.now(),
    handedOver: false,
  };
  return { data: { ...data, shifts: [...data.shifts, shift] }, shift };
}

/** 交接：仍有锁定设备时一律拒绝 */
export function handoverShift(
  data: AppData,
  shiftId: string,
  note: string,
  at = Date.now(),
): { data: AppData } | { error: string; locked: Deviation[] } {
  const locked = lockedDeviations(data.deviations);
  if (locked.length > 0) {
    return {
      error: `仍有 ${locked.length} 台设备处于锁定状态，交接被拒，请复测正常后再交接`,
      locked,
    };
  }
  const shifts = data.shifts.map((s) =>
    s.id === shiftId
      ? { ...s, handedOver: true, handedOverAt: at, note: note.trim() || s.note }
      : s,
  );
  return { data: { ...data, shifts } };
}

export function latestReading(
  readings: RecordedReading[],
  shiftId: string,
  equipment?: string,
): RecordedReading | undefined {
  const list = readings
    .filter((r) => r.shiftId === shiftId && (!equipment || r.equipment === equipment))
    .sort((a, b) => b.at - a.at);
  return list[0];
}

export interface ShiftSummary {
  shift: Shift;
  readingCount: number;
  deviations: Deviation[];
  open: Deviation[];
  locked: Deviation[];
  resolved: Deviation[];
  retestTotal: number;
  failedRetestTotal: number;
}

export function summarizeShift(data: AppData, shiftId: string): ShiftSummary | undefined {
  const shift = data.shifts.find((s) => s.id === shiftId);
  if (!shift) return undefined;
  const deviations = data.deviations
    .filter((d) => d.shiftId === shiftId)
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    shift,
    readingCount: data.readings.filter((r) => r.shiftId === shiftId).length,
    deviations,
    open: deviations.filter((d) => d.status === "open"),
    locked: deviations.filter((d) => d.status === "locked"),
    resolved: deviations.filter((d) => d.status === "resolved"),
    retestTotal: deviations.reduce((n, d) => n + d.retests.length, 0),
    failedRetestTotal: deviations.reduce(
      (n, d) => n + d.retests.filter((r) => r.failMetrics.length > 0).length,
      0,
    ),
  };
}

export function buildSummaryText(data: AppData, shiftId: string): string {
  const summary = summarizeShift(data, shiftId);
  if (!summary) return "暂无班次信息";
  const lines: string[] = [];
  lines.push(`交接班摘要：${summary.shift.date} ${summary.shift.watch}`);
  lines.push(`本班读数：${summary.readingCount} 条；复测 ${summary.retestTotal} 次（越界 ${summary.failedRetestTotal} 次）`);
  lines.push(
    `偏差单：未结 ${summary.open.length}，锁定 ${summary.locked.length}，已解除 ${summary.resolved.length}`,
  );
  for (const d of summary.deviations) {
    const status = d.status === "open" ? "未结" : d.status === "locked" ? "已锁定" : "已解除";
    lines.push(`- [${status}] ${d.equipment}，累计失败 ${failureCount(d)} 次，复测 ${d.retests.length} 次${d.lockReason ? `，原因：${d.lockReason}` : ""}`);
  }
  const globalLocked = lockedDeviations(data.deviations);
  lines.push(
    globalLocked.length
      ? `全船锁定设备：${globalLocked.map((d) => d.equipment).join("、")}（交接被拒）`
      : "全船无锁定设备，可以交接",
  );
  if (summary.shift.note) lines.push(`交接备注：${summary.shift.note}`);
  return lines.join("\n");
}

/** 首次打开时的示例数据（仅本地无存档时使用） */
export function buildSeedData(now = Date.now()): AppData {
  const shift: Shift = {
    id: "shift-seed",
    date: dateString(now),
    watch: "08-12班",
    createdAt: now,
    handedOver: false,
  };
  return {
    version: DATA_VERSION,
    shifts: [shift],
    readings: [
      {
        id: "reading-seed",
        shiftId: shift.id,
        equipment: "主机",
        at: now - 42 * 60 * 1000,
        values: { rpm: 82, lubeOil: 0.42, coolant: 78, fuel: 12460 },
      },
    ],
    deviations: [
      {
        id: "dev-seed",
        shiftId: shift.id,
        equipment: "发电机#2",
        original: {
          id: "orig-seed",
          at: now - 18 * 60 * 1000,
          values: { rpm: 75, lubeOil: 0.41, coolant: 88.8, fuel: 8200 },
          failMetrics: ["coolant"],
        },
        retests: [],
        status: "open",
        createdAt: now - 18 * 60 * 1000,
      },
    ],
  };
}
