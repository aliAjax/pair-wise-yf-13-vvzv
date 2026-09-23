// 轮机值班偏差复测台 —— 本地存储层
// 负责 localStorage 读写、数据迁移/容错与界面偏好同步；不含业务判定。

import {
  BenchState,
  MetricKey,
  METRICS,
  EQUIPMENT_KEYS,
  SHIFTS,
  initialState,
  emptyValues,
  EquipmentKey,
} from "./rules";

const STATE_KEY = "engine-watch-retest-bench:v1";
const PREFS_KEY = "engine-watch-retest-bench:prefs:v1";

export type EquipmentFilter = EquipmentKey | "all";

export interface Prefs {
  shift: string;
  filter: EquipmentFilter;
  target: EquipmentKey;
}

export const defaultPrefs: Prefs = { shift: "08-12班", filter: "all", target: "main" };

export function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function asFiniteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : NaN;
}

function sanitizeValues(v: unknown): Record<MetricKey, number> {
  const src = (v ?? {}) as Record<string, unknown>;
  const out = { ...emptyValues };
  for (const m of METRICS) {
    const n = asFiniteNumber(src[m.key]);
    if (!Number.isNaN(n)) out[m.key] = n;
  }
  return out;
}

function sanitizeBad(v: unknown): MetricKey[] {
  const keys = METRICS.map((m) => m.key);
  return Array.isArray(v) ? (v as unknown[]).filter((k): k is MetricKey => keys.includes(k as MetricKey)) : [];
}

function sanitizeString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** 从历史数据/手改数据中恢复时逐项容错，坏数据回落到空台而不是白屏。 */
export function loadState(): BenchState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as Partial<BenchState>;

    const readings = Array.isArray(parsed.readings)
      ? parsed.readings
          .filter((r) => r && typeof r === "object")
          .map((r) => {
            const x = r as Record<string, unknown>;
            const equipment = EQUIPMENT_KEYS.includes(x.equipment as EquipmentKey)
              ? (x.equipment as EquipmentKey)
              : "main";
            const shift = SHIFTS.includes(x.shift as string) ? (x.shift as string) : SHIFTS[2];
            return {
              id: sanitizeString(x.id) ?? makeId(),
              shift,
              equipment,
              values: sanitizeValues(x.values),
              at: asFiniteNumber(x.at) || Date.now(),
              bad: sanitizeBad(x.bad),
              note: sanitizeString(x.note),
            };
          })
      : [];

    const deviations = Array.isArray(parsed.deviations)
      ? parsed.deviations
          .filter((d) => d && typeof d === "object")
          .map((d) => {
            const x = d as Record<string, unknown>;
            const originSrc = x.origin as Record<string, unknown> | undefined;
            const equipment = EQUIPMENT_KEYS.includes(x.equipment as EquipmentKey)
              ? (x.equipment as EquipmentKey)
              : "main";
            const shift = SHIFTS.includes(x.shift as string) ? (x.shift as string) : SHIFTS[2];
            const origin =
              originSrc && typeof originSrc === "object"
                ? {
                    id: sanitizeString(originSrc.id) ?? makeId(),
                    shift,
                    equipment,
                    values: sanitizeValues(originSrc.values),
                    at: asFiniteNumber(originSrc.at) || Date.now(),
                    bad: sanitizeBad(originSrc.bad),
                    note: sanitizeString(originSrc.note),
                  }
                : {
                    id: makeId(),
                    shift,
                    equipment,
                    values: { ...emptyValues },
                    at: Date.now(),
                    bad: [] as MetricKey[],
                  };
            const retests = Array.isArray(x.retests)
              ? x.retests
                  .filter((r) => r && typeof r === "object")
                  .map((r) => {
                    const y = r as Record<string, unknown>;
                    return {
                      id: sanitizeString(y.id) ?? makeId(),
                      at: asFiniteNumber(y.at) || Date.now(),
                      shift: SHIFTS.includes(y.shift as string) ? (y.shift as string) : shift,
                      values: sanitizeValues(y.values),
                      bad: sanitizeBad(y.bad),
                      reason: sanitizeString(y.reason),
                    };
                  })
              : [];
            const status =
              x.status === "locked" || x.status === "resolved" || x.status === "open"
                ? x.status
                : "open";
            return {
              id: sanitizeString(x.id) ?? makeId(),
              shift,
              equipment,
              origin,
              retests,
              status,
              resolvedAt: asFiniteNumber(x.resolvedAt) || undefined,
            };
          })
      : [];

    const handovers = Array.isArray(parsed.handovers)
      ? parsed.handovers
          .filter((h) => h && typeof h === "object")
          .map((h) => {
            const x = h as Record<string, unknown>;
            return {
              id: sanitizeString(x.id) ?? makeId(),
              shift: SHIFTS.includes(x.shift as string) ? (x.shift as string) : SHIFTS[2],
              at: asFiniteNumber(x.at) || Date.now(),
              note: sanitizeString(x.note) ?? "交接班记录",
              openCount: asFiniteNumber(x.openCount) || 0,
              resolvedCount: asFiniteNumber(x.resolvedCount) || 0,
              lockCount: asFiniteNumber(x.lockCount) || 0,
            };
          })
      : [];

    return { version: 1, readings, deviations, handovers };
  } catch {
    return initialState();
  }
}

/** 任何状态变更后立即写盘，刷新/重开页面后数据不变。 */
export function saveState(state: BenchState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 存储空间受限时静默失败，当前会话仍可用
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...defaultPrefs };
    const parsed = JSON.parse(raw) as Partial<Prefs> & { equipment?: EquipmentKey };
    const legacyEquipment = EQUIPMENT_KEYS.includes(parsed.equipment as EquipmentKey)
      ? (parsed.equipment as EquipmentKey)
      : undefined;
    return {
      shift: SHIFTS.includes(parsed.shift as string) ? (parsed.shift as string) : defaultPrefs.shift,
      filter:
        parsed.filter === "all" || EQUIPMENT_KEYS.includes(parsed.filter as EquipmentKey)
          ? (parsed.filter as EquipmentFilter)
          : legacyEquipment ?? defaultPrefs.filter,
      target: EQUIPMENT_KEYS.includes(parsed.target as EquipmentKey)
        ? (parsed.target as EquipmentKey)
        : legacyEquipment ?? defaultPrefs.target,
    };
  } catch {
    return { ...defaultPrefs };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}
