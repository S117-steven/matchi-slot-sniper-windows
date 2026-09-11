/* MATCHi 场地抢订桌面控制台 */

let running = false;
let maxChargeEdited = false;
let releaseInstant = null;
let countdownTimer = null;
let valueCards = [];
let preferredValueCardId = null;
const logLines = [];

const $ = (id) => document.getElementById(id);

window.addLog = function(message, level = "info") {
  const now = new Date().toTimeString().slice(0, 8);
  const prefix = level === "error" ? "错误" : level === "warning" ? "注意" : "信息";
  logLines.push(`[${now}] [${prefix}] ${message}`);
  if (logLines.length > 600) logLines.splice(0, logLines.length - 600);
  const consoleEl = $("log-console");
  consoleEl.textContent = logLines.join("\n");
  consoleEl.parentElement.scrollTop = consoleEl.parentElement.scrollHeight;
};

function setCard(which, state, detail, className = "state-idle") {
  const stateEl = $(`state-${which}`);
  const detailEl = $(`detail-${which}`);
  stateEl.textContent = state;
  stateEl.className = `card-state ${className}`;
  detailEl.textContent = detail || "—";
}

function setProgress(percent, text) {
  const container = $("progress-container");
  if (percent === null) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  $("progress-bar").style.width = `${Math.max(2, Math.min(100, percent))}%`;
  $("progress-text").textContent = text || "";
}

function setRunning(value) {
  running = value;
  $("btn-start").disabled = value;
  $("btn-stop").disabled = !value;
  document.querySelectorAll(".settings-card input, .settings-card select, .settings-card button").forEach((element) => {
    element.disabled = value;
  });
  $("run-caption").textContent = value ? "窗口关闭会停止任务" : "尚未启动";
  if (!value) updateOverbookingPreview();
}

function selectedMode() {
  return document.querySelector('input[name="run-mode"]:checked').value;
}

function updatePaymentVisibility() {
  $("payment-settings").classList.toggle("hidden", selectedMode() !== "value-card");
}

function clampOverbook(value) {
  return Math.max(0, Math.min(6, Math.trunc(Number(value) || 0)));
}

function updateOverbookingPreview() {
  const enabled = $("allow-overbooking").checked;
  const extra = enabled ? clampOverbook($("max-overbook").value) : 0;
  $("max-overbook").disabled = !enabled || running;
  $("overbooking-settings").classList.toggle("disabled", !enabled);
  $("maximum-courts-preview").textContent = enabled
    ? `${clampQuantity($("quantity").value)} + ${extra} = ${clampQuantity($("quantity").value) + extra} 块`
    : `${clampQuantity($("quantity").value)} 块（不允许超订）`;
}

function selectedValueCard() {
  const id = Number($("value-card-select").value || 0);
  return valueCards.find((card) => Number(card.id) === id) || null;
}

function updateValueCardSummary() {
  const card = selectedValueCard();
  if (!valueCards.length) {
    $("value-card-summary").textContent = "尚未读取 Value Card";
    $("value-card-help").textContent = "输入邮箱和密码后读取实时余额";
    return;
  }
  if (!card) {
    $("value-card-summary").textContent = `检测到 ${valueCards.length} 张 Value Card`;
    $("value-card-help").textContent = "请选择本次实际支付使用的卡片";
    return;
  }
  $("value-card-summary").textContent = `${card.balance.toFixed(2)} ${card.currency} 可用`;
  $("value-card-help").textContent = `账号共 ${valueCards.length} 张 · 卡片 ID ${card.id} · ${card.name}${card.validUntil ? ` · 有效至 ${card.validUntil}` : ""}`;
}

function clearValueCards() {
  valueCards = [];
  const select = $("value-card-select");
  select.textContent = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "请先读取账号 Value Card";
  select.appendChild(option);
  select.disabled = true;
  updateValueCardSummary();
}

