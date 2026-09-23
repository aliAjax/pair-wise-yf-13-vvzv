// 轮机值班偏差复测台 —— 业务规则层
// 纯函数，不接触 DOM / localStorage，负责阈值判定、偏差状态机与交接校验。

export type MetricKey = "rpm" | "oil" | "cool" | "fuel";
export type EquipmentKey = "main" | "gen2" | "pump" | "boiler";

export interface MetricDef {
  key: MetricKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  decimals: number;
}

export interface Reading {
  id: string;
  shift: string;
  equipment: EquipmentKey;
  values: Record<MetricKey, number>;
  at: number; // 时间戳
  bad: MetricKey[]; // 保存时越界参数
  note?: string;
}

export interface Retest {
  id: string;
  at: number;
  shift: string;
  values: Record<MetricKey, number>;
  bad: MetricKey[];
  reason?: string; // 第 3 次及以后失败必填原因
}

export interface Deviation {
  id: string;
  shift: string; // 偏差开立班次（原始记录所在班）
  equipment: EquipmentKey;
  origin: Reading; // 原始记录，永不覆盖
  retests: Retest[];
  status: "open" | "locked" | "resolved";
  resolvedAt?: number;
}

export interface Handover {
  id: string;
  shift: string;
  at: number;
  note: string;
  openCount: number;
  resolvedCount: number;
  lockCount: number;
}

export interface BenchState {
  version: 1;
  readings: Reading[];
  deviations: Deviation[];
  handovers: Handover[];
}

export const METRICS: MetricDef[] = [
  { key: "rpm", label: "主机转速", unit: "rpm", min: 70, max: 95, decimals: 0 },
  { key: "oil", label: "滑油压力", unit: "MPa", min: 0.35, max: 0.55, decimals: 2 },
  { key: "cool", label: "冷却水温", unit: "℃", min: 65, max: 85, decimals: 0 },
  { key: "fuel", label: "燃油累计", unit: "t", min: 0, max: 500, decimals: 1 },
];

export const METRIC_MAP: Record<MetricKey, MetricDef> = METRICS.reduce(
  (acc, m) => ((acc[m.key] = m), acc),
  {} as Record<MetricKey, MetricDef>
);

export const EQUIPMENT: Record<EquipmentKey, string> = {
  main: "主机",
  gen2: "发电机#2",
  pump: "泵组",
  boiler: "辅助锅炉",
};

export const EQUIPMENT_KEYS = Object.keys(EQUIPMENT) as EquipmentKey[];

export const SHIFTS = ["00-04班", "04-08班", "08-12班", "12-16班", "16-20班", "20-24班"];

export const emptyValues: Record<MetricKey, number> = { rpm: 0, oil: 0, cool: 0, fuel: 0 };

export function isOutOfRange(key: MetricKey, value: number): boolean {
  const m = METRIC_MAP[key];
  return !Number.isFinite(value) || value < m.min || value > m.max;
}

export function checkValues(values: Record<MetricKey, number>): MetricKey[] {
  return METRICS.filter((m) => isOutOfRange(m.key, values[m.key])).map((m) => m.key);
}

export function formatValue(key: MetricKey, value: number): string {
  return Number.isFinite(value) ? value.toFixed(METRIC_MAP[key].decimals) : "--";
}

export function formatRange(key: MetricKey): string {
  const m = METRIC_MAP[key];
  return `${m.min}~${m.max} ${m.unit}`;
}

export function findOpenDeviation(
  state: BenchState,
  shift: string,
  equipment: EquipmentKey
): Deviation | undefined {
  return state.deviations.find(
    (d) => d.shift === shift && d.equipment === equipment && d.status !== "resolved"
  );
}

export function failedRetestCount(d: Deviation): number {
  return d.retests.filter((r) => r.bad.length > 0).length;
}

export function isLocked(d: Deviation): boolean {
  return d.status === "locked";
}

/** 当前所有被锁定设备（跨班次，交接时必须全部解除） */
export function lockedEquipment(state: BenchState): Deviation[] {
  return state.deviations.filter((d) => d.status === "locked");
}

export interface SaveReadingInput {
  shift: string;
  equipment: EquipmentKey;
  values: Record<MetricKey, number>;
  note?: string;
  retestReason?: string;
}

export interface SaveReadingResult {
  ok: boolean;
  message: string;
  deviationId?: string;
  locked?: boolean;
  reasonRequired?: boolean; // 第 3 次复测失败，必须填写原因
}

/**
 * 保存一次读数。
 * - 同班同设备存在未结偏差：读数只能作为复测追加，原始记录不覆盖。
 * - 复测全部正常 → 解除，偏差关闭，历史保留。
 * - 复测仍越界 → 设备锁定；第 3 次失败起必须填写原因。
 */
