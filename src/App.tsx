import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  AppData,
  Deviation,
  EQUIPMENT,
  METRICS,
  MetricFields,
  MetricKey,
  MetricSpec,
  MetricValues,
  REASON_REQUIRED_FAILURES,
  WATCHES,
  applySubmit,
  buildSummaryText,
  createShift,
  dateString,
  emptyFields,
  evaluate,
  failureCount,
  findOpenDeviation,
  formatMetric,
  formatTime,
  handoverShift,
  latestReading,
  lockedDeviations,
  shiftLabel,
  summarizeShift,
} from "./rules";
import { loadData, loadPrefs, saveData, savePrefs, type Prefs } from "./storage";

type Notice = { type: "ok" | "warn" | "error"; text: string } | null;

const STATUS_LABEL: Record<Deviation["status"], string> = {
  open: "未结",
  locked: "已锁定",
  resolved: "已解除",
};

function metricLabel(key: MetricKey): string {
  return METRICS.find((m) => m.key === key)?.label ?? key;
}

function MetricLine({
  spec,
  value,
  fail,
}: {
  spec: MetricSpec;
  value?: number;
  fail?: boolean;
}) {
  return (
    <span className={`metric-line${fail ? " is-fail" : ""}`}>
      <em>{spec.label}</em>
      {value === undefined || !Number.isFinite(value) ? "—" : formatMetric(spec, value)}
    </span>
  );
}

function StatusBadge({ status }: { status: Deviation["status"] }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>;
}