async function loadValueCards() {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !email.includes("@") || !password) {
    window.addLog("请先输入有效邮箱和密码，再读取 Value Card", "error");
    return;
  }
  const button = $("btn-load-cards");
  button.disabled = true;
  button.textContent = "读取中…";
  try {
    const raw = await window.pywebview.api.get_value_cards(email, password);
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    valueCards = Array.isArray(data.cards) ? data.cards : [];
    const select = $("value-card-select");
    select.textContent = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = valueCards.length ? `请选择卡片（共 ${valueCards.length} 张）` : "账号没有可支付的 Value Card";
    select.appendChild(placeholder);
    for (const card of valueCards) {
      const option = document.createElement("option");
      option.value = String(card.id);
      option.textContent = `${card.balance.toFixed(2)} ${card.currency} · ${card.name} · ID ${card.id}`;
      select.appendChild(option);
    }
    select.disabled = valueCards.length === 0;
    if (preferredValueCardId && valueCards.some((card) => Number(card.id) === Number(preferredValueCardId))) {
      select.value = String(preferredValueCardId);
    }
    updateValueCardSummary();
    window.addLog(`读取成功：账号共有 ${valueCards.length} 张可支付 Value Card`);
  } catch (error) {
    clearValueCards();
    window.addLog(`读取 Value Card 失败：${error}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "读取余额";
  }
}

function clampQuantity(value) {
  return Math.max(1, Math.min(6, Number(value) || 1));
}

function estimateCharge() {
  if (maxChargeEdited) return;
  const quantity = clampQuantity($("quantity").value);
  const overbook = $("allow-overbooking").checked ? clampOverbook($("max-overbook").value) : 0;
  const hours = Number($("duration").value || 60) / 60;
  const targetDate = $("target-date").value;
  const hour = Number(($("start-time").value || "07:00").split(":")[0]);
  const weekday = targetDate ? new Date(`${targetDate}T12:00:00`).getDay() : 1;
  const weekdayMorning = weekday >= 1 && weekday <= 5 && hour < 16;
  const estimatePerCourtHour = weekdayMorning ? 70 : 210;
  $("max-charge").value = String(Math.round(estimatePerCourtHour * (quantity + overbook) * hours));
}

function updateReleasePreview() {
  const value = $("target-date").value;
  if (!value) {
    releaseInstant = null;
    $("release-time").textContent = "请选择日期";
    $("countdown").textContent = "—";
    return;
  }
  const target = new Date(`${value}T00:00:00`);
  target.setDate(target.getDate() - 14);
  target.setHours(0, 0, 0, 0);
  releaseInstant = target;
  $("release-time").textContent = `${target.toLocaleDateString("zh-CN")} 00:00 · Europe/Stockholm`;
  updateCountdown();
}

function updateCountdown() {
  if (!releaseInstant) return;
  const diff = releaseInstant.getTime() - Date.now();
  if (diff <= 0) {
    $("countdown").textContent = "已开放 / 立即检查";
    return;
  }
  const seconds = Math.floor(diff / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  $("countdown").textContent = days > 0
    ? `${days}天 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
    : `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function buildConfig() {
  const valueCard = selectedValueCard();
  return {
    email: $("email").value.trim(),
    password: $("password").value,
    facility: $("facility").value,
    targetDate: $("target-date").value,
    startTime: $("start-time").value,
    durationMinutes: Number($("duration").value),
    quantity: clampQuantity($("quantity").value),
    allowNonConsecutiveCourts: $("allow-scattered").checked,
    allowOverbookingOnUncertain: $("allow-overbooking").checked,
    maxOverbookCourts: $("allow-overbooking").checked ? clampOverbook($("max-overbook").value) : 0,
    mode: selectedMode(),
    maxValueCardChargeSek: Number($("max-charge").value),
    minimumLeadHours: Number($("minimum-lead").value),
    valueCardId: valueCard?.id || null,
    valueCardName: valueCard?.name || "",
    valueCardBalance: valueCard?.balance || 0,
  };
}

function validateConfig(config) {
  if (!config.email || !config.email.includes("@")) return "请输入有效 MATCHi 邮箱";
  if (!config.password) return "请输入 MATCHi 密码";
  if (!config.targetDate) return "请选择目标日期";
  if (!/^(?:[01]\d|2[0-3]):00$/.test(config.startTime || "")) return "开始时间必须选择整点小时";
  if (![60, 120, 180].includes(config.durationMinutes)) return "预订时长必须是 60、120 或 180 分钟";
  if (Number(config.startTime.slice(0, 2)) * 60 + config.durationMinutes > 1440) return "开始时间加时长不能跨越午夜";
  if (config.quantity * config.durationMinutes > 600) return "目标场地总分钟数超过 ATL 当前每日 600 分钟上限";
  if (config.mode === "value-card") {
    if (!config.valueCardId || !config.valueCardName) return "请先读取余额并选择本次支付使用的 Value Card";
    if (!(config.maxValueCardChargeSek > 0)) return "请输入有效的 Value Card 最大扣款";
    if (config.valueCardBalance < config.maxValueCardChargeSek) {
      return `所选卡余额 ${config.valueCardBalance} SEK 低于最大扣款 ${config.maxValueCardChargeSek} SEK`;
    }
    if (config.allowOverbookingOnUncertain && !(config.maxOverbookCourts >= 1 && config.maxOverbookCourts <= 6)) {
      return "允许超订时，最多超订场地数必须在 1 到 6 之间";
    }
    const targetStart = new Date(`${config.targetDate}T${config.startTime}:00`);
    const leadHours = (targetStart.getTime() - Date.now()) / 3600000;
    if (leadHours < config.minimumLeadHours) {
      return `目标只剩 ${leadHours.toFixed(1)} 小时，不满足 ${config.minimumLeadHours} 小时远期保护`;
    }
  }
  return "";
}

function addResultItem(container, label, value) {
  const item = document.createElement("div");
  item.className = "result-item";
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  const valueEl = document.createElement("b");
  valueEl.textContent = value ?? "—";
  item.append(labelEl, valueEl);
  container.appendChild(item);
}

function showResult(report) {
  const panel = $("result-panel");
  panel.classList.remove("hidden", "error");
  const successful = ["completed", "completed-no-payment", "submitted"].includes(report.status);
  if (!successful) panel.classList.add("error");
  $("result-icon").textContent = successful ? "✓" : "!";
  $("result-title").textContent = successful
    ? "任务已结束"
    : report.status === "stopped"
      ? "任务已停止"
      : report.status === "partial"
        ? "部分场地已成功"
        : report.status === "uncertain"
          ? "结果需要人工核对"
          : "任务未完成";
  $("result-subtitle").textContent = `退出码 ${report.exitCode} · 用时 ${report.elapsedSeconds} 秒`;

  const details = $("result-details");
  details.textContent = "";
  const state = report.state || {};
  const target = state.target || report.lastEvent || {};
  const receipt = state.receipt || report.lastEvent?.receipt || {};
  addResultItem(details, "日期与时间", target.date ? `${target.date} ${target.startTime || ""}` : "—");
  addResultItem(details, "场地", (target.courts || report.lastEvent?.courts || []).join(", ") || "—");
  if (state.completedCount !== undefined) {
    addResultItem(details, "成功数量", `${state.completedCount}/${state.requiredQuantity || state.target?.courts?.length || state.completedCount}`);
  }
  addResultItem(details, "Value Card 扣款", receipt.chargedAmount !== undefined ? `${receipt.chargedAmount} ${receipt.currency}` : "无 / 未发生");
  const hasObservedBalance = receipt.observedBalanceAfter !== undefined && receipt.observedBalanceAfter !== null;
  addResultItem(
    details,
    hasObservedBalance ? "实时余额" : "预计余额",
    hasObservedBalance
      ? `${receipt.observedBalanceAfter} ${receipt.currency}`
      : receipt.expectedBalanceAfter !== undefined ? `${receipt.expectedBalanceAfter} ${receipt.currency}` : "—"
  );
  if (receipt.maximumPossibleCourts > receipt.confirmedCourts) {
    addResultItem(details, "超订风险", `确认 ${receipt.confirmedCourts} 块 · 最多可能 ${receipt.maximumPossibleCourts} 块`);
    addResultItem(details, "最坏扣款", `${receipt.maximumPossibleChargedAmount} ${receipt.currency}`);
    addResultItem(details, "最低可能余额", `${receipt.minimumPossibleBalanceAfter} ${receipt.currency}`);
  }
  const orderDisplay = Array.isArray(receipt.orderIds) && receipt.orderIds.length
    ? receipt.orderIds.join(", ")
    : receipt.orderId || receipt.orderStatus || "—";
  addResultItem(details, "订单", orderDisplay);
  const timing = report.lastEvent?.timing || {};
  if (timing.releaseToFoundMs !== undefined) {
    addResultItem(details, "开始查询到找到", `${timing.releaseToFoundMs} ms`);
    addResultItem(details, "确认页", `${timing.confirmationMs ?? "—"} ms`);
    addResultItem(details, "结账准备", `${timing.prepareMs ?? "—"} ms`);
    addResultItem(details, "订单提交", `${timing.commitMs ?? "—"} ms`);
  }
  addResultItem(details, "日志", report.logFile || "—");
}

window.handleBackendEvent = function(event) {
  switch (event.type) {
    case "manager-started":
      setCard("phase", "等待", "后台任务已启动", "state-running");
      setProgress(8, "等待预登录 / 放票时间");
      break;
    case "target":
      setCard("phase", "等待放票", `${event.date} ${event.startTime}`, "state-running");
      break;
    case "login-started":
      setCard("phase", "登录中", "正在建立安全会话", "state-running");
      setProgress(22, "登录 MATCHi");
      break;
    case "login-succeeded":
      setCard("phase", "已登录", "等待或开始轮询", "state-running");
      setProgress(35, "登录成功");
      break;
    case "session-restored":
      setCard("phase", "会话已恢复", "已自动重新登录并继续原任务", "state-running");
      window.addLog("MATCHi 登录会话已失效，脚本已自动重新登录并继续", "warning");
      break;
    case "prewarm":
      setCard("phase", "连接已预热", `${event.fulfilled}/${event.total} · ${event.elapsedMs} ms`, "state-running");
      setProgress(44, "等待放票时刻");
      break;
    case "release-burst":
      setCard("phase", "放票追踪", `${event.delayMs} ms 后复查`, "state-running");
      break;
    case "slot-conflict":
      setCard("phase", "正在改选", `${event.delayMs} ms 后刷新候选`, "state-warning");
      window.addLog("刚选中的一组场地已被其他人先确认，正在自动改选", "warning");
      break;
    case "poll":
      setCard(
        "phase",
        "抢订中",
        event.targetPublished !== undefined
          ? `第 ${event.attempts} 次 · 目标可订 ${event.targetFree}/${event.targetPublished}`
          : `第 ${event.attempts} 次 · 全日空闲 ${event.free}`,
        "state-running"
      );
      if (event.targetPublished !== undefined) {
        setCard(
          "courts",
          `${event.targetFree} 个可订`,
          event.targetPublished > 0 ? `目标时刻已发布 ${event.targetPublished} 个` : "目标时刻尚未发布",
          event.targetFree > 0 ? "state-running" : "state-warning"
        );
      }
      setProgress(55 + Math.min(20, event.attempts), "正在查询目标时间段");
      break;
    case "backoff":
      setCard("phase", "限流退避", `${(event.delayMs / 1000).toFixed(1)} 秒后重试`, "state-warning");
      window.addLog(`MATCHi 返回 ${event.status}，自动退避 ${event.delayMs / 1000} 秒`, "warning");
      break;
    case "slots-found":
      setCard("phase", "已找到", `${event.start}-${event.end}`, "state-done");
      setCard("courts", event.courts.join(" + "), "已锁定候选", "state-done");
      setProgress(80, "场地已找到，正在验证价格");
      break;
    case "confirmation":
      setCard("result", event.price || "待付款", "确认页已生成", "state-running");
      setProgress(86, "确认价格和付款方式");
      break;
    case "multi-confirmation":
      setCard("result", `${event.expectedChargeTotal} SEK`, `${event.courts.length} 个确认页已生成`, "state-running");
      setProgress(86, "全部场地已分别确认");
      break;
    case "value-card-validated":
      setCard("result", `${event.expectedCharge} ${event.currency}`, "Value Card 保护通过", "state-running");
      setProgress(92, "仅使用指定 Value Card");
      break;
    case "multi-value-card-validated":
      setCard("result", `${event.expectedChargeTotal} ${event.currency}`, "全部 Value Card 保护通过", "state-running");
      setProgress(91, "准备顺序提交独立订单");
      break;
    case "multi-booking-progress":
      setCard("phase", "提交中", `${event.completed}/${event.total} · ${event.court}`, "state-running");
      setProgress(91 + Math.round((event.completed / event.total) * 8), `已完成 ${event.completed}/${event.total} 个场地`);
      break;
    case "replacement-needed":
      setCard("phase", "自动补位", `${event.failedCourt || (event.failedCourts || []).join(", ")} 已失效 · 已完成 ${event.completed}/${event.total}`, "state-warning");
      window.addLog(`${event.failedCourt || (event.failedCourts || []).join(", ")} 未生成订单，正在立即改选其他场地`, "warning");
      setProgress(94, "刷新日历并寻找补位场地");
      break;
    case "replacement-scan":
      setCard(
        "phase",
        "补位扫描",
        event.found > 0 ? `找到 ${event.found}/${event.needed} 个候选` : `第 ${event.round} 次暂未找到`,
        event.found > 0 ? "state-running" : "state-warning"
      );
      break;
    case "replacement-found":
      setCard("phase", "补位已找到", event.courts.join(" + "), "state-running");
      setCard("courts", event.courts.join(" + "), "正在提交补位订单", "state-running");
      window.addLog(`补位候选：${event.courts.join(", ")}`);
      break;
    case "replacement-backoff":
      setCard("phase", "补位退避", `MATCHi ${event.status} · ${event.delayMs / 1000} 秒`, "state-warning");
      window.addLog(`补位查询遇到 ${event.status}，将在 ${event.delayMs / 1000} 秒后继续`, "warning");
      break;
    case "confirmation-backoff":
      setCard("phase", "确认页重试", `保留 ${event.preserved} 个 · ${event.delayMs / 1000} 秒后重试`, "state-warning");
      window.addLog(`确认页临时失败，仅重试 ${event.failedCourts.join(", ")}，已成功的确认页不会丢失`, "warning");
      break;
    case "checkout-preparation-retry":
      setCard("phase", "结账预检重试", `已保留 ${event.preserved} 个 · 重试 ${event.failedCourts.join(", ")}`, "state-warning");
      window.addLog(`部分结账上下文创建失败，只重试 ${event.failedCourts.join(", ")}，已成功项继续保留`, "warning");
      break;
    case "power-warning":
      window.addLog(event.message || "防睡眠请求失败", "warning");
      break;
    case "order-reconciliation":
      setCard("phase", "核对订单", `${event.court} · 第 ${event.attempt} 次`, "state-warning");
      setProgress(95, "提交响应不确定，正在核对账号和余额");
      break;
    case "order-reconciled":
      setCard("phase", "核对成功", `${event.court} 已确认 · ${event.completed}/${event.total}`, "state-running");
      window.addLog(`${event.court} 已通过账号预订和 Value Card 余额双重确认`, "warning");
      break;
    case "overbook-risk-accepted":
      setCard("phase", "数量优先补位", `${event.court} 结果不确定 · 继续抢`, "state-warning");
      setCard("result", `已确认 ${event.completed}/${event.target}`, `最多可能 ${event.maximumPossibleCourts} 块`, "state-warning");
      window.addLog(`${event.court} 结果仍不确定；按照允许超订设置继续补位`, "warning");
      break;
    case "post-payment-verification":
      setCard(
        "phase",
        "订单复核",
        `第 ${event.attempt} 次 · 订单 ${event.profileVerified ? "✓" : "…"} · 余额 ${event.balanceVerified ? "✓" : "…"}`,
        event.profileVerified && event.balanceVerified ? "state-running" : "state-warning"
      );
      setProgress(99, "正在核对精确结束时间和实时余额");
      break;
    case "booking-completed":
      setCard("phase", event.postPaymentVerified === false ? "已提交，需核对" : "完成", "预订已提交", event.postPaymentVerified === false ? "state-warning" : "state-done");
      setCard("courts", event.courts.join(" + "), `${event.date} ${event.startTime}`, "state-done");
      setCard("result", event.postPaymentVerified === false ? "需要人工核对" : "成功", `${event.receipt.chargedAmount} ${event.receipt.currency}`, event.postPaymentVerified === false ? "state-warning" : "state-done");
      setProgress(100, event.postPaymentVerified === false ? "订单已提交，事后复核不完整；不会自动重下" : "预订完成并已双重核验");
      break;
    case "dry-run-completed":
    case "confirm-completed":
      setCard("phase", "演练完成", "没有付款", "state-done");
      setCard("result", "未扣款", event.price || "检测完成", "state-done");
      setProgress(100, "演练完成");
      break;
    case "error":
      setCard("phase", "错误", event.message || "任务失败", "state-error");
      setCard("result", "未完成", "查看日志", "state-error");
      setProgress(100, "任务出现错误");
      break;
    case "stopped":
      setCard("phase", "已停止", "用户取消", "state-warning");
      setProgress(null, "");
      break;
  }
};

window.finishRun = function(report) {
  setRunning(false);
  showResult(report);
  if (report.status === "failed") {
    setCard("result", "失败", "查看结果和日志", "state-error");
  } else if (report.status === "partial") {
    setCard("result", "部分成功", "已停止继续扣款，请查看结果", "state-warning");
  } else if (report.status === "uncertain") {
    setCard("result", "需要核对", "已达到超订或扣款风险上限", "state-warning");
  } else if (report.status === "verification-warning") {
    setCard("result", "需要核对", "订单已提交，但精确订单或余额复核未通过", "state-warning");
  } else if (report.status === "stopped") {
    setCard("result", "已停止", "没有继续执行", "state-warning");
  }
  window.addLog(
    `任务结束：${report.status}，退出码 ${report.exitCode}`,
    report.status === "failed" ? "error" : report.status === "verification-warning" ? "warning" : "info"
  );
};

function applyDefaults(defaults) {
  $("email").value = defaults.email || "";
  $("facility").value = defaults.facility || "atl";
  $("target-date").value = defaults.targetDate || "";
  const savedStartTime = /^(?:[01]\d|2[0-3]):00$/.test(defaults.startTime || "") ? defaults.startTime : "07:00";
  $("start-time").value = savedStartTime;
  $("duration").value = String(defaults.durationMinutes || 60);
  $("quantity").value = String(defaults.quantity || 1);
  $("allow-scattered").checked = defaults.allowNonConsecutiveCourts !== false;
  $("minimum-lead").value = String(defaults.minimumLeadHours ?? 168);
  $("max-charge").value = String(defaults.maxValueCardChargeSek || 70);
  $("allow-overbooking").checked = defaults.allowOverbookingOnUncertain !== false;
  $("max-overbook").value = String(defaults.maxOverbookCourts ?? 2);
  preferredValueCardId = defaults.valueCardId || null;
  const mode = document.querySelector(`input[name="run-mode"][value="${defaults.mode || "confirm"}"]`);
  if (mode) mode.checked = true;
  updatePaymentVisibility();
  updateOverbookingPreview();
  updateReleasePreview();
  estimateCharge();
}

document.querySelectorAll('input[name="run-mode"]').forEach((radio) => radio.addEventListener("change", updatePaymentVisibility));
$("target-date").addEventListener("change", () => { updateReleasePreview(); estimateCharge(); });
$("start-time").addEventListener("change", estimateCharge);
$("duration").addEventListener("change", estimateCharge);
$("quantity").addEventListener("change", () => { $("quantity").value = clampQuantity($("quantity").value); updateOverbookingPreview(); estimateCharge(); });
$("max-charge").addEventListener("input", () => { maxChargeEdited = true; });
$("qty-minus").addEventListener("click", () => { $("quantity").value = clampQuantity(Number($("quantity").value) - 1); updateOverbookingPreview(); estimateCharge(); });
$("qty-plus").addEventListener("click", () => { $("quantity").value = clampQuantity(Number($("quantity").value) + 1); updateOverbookingPreview(); estimateCharge(); });
$("allow-overbooking").addEventListener("change", () => { updateOverbookingPreview(); estimateCharge(); });
$("max-overbook").addEventListener("change", () => {
  $("max-overbook").value = String(clampOverbook($("max-overbook").value));
  updateOverbookingPreview();
  estimateCharge();
});
$("toggle-password").addEventListener("click", () => {
  const input = $("password");
  input.type = input.type === "password" ? "text" : "password";
  $("toggle-password").textContent = input.type === "password" ? "显示" : "隐藏";
});
$("btn-load-cards").addEventListener("click", loadValueCards);
$("value-card-select").addEventListener("change", updateValueCardSummary);
$("email").addEventListener("change", clearValueCards);
$("password").addEventListener("change", clearValueCards);
$("btn-clear-log").addEventListener("click", () => {
  logLines.length = 0;
  window.addLog("界面日志已清空；磁盘日志不受影响");
});

window.addEventListener("pywebviewready", async () => {
  logLines.length = 0;
  window.addLog("MATCHi 控制台已就绪");
  try {
    const raw = await window.pywebview.api.get_defaults();
    applyDefaults(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch (error) {
    window.addLog(`读取默认设置失败：${error}`, "error");
  }

  $("btn-start").addEventListener("click", async () => {
    const config = buildConfig();
    const problem = validateConfig(config);
    if (problem) {
      window.addLog(problem, "error");
      alert(problem);
      return;
    }
    if (config.mode === "value-card") {
      const fallback = config.allowNonConsecutiveCourts ? "没有连号时接受分散场地" : "只接受连续场号";
      const overbooking = config.allowOverbookingOnUncertain
        ? `数量优先 · 最多允许超订 ${config.maxOverbookCourts} 块（最坏 ${config.quantity + config.maxOverbookCourts} 块）`
        : "不允许超订；不确定订单会限制继续补位";
      const card = selectedValueCard();
      const accepted = confirm(
        `确认启动真实预订？\n\n${config.targetDate} ${config.startTime}\n目标 ${config.quantity} 块场地 · ${config.durationMinutes} 分钟\n${fallback}\n${overbooking}\n支付卡 ID ${card.id} · 余额 ${card.balance.toFixed(2)} ${card.currency}\nValue Card 整次最多扣 ${config.maxValueCardChargeSek} SEK\n\n不会使用银行卡补差额。`
      );
      if (!accepted) return;
    }

    $("result-panel").classList.add("hidden");
    setRunning(true);
    setCard("phase", "启动中", "正在创建后台任务", "state-running");
    setCard("courts", `${config.quantity} 块`, config.allowNonConsecutiveCourts ? "优先连号" : "必须连号", "state-idle");
    setCard("result", "—", "等待执行", "state-idle");
    setProgress(4, "正在验证设置");
    window.addLog(`目标：${config.targetDate} ${config.startTime}，${config.quantity} 块，${config.durationMinutes} 分钟`);

    try {
      const response = await window.pywebview.api.start_booking(JSON.stringify(config));
      if (String(response).startsWith("error:")) {
        setRunning(false);
        setCard("phase", "配置错误", String(response).slice(6), "state-error");
      } else if (response !== "started") {
        setRunning(false);
      } else {
        $("password").value = "";
      }
    } catch (error) {
      setRunning(false);
      window.addLog(`启动失败：${error}`, "error");
    }
  });

  $("btn-stop").addEventListener("click", async () => {
    if (!confirm("确定停止当前等待/抢订任务吗？")) return;
    window.addLog("正在请求停止任务", "warning");
    await window.pywebview.api.stop_booking();
    setRunning(false);
  });

  $("btn-logs").addEventListener("click", async () => {
    try { await window.pywebview.api.open_logs(); }
    catch (error) { window.addLog(`打开日志失败：${error}`, "error"); }
  });
});

countdownTimer = setInterval(updateCountdown, 1000);
