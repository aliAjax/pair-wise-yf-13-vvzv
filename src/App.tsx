import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  BenchState,
  Deviation,
  EQUIPMENT,
  EQUIPMENT_KEYS,
  EquipmentKey,
  METRICS,
  MetricKey,
  Reading,
  SHIFTS,
  checkValues,
  failedRetestCount,
  findOpenDeviation,
  flattenEvents,
  formatRange,
  formatValue,
  lockedEquipment,
  performHandover,
  saveReading,
  shiftSummary,
} from "./rules";
import {
  EquipmentFilter,
  Prefs,
  defaultPrefs,
  loadPrefs,
  loadState,
  makeId,
  savePrefs,
  saveState,
} from "./storage";

type ValueInputs = Record<MetricKey, string>;

const emptyInputs: ValueInputs = { rpm: "", oil: "", cool: "", fuel: "" };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function formatTime(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface Toast {
  type: "ok" | "error";
  text: string;
}

function App() {
  const [state, setState] = useState<BenchState>(() => loadState());
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const [inputs, setInputs] = useState<ValueInputs>(emptyInputs);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [handoverNote, setHandoverNote] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);

  // 任何变更立即落盘，刷新后不变
  useEffect(() => saveState(state), [state]);
  useEffect(() => savePrefs(prefs), [prefs]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast]);

  const activeDeviation = useMemo(
    () => findOpenDeviation(state, prefs.shift, prefs.target),
    [state, prefs.shift, prefs.target]
  );
  const lockedList = useMemo(() => lockedEquipment(state), [state]);
  const events = useMemo(() => flattenEvents(state), [state]);
  const summary = useMemo(() => shiftSummary(state, prefs.shift), [state, prefs.shift]);

  const parsedValues = useMemo(() => {
    const out = {} as Record<MetricKey, number>;
    for (const m of METRICS) out[m.key] = Number.parseFloat(inputs[m.key]);
    return out;
  }, [inputs]);

  const allFilled = METRICS.every((m) => Number.isFinite(parsedValues[m.key]));
  const pendingBad = allFilled ? checkValues(parsedValues) : [];
  const fails = activeDeviation ? failedRetestCount(activeDeviation) : 0;
  const reasonRequiredNow = !!activeDeviation && fails >= 2 && pendingBad.length > 0;

  function updatePrefs(patch: Partial<Prefs>) {
    setPrefs((p) => ({ ...p, ...patch }));
  }

  function pickEquipment(key: EquipmentFilter) {
    // 筛选与录入目标同步：选具体设备即作为录入对象，选“全部”保留上次目标
    setPrefs((p) => ({ ...p, filter: key, target: key === "all" ? p.target : key }));
  }

  function focusDeviation(d: Deviation) {
    setPrefs((p) => ({ ...p, shift: d.shift, filter: d.equipment, target: d.equipment }));
    setInputs(emptyInputs);
    setNote("");
    setReason("");
    document.querySelector<HTMLElement>(".entry-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function handleSave() {
    if (!allFilled) {
      setToast({ type: "error", text: "请完整填写四项参数读数。" });
      return;
    }
    const draft = clone(state);
    const result = saveReading(
      draft,
      {
        shift: prefs.shift,
        equipment: prefs.target,
        values: parsedValues,
        note,
        retestReason: reason,
      },
      Date.now(),
      makeId
    );

    if (!result.ok) {
      setToast({ type: "error", text: result.message });
      return;
    }

    setState(draft);
    setToast({ type: "ok", text: result.message });
    setInputs(emptyInputs);
    setNote("");
    setReason("");
  }

  function handleHandover() {
    const draft = clone(state);
    const result = performHandover(draft, prefs.shift, handoverNote, Date.now(), makeId);
    if (!result.ok) {
      setToast({ type: "error", text: result.message });
      return;
    }
    setState(draft);
    setHandoverNote("");
    setToast({ type: "ok", text: result.message });
  }

  const boardEvents = events.filter(
    (e) => e.shift === prefs.shift && (prefs.filter === "all" || e.equipment === prefs.filter)
  );

  const visibleDeviations = state.deviations
    .filter((d) => d.shift === prefs.shift && (prefs.filter === "all" || d.equipment === prefs.filter))
    .slice()
    .sort((a, b) => b.origin.at - a.origin.at);

  const originIds = new Set(state.deviations.map((d) => d.origin.id));
  const normalReadings = state.readings
    .filter(
      (r) =>
        r.shift === prefs.shift &&
        (prefs.filter === "all" || r.equipment === prefs.filter) &&
        r.bad.length === 0 &&
        !originIds.has(r.id)
    )
    .sort((a, b) => b.at - a.at);

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62001 · 轮机值班偏差复测台 · Port 62001</p>
        <h1>轮机值班偏差复测台</h1>
        <span>
          每班登记主机转速、滑油压力、冷却水温与燃油累计；读数越界自动开立偏差，同班同设备的后续读数只能追加复测。
          复测仍越界即锁定设备、三次失败须填原因；复测正常方可解除，原始偏差与复测历史全程保留。仍有锁定设备时交接被拒，数据本地保存、刷新不变。
        </span>
      </section>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.text}</div>}

      {lockedList.length > 0 && (
        <div className="lock-banner">
          <b>锁定设备 {lockedList.length} 台：</b>
          {lockedList.map((d) => (
            <span key={d.id} className="lock-tag">
              {EQUIPMENT[d.equipment]}（{d.shift} · 失败 {failedRetestCount(d)} 次）
            </span>
          ))}
          <em>复测恢复正常前，交接班将被拒绝。</em>
        </div>
      )}

      <section className="shift-bar panel">
        <div className="shift-block">
          <span className="bar-label">值班班次</span>
          <div className="chips">
            {SHIFTS.map((s) => (
              <button
                key={s}
                className={s === prefs.shift ? "chip chip-active" : "chip"}
                onClick={() => updatePrefs({ shift: s })}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="shift-block shift-stat">
          <span>
            本班读数 <b>{summary.readings}</b> 条 · 复测 <b>{summary.retests}</b> 次
          </span>
          <span className={summary.open > 0 ? "stat-warn" : ""}>
            未结偏差 <b>{summary.open}</b>
          </span>
          <span className={summary.locked > 0 ? "stat-danger" : ""}>
            锁定 <b>{summary.locked}</b>
          </span>
          <span>已解除 <b>{summary.resolved}</b></span>
        </div>
      </section>

      <section className="metrics">
        {METRICS.map((m) => {
          const latest = boardEvents[0];
          const value = latest ? latest.values[m.key] : NaN;
          const bad = latest ? latest.bad.includes(m.key) : false;
          return (
            <article key={m.key} className={latest ? (bad ? "metric metric-bad" : "metric metric-ok") : "metric"}>
              <small>
                {m.label}
                <em>{formatRange(m.key)}</em>
              </small>
              <strong>
                {latest ? formatValue(m.key, value) : "--"}
                <i>{m.unit}</i>
              </strong>
              <p>
                {latest ? (
                  <>
                    {EQUIPMENT[latest.equipment]} · {formatTime(latest.at)} ·{" "}
                    <span className={bad ? "text-danger" : "text-ok"}>{bad ? "越界" : "正常"}</span>
                    {latest.kind === "复测" ? ` · 复测#${latest.retestIndex}` : ""}
                  </>
                ) : (
                  "本班暂无读数"
                )}
              </p>
            </article>
          );
        })}
      </section>

      <section className="workspace">
        <aside className="panel side-panel">
          <h2>设备筛选</h2>
          <div className="chips">
            <button
              className={prefs.filter === "all" ? "chip chip-active" : "chip"}
              onClick={() => pickEquipment("all")}
            >
              全部设备
            </button>
            {EQUIPMENT_KEYS.map((key) => (
              <button
                key={key}
                className={prefs.filter === key ? "chip chip-active" : "chip"}
                onClick={() => pickEquipment(key)}
              >
                {EQUIPMENT[key]}
              </button>
            ))}
          </div>
          <p className="filter-hint">筛选条件同步作用于参数看板、偏差时间线与本班摘要；选择设备同时切换录入对象。</p>

          <div className="divider" />

          <h2>交接班</h2>
          <label className="stack-label">
            <span>交接备注</span>
            <textarea
              value={handoverNote}
              onChange={(e) => setHandoverNote(e.target.value)}
              placeholder="填写本班运行要点与下一班注意事项"
              rows={3}
            />
          </label>
          <button
            className={lockedList.length > 0 ? "primary handover-btn handover-blocked" : "primary handover-btn"}
            onClick={handleHandover}
          >
            {lockedList.length > 0 ? `交接被锁（${lockedList.length} 台）` : `交接 ${prefs.shift}`}
          </button>

          <div className="divider" />

          <h2>交接记录</h2>
          <div className="handover-list">
            {state.handovers.length === 0 && <p className="muted">尚无交接记录。</p>}
            {state.handovers
              .slice()
              .sort((a, b) => b.at - a.at)
              .map((h) => (
                <div key={h.id} className="handover-item">
                  <b>
                    {h.shift} · {formatTime(h.at)}
                  </b>
                  <span>
                    未结 {h.openCount} · 已解除 {h.resolvedCount}
                  </span>
                  <p>{h.note}</p>
                </div>
              ))}
          </div>
        </aside>

        <section className="panel form-panel entry-panel">
          <div className="heading">
            <div>
              <p>{prefs.shift} · 录入对象：{EQUIPMENT[prefs.target]}</p>
              <h2>{activeDeviation ? "追加偏差复测" : "值班读数登记"}</h2>
            </div>
            <span className={`mode-badge ${activeDeviation ? (activeDeviation.status === "locked" ? "badge-danger" : "badge-warn") : "badge-ok"}`}>
              {activeDeviation
                ? activeDeviation.status === "locked"
                  ? "设备锁定中"
                  : "待复测"
                : "新记录"}
            </span>
          </div>

          {activeDeviation ? (
            <div className={`retest-banner ${activeDeviation.status === "locked" ? "retest-danger" : ""}`}>
              同班同设备已有未结偏差（{formatTime(activeDeviation.origin.at)} 开立），本次保存将作为
              <b> 第 {activeDeviation.retests.length + 1} 次复测追加 </b>
              到该偏差，原始记录不覆盖；已复测失败 <b>{fails}</b> 次。
              {fails >= 2 && pendingBad.length > 0 && <em> 本次仍将越界，失败原因必填。</em>}
              {pendingBad.length === 0 && allFilled && <em> 四项均在限值内，保存后解除锁定。</em>}
            </div>
          ) : (
            <div className="retest-banner">
              按班次保存四项参数；任一越界将自动开立偏差，同班同设备再次读数即转为复测流程。
            </div>
          )}

          <div className="field-grid">
            {METRICS.map((m) => {
              const v = inputs[m.key];
              const bad = v !== "" && Number.isFinite(parsedValues[m.key]) && pendingBad.includes(m.key);
              return (
                <label key={m.key} className={bad ? "field field-bad" : "field"}>
                  <span>
                    {m.label}
                    <em>{formatRange(m.key)}</em>
                  </span>
                  <input
                    inputMode="decimal"
                    placeholder={`填写${m.label}（${m.min}~${m.max}）`}
                    value={inputs[m.key]}
                    onChange={(e) => setInputs((s) => ({ ...s, [m.key]: e.target.value }))}
                  />
                </label>
              );
            })}
          </div>

          <div className="field-grid note-grid">
            <label className="stack-label">
              <span>读数备注</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="工况说明（选填）" />
            </label>
            {activeDeviation && (
              <label className={`stack-label ${reasonRequiredNow ? "field field-bad" : ""}`}>
                <span>
                  复测失败原因{reasonRequiredNow ? "（必填）" : "（第 3 次失败起必填）"}
                </span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={fails >= 2 ? "如：冷却器换热不良，已安排清洗" : "前两次失败可留空，第三次起必填"}
                />
              </label>
            )}
          </div>

          <div className="form-actions">
            <button className="primary" onClick={handleSave}>
              {activeDeviation ? "保存复测（不覆盖原始记录）" : "保存本班读数"}
            </button>
            <button
              onClick={() => {
                setInputs(emptyInputs);
                setNote("");
                setReason("");
              }}
            >
              清空
            </button>
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>偏差时间线 · {prefs.shift}{prefs.filter !== "all" ? ` · ${EQUIPMENT[prefs.filter]}` : ""}</p>
            <h2>偏差与复测历史</h2>
          </div>
          <span className="muted">原始记录与复测均不可删除，解除后仍可查阅</span>
        </div>

        {visibleDeviations.length === 0 && normalReadings.length === 0 && (
          <p className="muted empty-line">当前筛选下暂无记录，先在右上表单登记本班读数。</p>
        )}

        <div className="timeline">
          {visibleDeviations.map((d) => (
            <DeviationCard key={d.id} deviation={d} onRetest={() => focusDeviation(d)} />
          ))}

          {normalReadings.map((r) => (
            <article key={r.id} className="reading-card">
              <b className="seq seq-ok">常</b>
              <div>
                <h3>
                  {EQUIPMENT[r.equipment]} · {r.shift} · 原始记录
                </h3>
                <p className="value-line">
                  <ValueChips reading={r} />
                </p>
                <p className="muted">
                  {formatTime(r.at)}
                  {r.note ? ` · ${r.note}` : ""}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function ValueChips({ reading }: { reading: Reading }) {
  return (
    <>
      {METRICS.map((m) => {
        const bad = reading.bad.includes(m.key);
        return (
          <span key={m.key} className={bad ? "value-chip value-bad" : "value-chip value-ok"}>
            {m.label} {formatValue(m.key, reading.values[m.key])} {m.unit}
            {bad ? " 越界" : ""}
          </span>
        );
      })}
    </>
  );
}

function DeviationCard({ deviation, onRetest }: { deviation: Deviation; onRetest: () => void }) {
  const fails = failedRetestCount(deviation);
  const badgeClass =
    deviation.status === "locked" ? "badge-danger" : deviation.status === "open" ? "badge-warn" : "badge-ok";
  const statusText =
    deviation.status === "locked" ? "设备锁定" : deviation.status === "open" ? "待复测" : "已解除";

  return (
    <article className={`deviation-card dev-${deviation.status}`}>
      <div className="dev-head">
        <b className="seq seq-bad">偏</b>
        <div className="dev-title">
          <h3>
            {EQUIPMENT[deviation.equipment]} · {deviation.shift}
          </h3>
          <p className="muted">
            原始记录 {formatTime(deviation.origin.at)}
            {deviation.origin.note ? ` · ${deviation.origin.note}` : ""}
          </p>
        </div>
        <span className={`mode-badge ${badgeClass}`}>{statusText}</span>
        {deviation.status !== "resolved" && (
          <button className="primary retest-jump" onClick={onRetest}>
            去复测
          </button>
        )}
      </div>

      <div className="dev-row">
        <span className="row-tag">原始读数</span>
        <ValueChips reading={deviation.origin} />
      </div>

      {deviation.retests.length > 0 && (
        <div className="retest-list">
          {deviation.retests.map((r, i) => (
            <div key={r.id} className="dev-row">
              <span className={`row-tag ${r.bad.length > 0 ? "tag-fail" : "tag-pass"}`}>
                复测#{i + 1} {r.bad.length > 0 ? "失败" : "通过"}
              </span>
              <div className="retest-body">
                <p className="value-line">
                  {METRICS.map((m) => {
                    const bad = r.bad.includes(m.key);
                    return (
                      <span key={m.key} className={bad ? "value-chip value-bad" : "value-chip value-ok"}>
                        {m.label} {formatValue(m.key, r.values[m.key])} {m.unit}
                        {bad ? " 越界" : ""}
                      </span>
                    );
                  })}
                </p>
                <p className="muted">
                  {r.shift} · {formatTime(r.at)}
                  {r.reason ? ` · 原因：${r.reason}` : ""}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="dev-foot">
        {deviation.status === "resolved"
          ? `已于 ${deviation.resolvedAt ? formatTime(deviation.resolvedAt) : ""} 复测正常解除，历史完整保留。`
          : fails >= 2
            ? `已连续失败 ${fails} 次，再次失败必须填写原因。`
            : fails === 1
              ? "已复测失败 1 次，设备锁定中；下一次仍越界将累计为第 2 次失败。"
              : "复测尚未进行，等待追加复测读数。"}
      </p>
    </article>
  );
}

export default App;