export function saveReading(
  state: BenchState,
  input: SaveReadingInput,
  now: number,
  id: () => string
): SaveReadingResult {
  const bad = checkValues(input.values);
  const existing = findOpenDeviation(state, input.shift, input.equipment);

  if (!existing) {
    const reading: Reading = {
      id: id(),
      shift: input.shift,
      equipment: input.equipment,
      values: { ...input.values },
      at: now,
      bad,
      note: input.note?.trim() || undefined,
    };
    state.readings.push(reading);

    if (bad.length > 0) {
      const deviation: Deviation = {
        id: id(),
        shift: input.shift,
        equipment: input.equipment,
        origin: reading,
        retests: [],
        status: "open",
      };
      state.deviations.push(deviation);
      return {
        ok: true,
        message: "读数越界，已开立偏差，等待复测。",
        deviationId: deviation.id,
      };
    }
    return { ok: true, message: "读数正常，已记入本班。" };
  }

  // 已有未结偏差：新读数只能追加为复测
  const failCount = failedRetestCount(existing);
  if (bad.length > 0 && failCount >= 2 && !input.retestReason?.trim()) {
    return {
      ok: false,
      message: `该设备已连续复测失败 ${failCount} 次，本次失败须填写原因。`,
      deviationId: existing.id,
      reasonRequired: true,
      locked: existing.status === "locked",
    };
  }

  const retest: Retest = {
    id: id(),
    at: now,
    shift: input.shift,
    values: { ...input.values },
    bad,
    reason: bad.length > 0 && failCount >= 2 ? input.retestReason?.trim() || undefined : undefined,
  };
  existing.retests.push(retest);

  if (bad.length > 0) {
    existing.status = "locked";
    return {
      ok: true,
      message:
        failCount >= 2
          ? `复测仍越界，设备保持锁定，原因已记录（第 ${failCount + 1} 次失败）。`
          : "复测仍越界，设备已锁定，请尽快处理。",
      deviationId: existing.id,
      locked: true,
    };
  }

  existing.status = "resolved";
  existing.resolvedAt = now;
  return {
    ok: true,
    message: "复测读数正常，偏差解除、设备解锁；原始偏差与复测历史保留。",
    deviationId: existing.id,
  };
}

/** 交接班：仍有锁定设备时拒绝交接 */
export function performHandover(
  state: BenchState,
  shift: string,
  note: string,
  now: number,
  id: () => string
): { ok: boolean; message: string; handover?: Handover } {
  const locked = lockedEquipment(state);
  if (locked.length > 0) {
    return {
      ok: false,
      message: `交接被拒：仍有 ${locked.length} 台设备处于锁定状态，解除后方可交接。`,
    };
  }
  const inShift = state.deviations.filter((d) => d.shift === shift);
  const handover: Handover = {
    id: id(),
    shift,
    at: now,
    note: note.trim() || "本班参数平稳，无未结事项。",
    openCount: inShift.filter((d) => d.status === "open").length,
    resolvedCount: inShift.filter((d) => d.status === "resolved").length,
    lockCount: 0,
  };
  state.handovers.push(handover);
  return { ok: true, message: `${shift} 交接完成。`, handover };
}

export interface ValueEvent {
  id: string;
  at: number;
  shift: string;
  equipment: EquipmentKey;
  values: Record<MetricKey, number>;
  bad: MetricKey[];
  kind: "原始记录" | "复测";
  retestIndex?: number;
  deviationId?: string;
  reason?: string;
  note?: string;
}

/** 把原始读数与复测展开成同一时间线，供看板取最新值、历史做筛选。 */
export function flattenEvents(state: BenchState): ValueEvent[] {
  const events: ValueEvent[] = state.readings.map((r) => ({
    id: r.id,
    at: r.at,
    shift: r.shift,
    equipment: r.equipment,
    values: r.values,
    bad: r.bad,
    kind: "原始记录" as const,
    note: r.note,
  }));

  for (const d of state.deviations) {
    d.retests.forEach((r, i) => {
      events.push({
        id: r.id,
        at: r.at,
        shift: r.shift,
        equipment: d.equipment,
        values: r.values,
        bad: r.bad,
        kind: "复测",
        retestIndex: i + 1,
        deviationId: d.id,
        reason: r.reason,
      });
    });
  }
  return events.sort((a, b) => b.at - a.at);
}

export function shiftSummary(state: BenchState, shift: string) {
  const readings = state.readings.filter((r) => r.shift === shift).length;
  const deviations = state.deviations.filter((d) => d.shift === shift);
  return {
    readings,
    open: deviations.filter((d) => d.status === "open").length,
    locked: deviations.filter((d) => d.status === "locked").length,
    resolved: deviations.filter((d) => d.status === "resolved").length,
    retests: deviations.reduce((n, d) => n + d.retests.length, 0),
    handovers: state.handovers.filter((h) => h.shift === shift).length,
  };
}

export function initialState(): BenchState {
  return { version: 1, readings: [], deviations: [], handovers: [] };
}