function App() {
  const [data, setData] = useState<AppData>(() => loadData());
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const [notice, setNotice] = useState<Notice>(null);

  // 新建班次
  const [newDate, setNewDate] = useState(() => dateString(Date.now()));
  const [newWatch, setNewWatch] = useState<string>(WATCHES[0]);

  // 录入表单
  const [equipment, setEquipment] = useState<string>(EQUIPMENT[0]);
  const [fields, setFields] = useState<MetricFields>(() => emptyFields());
  const [reason, setReason] = useState("");

  // 交接
  const [handoverNote, setHandoverNote] = useState("");

  // 所有变更同步本地存储，刷新后不变
  useEffect(() => saveData(data), [data]);
  useEffect(() => savePrefs(prefs), [prefs]);

  const orderedShifts = useMemo(
    () => [...data.shifts].sort((a, b) => b.createdAt - a.createdAt),
    [data.shifts],
  );

  const currentShift =
    data.shifts.find((s) => s.id === prefs.shiftId) ?? orderedShifts[0];

  // 当前班次失效（如旧档）时回落到最新班次
  useEffect(() => {
    if (currentShift && currentShift.id !== prefs.shiftId) {
      setPrefs((p) => ({ ...p, shiftId: currentShift.id }));
    }
  }, [currentShift, prefs.shiftId]);

  const shiftMap = useMemo(
    () => new Map(data.shifts.map((s) => [s.id, s])),
    [data.shifts],
  );

  const summary = useMemo(
    () => (currentShift ? summarizeShift(data, currentShift.id) : undefined),
    [data, currentShift],
  );

  const globalLocked = useMemo(() => lockedDeviations(data.deviations), [data.deviations]);

  // 同班同设备未结偏差：决定录入表单是“新读数”还是“追加复测”
  const openDeviation = currentShift
    ? findOpenDeviation(data.deviations, currentShift.id, equipment)
    : undefined;

  const lockedByOther = data.deviations.find(
    (d) => d.equipment === equipment && d.status === "locked" && (!currentShift || d.shiftId !== currentShift.id),
  );

  const parsed = useMemo(() => {
    const values = {} as MetricValues;
    let allFilled = true;
    for (const spec of METRICS) {
      const raw = fields[spec.key].trim();
      const v = raw === "" ? NaN : Number(raw);
      values[spec.key] = v;
      if (!Number.isFinite(v)) allFilled = false;
    }
    return { values, allFilled, fails: allFilled ? evaluate(values) : [] };
  }, [fields]);

  const nextFailureCount = openDeviation ? failureCount(openDeviation) + 1 : 0;
  const reasonBlocksSubmit =
    !!openDeviation &&
    parsed.allFilled &&
    parsed.fails.length > 0 &&
    nextFailureCount >= REASON_REQUIRED_FAILURES &&
    reason.trim() === "";

  const formLocked = !currentShift || currentShift.handedOver;

  function updatePrefs(patch: Partial<Prefs>) {
    setPrefs((p) => ({ ...p, ...patch }));
  }

  function handleCreateShift() {
    setNotice(null);
    const res = createShift(data, { date: newDate, watch: newWatch });
    if ("error" in res) {
      setNotice({ type: "error", text: res.error });
      return;
    }
    setData(res.data);
    updatePrefs({ shiftId: res.shift.id });
    setNotice({ type: "ok", text: `已开班：${res.shift.date} ${res.shift.watch}` });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setNotice(null);
    if (!currentShift) {
      setNotice({ type: "error", text: "请先创建值班班次" });
      return;
    }
    const res = applySubmit(data, {
      shiftId: currentShift.id,
      equipment,
      values: parsed.values,
      reason,
    });
    if (res.kind === "error") {
      setNotice({ type: "error", text: res.message });
      return;
    }
    setData(res.data);
    setFields(emptyFields());
    setReason("");
    if (res.kind === "reading") {
      setNotice({ type: "ok", text: `${equipment} 读数正常，已保存到本班记录` });
    } else if (res.kind === "deviation") {
      setNotice({
        type: "warn",
        text: `${equipment} ${res.deviation.original.failMetrics
          .map(metricLabel)
          .join("、")}越界，已建立偏差单；再次读数仅可追加复测，原始记录不可覆盖`,
      });
    } else if (res.deviation.status === "resolved") {
      setNotice({
        type: "ok",
        text: `复测全部正常，${equipment} 已解除锁定，原始偏差与复测历史均保留`,
      });
    } else {
      setNotice({
        type: "error",
        text: `复测仍越界，${equipment} 已锁定（累计失败 ${failureCount(
          res.deviation,
        )} 次）${res.deviation.lockReason ? "，失败原因已留档" : ""}`,
      });
    }
  }

  function handleHandover() {
    if (!currentShift) return;
    setNotice(null);
    const res = handoverShift(data, currentShift.id, handoverNote);
    if ("error" in res) {
      setNotice({
        type: "error",
        text: `交接被拒：${res.error}（${res.locked.map((d) => d.equipment).join("、")}）`,
      });
      return;
    }
    setData(res.data);
    setHandoverNote("");
    setNotice({ type: "ok", text: `${currentShift.date} ${currentShift.watch} 已完成交接` });
  }

  function handleExport() {
    if (!currentShift) return;
    const text = buildSummaryText(data, currentShift.id);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentShift.date}-${currentShift.watch}-交接摘要.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 看板：按设备汇总本班最新读数/偏差状态
  const board = EQUIPMENT.map((eq) => {
    const open = currentShift
      ? findOpenDeviation(data.deviations, currentShift.id, eq)
      : undefined;
    if (open) {
      const last = open.retests.length ? open.retests[open.retests.length - 1] : open.original;
      return {
        eq,
        state: open.status,
        values: last.values,
        fail: new Set(last.failMetrics),
        at: last.at,
      };
    }
    const reading = currentShift
      ? latestReading(data.readings, currentShift.id, eq)
      : undefined;
    const lastResolved = currentShift
      ? data.deviations
          .filter((d) => d.shiftId === currentShift.id && d.equipment === eq && d.status === "resolved")
          .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))[0]
      : undefined;
    if (lastResolved && (!reading || lastResolved.resolvedAt! > reading.at)) {
      const last = lastResolved.retests[lastResolved.retests.length - 1];
      return { eq, state: "resolved" as const, values: last.values, fail: new Set<MetricKey>(), at: last.at };
    }
    if (reading) {
      return { eq, state: "normal" as const, values: reading.values, fail: new Set<MetricKey>(), at: reading.at };
    }
    return { eq, state: "empty" as const, values: undefined, fail: new Set<MetricKey>(), at: 0 };
  });

  const filteredDeviations = useMemo(
    () =>
      [...data.deviations]
        .filter((d) => prefs.equipmentFilter === "all" || d.equipment === prefs.equipmentFilter)
        .filter((d) => prefs.statusFilter === "all" || d.status === prefs.statusFilter)
        .sort((a, b) => b.createdAt - a.createdAt),
    [data.deviations, prefs.equipmentFilter, prefs.statusFilter],
  );

  const filteredReadings = useMemo(
    () =>
      [...data.readings]
        .filter((r) => prefs.equipmentFilter === "all" || r.equipment === prefs.equipmentFilter)
        .sort((a, b) => b.at - a.at),
    [data.readings, prefs.equipmentFilter],
  );

  const boardLabel: Record<string, string> = {
    normal: "运行正常",
    resolved: "复测已解除",
    open: "偏差未结",
    locked: "设备锁定",
    empty: "本班待录入",
  };

  return (
    <main className="app">
      <section className="hero compact">
        <p>hxyfront-62001 · 轮机值班偏差复测台 · Port 62001</p>
        <h1>轮机值班偏差复测台</h1>
        <span>
          每班记录主机转速、滑油压力、冷却水温与燃油累计；同班同设备存在未结偏差时仅可追加复测，
          复测仍越界即锁定设备（三次失败须填原因），复测正常方可解除，原始偏差与复测全程留痕；仍有锁定设备时交接被拒。
        </span>
      </section>

      {/* 班次切换 / 开班 */}
      <section className="panel shifts-panel">
        <div className="heading">
          <div>
            <p>值班班次</p>
            <h2>{currentShift ? shiftLabel(currentShift) : "尚未开班"}</h2>
          </div>
          {currentShift && (
            <span className={`badge badge-${currentShift.handedOver ? "resolved" : "open"}`}>
              {currentShift.handedOver ? "已交接" : "值班中"}
            </span>
          )}
        </div>
        <div className="shift-bar">
          <div className="shift-tabs">
            {orderedShifts.map((s) => (
              <button
                key={s.id}
                className={s.id === currentShift?.id ? "chip active" : "chip"}
                onClick={() => updatePrefs({ shiftId: s.id })}
              >
                {s.date} {s.watch}
                {s.handedOver ? " ✓" : ""}
              </button>
            ))}
          </div>
          <div className="shift-create">
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              aria-label="值班日期"
            />
            <select value={newWatch} onChange={(e) => setNewWatch(e.target.value)} aria-label="班次">
              {WATCHES.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <button className="primary" onClick={handleCreateShift}>
              新建班次
            </button>
          </div>
        </div>
      </section>

      {/* 指标看板 */}
      <section className="metrics">
        <article className={summary && summary.open.length + summary.locked.length > 0 ? "kpi-warn" : ""}>
          <small>本班正常读数</small>
          <strong>{summary?.readingCount ?? 0}</strong>
        </article>
        <article className={summary && summary.open.length > 0 ? "kpi-warn" : ""}>
          <small>本班未结偏差</small>
          <strong>{summary ? summary.open.length + summary.locked.length : 0}</strong>
        </article>
        <article className={globalLocked.length > 0 ? "kpi-danger" : ""}>
          <small>全船锁定设备</small>
          <strong>{globalLocked.length}</strong>
        </article>
        <article>
          <small>本班复测次数</small>
          <strong>{summary?.retestTotal ?? 0}</strong>
        </article>
      </section>

      <section className="panel board-panel">
        <div className="heading">
          <div>
            <p>机舱参数看板</p>
            <h2>{currentShift ? shiftLabel(currentShift) : "无班次"} · 各设备最新状态</h2>
          </div>
        </div>
        <div className="board-grid">
          {board.map((b) => (
            <article key={b.eq} className={`board-card state-${b.state}`}>
              <div className="board-head">
                <h3>{b.eq}</h3>
                <span className={`state-tag state-${b.state}`}>{boardLabel[b.state]}</span>
              </div>
              <div className="board-values">
                {METRICS.map((spec) => (
                  <MetricLine
                    key={spec.key}
                    spec={spec}
                    value={b.values?.[spec.key]}
                    fail={b.fail.has(spec.key)}
                  />
                ))}
              </div>
              <time>{b.at ? formatTime(b.at) : "暂无读数"}</time>
            </article>
          ))}
        </div>
      </section>

      <section className="workspace">
        <aside className="side">
          <section className="panel">
            <h2>筛选</h2>
            <p className="filter-title">设备</p>
            <div className="chips">
              <button
                className={prefs.equipmentFilter === "all" ? "chip active" : "chip"}
                onClick={() => updatePrefs({ equipmentFilter: "all" })}
              >
                全部设备
              </button>
              {EQUIPMENT.map((eq) => (
                <button
                  key={eq}
                  className={prefs.equipmentFilter === eq ? "chip active" : "chip"}
                  onClick={() => updatePrefs({ equipmentFilter: eq })}
                >
                  {eq}
                </button>
              ))}
            </div>
            <p className="filter-title">偏差状态</p>
            <div className="chips">
              {[
                ["all", "全部"],
                ["open", "未结"],
                ["locked", "已锁定"],
                ["resolved", "已解除"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={prefs.statusFilter === value ? "chip active" : "chip"}
                  onClick={() => updatePrefs({ statusFilter: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section className="panel handover-panel">
            <h2>交接班摘要</h2>
            {summary && (
              <>
                <ul className="summary-list">
                  <li>正常读数 <b>{summary.readingCount}</b> 条</li>
                  <li>偏差单：未结 <b>{summary.open.length}</b> · 锁定 <b className={summary.locked.length ? "text-danger" : ""}>{summary.locked.length}</b> · 已解除 <b>{summary.resolved.length}</b></li>
                  <li>复测 <b>{summary.retestTotal}</b> 次，其中越界 <b>{summary.failedRetestTotal}</b> 次</li>
                </ul>
                {globalLocked.length > 0 && (
                  <p className="lock-banner">
                    仍有锁定设备：{globalLocked.map((d) => `${d.equipment}（${shiftLabel(shiftMap.get(d.shiftId))}）`).join("、")}，交接将被拒绝
                  </p>
                )}
                <label className="note-field">
                  <span>交接备注</span>
                  <textarea
                    rows={3}
                    value={handoverNote}
                    disabled={summary.shift.handedOver}
                    placeholder={summary.shift.handedOver ? "该班次已完成交接" : "本班遗留事项、注意要点"}
                    onChange={(e) => setHandoverNote(e.target.value)}
                  />
                </label>
                <div className="handover-actions">
                  <button
                    className="primary"
                    disabled={summary.shift.handedOver}
                    onClick={handleHandover}
                  >
                    {summary.shift.handedOver
                      ? `已交接${summary.shift.handedOverAt ? ` · ${formatTime(summary.shift.handedOverAt)}` : ""}`
                      : "完成交接"}
                  </button>
                  <button onClick={handleExport}>导出摘要</button>
                </div>
              </>
            )}
          </section>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>{openDeviation ? "偏差复测模式" : "参数录入"}</p>
              <h2>{openDeviation ? `追加复测 · ${equipment}` : "保存本班读数"}</h2>
            </div>
            {openDeviation && <StatusBadge status={openDeviation.status} />}
          </div>

          {openDeviation && (
            <div className={`mode-banner mode-${openDeviation.status}`}>
              <b>{equipment} 存在同班未结偏差（{shiftLabel(currentShift)}）</b>
              <span>
                原始越界：{openDeviation.original.failMetrics.map(metricLabel).join("、")}；
                已复测 {openDeviation.retests.length} 次，累计失败 {failureCount(openDeviation)} 次。
                本次读数只能作为复测追加，原始记录不会被覆盖；复测全部正常即解除。
              </span>
            </div>
          )}
          {!openDeviation && lockedByOther && (
            <div className="mode-banner mode-locked">
              <b>{equipment} 已被 {shiftLabel(shiftMap.get(lockedByOther.shiftId))} 的偏差单锁定</b>
              <span>锁定未解除前，该设备不能在其他班次录入新读数，请切回原班次复测正常后再操作。</span>
            </div>
          )}
          {formLocked && currentShift?.handedOver && (
            <div className="mode-banner mode-locked">
              <b>本班次已完成交接</b>
              <span>已交接班次只读，不能再录入或复测；如需继续记录请新建班次。</span>
            </div>
          )}

          {notice && <div className={`notice notice-${notice.type}`}>{notice.text}</div>}

          <form onSubmit={handleSubmit}>
            <label className="full-line">
              <span>设备名称</span>
              <select
                value={equipment}
                disabled={formLocked}
                onChange={(e) => {
                  setEquipment(e.target.value);
                  setReason("");
                }}
              >
                {EQUIPMENT.map((eq) => (
                  <option key={eq} value={eq}>
                    {eq}
                  </option>
                ))}
              </select>
            </label>
            <div className="field-grid">
              {METRICS.map((spec) => (
                <label key={spec.key}>
                  <span>
                    {spec.label}（{spec.unit}）
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={spec.step}
                    disabled={formLocked}
                    placeholder={`正常区间 ${spec.min} ~ ${spec.max}`}
                    value={fields[spec.key]}
                    onChange={(e) =>
                      setFields((f) => ({ ...f, [spec.key]: e.target.value }))
                    }
                  />
                </label>
              ))}
            </div>

            {openDeviation && (
              <label className="full-line">
                <span>
                  失败原因
                  {nextFailureCount >= REASON_REQUIRED_FAILURES && <b className="required">（本次若仍越界，第 {nextFailureCount} 次失败必填）</b>}
                  {openDeviation.lockReason && <em className="filled-reason">已留档：{openDeviation.lockReason}</em>}
                </span>
                <input
                  type="text"
                  disabled={formLocked}
                  value={reason}
                  placeholder="三次失败后必须填写原因，例如：冷却器堵塞待清洗"
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}

            {reasonBlocksSubmit && (
              <div className="notice notice-error">
                本次复测仍有越界指标，将构成第 {nextFailureCount} 次失败，请先填写失败原因。
              </div>
            )}

            <div className="form-actions">
              <button className="primary" type="submit" disabled={formLocked || reasonBlocksSubmit}>
                {openDeviation ? "提交复测" : "保存读数"}
              </button>
              <button
                type="button"
                disabled={formLocked}
                onClick={() => {
                  setFields(emptyFields());
                  setReason("");
                }}
              >
                清空
              </button>
            </div>
          </form>
        </section>
      </section>

      {/* 偏差单时间线 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>偏差与复测时间线</p>
            <h2>偏差单（{filteredDeviations.length}）</h2>
          </div>
        </div>
        {filteredDeviations.length === 0 ? (
          <p className="empty-hint">当前筛选条件下没有偏差单。</p>
        ) : (
          <div className="dev-list">
            {filteredDeviations.map((d) => (
              <article key={d.id} className={`dev-card status-${d.status}`}>
                <div className="dev-head">
                  <div>
                    <h3>{d.equipment}</h3>
                    <small>{shiftLabel(shiftMap.get(d.shiftId))} · 建单 {formatTime(d.createdAt)}</small>
                  </div>
                  <StatusBadge status={d.status} />
                </div>

                <div className="judged judged-original">
                  <div className="judged-head">
                    <b>原始记录 · 不可覆盖</b>
                    <time>{formatTime(d.original.at)}</time>
                  </div>
                  <div className="judged-values">
                    {METRICS.map((spec) => (
                      <MetricLine
                        key={spec.key}
                        spec={spec}
                        value={d.original.values[spec.key]}
                        fail={d.original.failMetrics.includes(spec.key)}
                      />
                    ))}
                  </div>
                </div>

                {d.retests.map((r, i) => (
                  <div
                    key={r.id}
                    className={`judged judged-retest ${r.failMetrics.length ? "retest-fail" : "retest-ok"}`}
                  >
                    <div className="judged-head">
                      <b>
                        复测 {i + 1} · {r.failMetrics.length ? "仍越界" : "全部正常"}
                      </b>
                      <time>{formatTime(r.at)}</time>
                    </div>
                    <div className="judged-values">
                      {METRICS.map((spec) => (
                        <MetricLine
                          key={spec.key}
                          spec={spec}
                          value={r.values[spec.key]}
                          fail={r.failMetrics.includes(spec.key)}
                        />
                      ))}
                    </div>
                    {r.reason && <p className="retest-reason">失败原因：{r.reason}</p>}
                  </div>
                ))}

                <div className="dev-foot">
                  累计失败 {failureCount(d)} 次 · 复测 {d.retests.length} 次
                  {d.lockReason && <span className="foot-reason"> · 锁定原因：{d.lockReason}</span>}
                  {d.status === "resolved" && d.resolvedAt && (
                    <span className="foot-resolved"> · 解除于 {formatTime(d.resolvedAt)}</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 正常读数历史 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>正常读数（{filteredReadings.length}）</h2>
          </div>
        </div>
        {filteredReadings.length === 0 ? (
          <p className="empty-hint">暂无正常读数，越界读数已归入偏差单。</p>
        ) : (
          <div className="records">
            {filteredReadings.map((r, i) => (
              <article key={r.id}>
                <b>{String(i + 1).padStart(2, "0")}</b>
                <div>
                  <h3>
                    {r.equipment} · {shiftLabel(shiftMap.get(r.shiftId))}
                  </h3>
                  <p className="reading-values">
                    {METRICS.map((spec) => (
                      <span key={spec.key} className="reading-chip">
                        {spec.label} {formatMetric(spec, r.values[spec.key])}
                      </span>
                    ))}
                  </p>
                  <small className="reading-time">{formatTime(r.at)}</small>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
