// 轮机值班偏差复测台 —— 本地存储层
// localStorage 读写、数据校验与界面偏好（当前班次/筛选）持久化，刷新后状态不变。

import {
  AppData,
  DATA_VERSION,
  Deviation,
  MetricKey,
  RecordedReading,
  Shift,
  buildSeedData,
} from "./rules";

const DATA_KEY = "hxyfront-62001:engine-watch:data:v1";
const PREFS_KEY = "hxyfront-62001:engine-watch:prefs:v1";

const METRIC_KEYS: MetricKey[] = ["rpm", "lubeOil", "coolant", "fuel"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function asMetricValues(v: unknown): Record<MetricKey, number> | null {
  if (!isRecord(v)) return null;
  for (const key of METRIC_KEYS) {
    if (!isNum(v[key])) return null;
  }
  return {
    rpm: v.rpm as number,
    lubeOil: v.lubeOil as number,
    coolant: v.coolant as number,
    fuel: v.fuel as number,
  };
}

function asReading(v: unknown): RecordedReading | null {
  if (!isRecord(v) || !isStr(v.id) || !isNum(v.at)) return null;
  const values = asMetricValues(v.values);
  if (!values || !isStr(v.shiftId) || !isStr(v.equipment)) return null;
  return {
    id: v.id,
    at: v.at,
    shiftId: v.shiftId,
    equipment: v.equipment,
    values,
  };
}

function asDeviation(v: unknown): Deviation | null {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.shiftId) || !isStr(v.equipment))
    return null;
  const orig = isRecord(v.original) ? v.original : null;
  const origValues = orig ? asMetricValues(orig.values) : null;
  if (
    !orig ||
    !isStr(orig.id) ||
    !isNum(orig.at) ||
    !origValues ||
    !Array.isArray(orig.failMetrics)
  )
    return null;
  if (!["open", "locked", "resolved"].includes(String(v.status))) return null;
  if (!Array.isArray(v.retests)) return null;
  const retests = [];
  for (const r of v.retests) {
    if (!isRecord(r) || !isStr(r.id) || !isNum(r.at)) return null;
    const values = asMetricValues(r.values);
    if (!values || !Array.isArray(r.failMetrics)) return null;
    retests.push({
      id: r.id,
      at: r.at,
      values,
      failMetrics: r.failMetrics.filter(isStr) as MetricKey[],
      ...(isStr(r.reason) && r.reason.trim() ? { reason: r.reason } : {}),
    });
  }
  return {
    id: v.id,
    shiftId: v.shiftId,
    equipment: v.equipment,
    original: {
      id: orig.id,
      at: orig.at,
      values: origValues,
      failMetrics: orig.failMetrics.filter(isStr) as MetricKey[],
    },
    retests,
    status: v.status as Deviation["status"],
    ...(isStr(v.lockReason) && v.lockReason.trim() ? { lockReason: v.lockReason } : {}),
    createdAt: isNum(v.createdAt) ? v.createdAt : 0,
    ...(isNum(v.resolvedAt) ? { resolvedAt: v.resolvedAt } : {}),
  };
}

function asShift(v: unknown): Shift | null {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.date) || !isStr(v.watch)) return null;
  return {
    id: v.id,
    date: v.date,
    watch: v.watch,
    createdAt: isNum(v.createdAt) ? v.createdAt : 0,
    handedOver: v.handedOver === true,
    ...(isNum(v.handedOverAt) ? { handedOverAt: v.handedOverAt } : {}),
    ...(isStr(v.note) ? { note: v.note } : {}),
  };
}

/** 校验存档；结构不符或版本不符时返回 null（回落到示例数据） */
export function validateData(raw: unknown): AppData | null {
  if (!isRecord(raw) || raw.version !== DATA_VERSION) return null;
  if (!Array.isArray(raw.shifts) || !Array.isArray(raw.readings) || !Array.isArray(raw.deviations))
    return null;

  const shifts = raw.shifts.map(asShift).filter((s): s is Shift => s !== null);
  const readings = raw.readings
    .map(asReading)
    .filter((r): r is RecordedReading => r !== null);
  const deviations = raw.deviations
    .map(asDeviation)
    .filter((d): d is Deviation => d !== null);

  // 偏差引用的班次必须存在，否则视为坏档
  const shiftIds = new Set(shifts.map((s) => s.id));
  if (deviations.some((d) => !shiftIds.has(d.shiftId))) return null;

  return { version: DATA_VERSION, shifts, readings, deviations };
}

export function loadData(): AppData {
  try {
    const text = localStorage.getItem(DATA_KEY);
    if (text) {
      const parsed: unknown = JSON.parse(text);
      const valid = validateData(parsed);
      if (valid) return valid;
    }
  } catch {
    // localStorage 不可用或 JSON 损坏时回落示例数据
  }
  return buildSeedData();
}

export function saveData(data: AppData): void {
  try {
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
  } catch {
    // 存储已满或被禁用：界面仍可用，仅不落盘
  }
}

export interface Prefs {
  shiftId?: string;
  equipmentFilter: string; // "all" 或具体设备
  statusFilter: string; // "all" | "open" | "locked" | "resolved"
}

export const DEFAULT_PREFS: Prefs = {
  equipmentFilter: "all",
  statusFilter: "all",
};

export function loadPrefs(): Prefs {
  try {
    const text = localStorage.getItem(PREFS_KEY);
    if (text) {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        return {
          shiftId: isStr(parsed.shiftId) ? parsed.shiftId : undefined,
          equipmentFilter: isStr(parsed.equipmentFilter) ? parsed.equipmentFilter : "all",
          statusFilter: isStr(parsed.statusFilter) ? parsed.statusFilter : "all",
        };
      }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}
