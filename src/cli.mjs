#!/usr/bin/env node
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { getIndividualConfirmations } from "./confirmation-batch.mjs";
import { prepareValueCardCheckoutBatch } from "./checkout-preparation-batch.mjs";
import {
  MatchiClient,
  MatchiError,
  addMinutesToClock,
  analyzeBookingDetail,
  analyzeTargetAvailability,
  chooseReplacementSlots,
  chooseSlots,
  computePossibleBalances,
  computeReplacementAllowance,
  computeReleaseRetryDelayMs,
  computeTransientBackoffMs,
  computeReleaseInstant,
  computeTargetStartInstant,
  extractCancellationAnchors,
  isTransientHttpStatus,
  validateConfig,
} from "./matchi-client.mjs";

const command = process.argv[2] || "run";
const options = parseArgs(process.argv.slice(3));

try {
  if (command === "wizard") await wizard(options);
  else if (command === "check") await execute(options, {
    forceImmediate: true,
    forceMode: "dry-run",
    forceOneShot: true,
  });
  else if (command === "run") await execute(options);
  else showHelp(1);
} catch (error) {
  const message = error instanceof MatchiError ? error.message : error?.stack || String(error);
  emitEvent("error", { message: String(message).split("\n")[0] });
  console.error(`\n错误：${message}`);
  process.exitCode = 1;
}

async function execute(options, overrides = {}) {
  const configPath = resolve(options.config || "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (options.mode) config.mode = options.mode;
  if (overrides.forceMode) config.mode = overrides.forceMode;
  validateConfig(config);

  const releaseAt = config.releaseAt
    ? new Date(config.releaseAt)
    : computeReleaseInstant(config.targetDate, config.advanceDays, config.timeZone);
  if (!Number.isFinite(releaseAt.getTime())) throw new MatchiError("releaseAt 不是有效时间");

  printTarget(config, releaseAt);
  emitEvent("target", {
    facility: config.facilityName || config.facilitySlug,
    date: config.targetDate,
    startTime: config.startTime,
    durationMinutes: Number(config.durationMinutes),
    quantity: Number(config.quantity || 1),
    releaseAt: releaseAt.toISOString(),
    mode: config.mode,
  });
  if (!overrides.forceImmediate) {
    const loginAt = new Date(releaseAt.getTime() - Number(config.loginLeadSeconds || 180) * 1000);
    await waitUntil(loginAt, "等待预登录");
  }

  const credentials = await getCredentials();
  const client = new MatchiClient();
  console.log(`[${timestamp()}] 正在登录 MATCHi…`);
  emitEvent("login-started");
  await client.login(credentials.email, credentials.password, `/facilities/${config.facilitySlug}`);
  credentials.password = "";
  console.log(`[${timestamp()}] 登录成功（Cookie 仅保存在当前进程内存）`);
  emitEvent("login-succeeded");

  if (!overrides.forceImmediate) {
    const prewarmLeadSeconds = Number(config.prewarmLeadSeconds ?? 2);
    if (prewarmLeadSeconds > 0 && Date.now() < releaseAt.getTime()) {
      const prewarmAt = new Date(releaseAt.getTime() - prewarmLeadSeconds * 1000);
      await waitUntil(prewarmAt, "等待连接预热");
      const prewarm = await client.prewarmBookingOrigins({ timeoutMs: 1_000 });
      console.log(`[${timestamp()}] 连接预热完成：${prewarm.fulfilled}/${prewarm.total}，${prewarm.elapsedMs.toFixed(1)}ms`);
      emitEvent("prewarm", prewarm);
    }
    await waitUntil(releaseAt, "等待放票");
  }
  const startedAt = Date.now();
  const deadline = startedAt + Number(config.pollTimeoutSeconds || 180) * 1000;
  let attempts = 0;
  let targetUnavailableSince = null;
  let transientFailures = 0;
  let reauthenticationAttempts = 0;

  while (Date.now() <= deadline) {
    attempts += 1;
    let nextDelayMs = Number(config.pollIntervalMs);
    try {
      const pollStartedAt = performance.now();
      const schedule = await client.getSchedule({
        facilityId: config.facilityId,
        sportId: config.sportId,
        date: config.targetDate,
      });
      const requestMs = elapsedMs(pollStartedAt);
      const selections = chooseSlots(schedule.slots, config);
      const target = analyzeTargetAvailability(schedule.slots, config, selections);
      const freeCount = schedule.slots.filter((slot) => slot.state === "free").length;
      const notice = schedule.notice.advanceDays ? `，窗口=${schedule.notice.advanceDays}天` : "";
      console.log(`[${timestamp()}] #${attempts} 日历时段=${schedule.slots.length}，空闲=${freeCount}，目标已发布=${target.publishedCells}，目标空闲=${target.freeCells}，请求=${requestMs.toFixed(1)}ms${notice}`);
      emitEvent("poll", {
        attempts,
        slots: schedule.slots.length,
        free: freeCount,
        targetPublished: target.publishedCells,
        targetFree: target.freeCells,
        requestMs,
      });

      if (selections.length) {
        await handleFound(client, config, selections, options, {
          // If the configured date was already released before this process
          // started, measuring from midnight produces a misleading multi-day
          // value. Measure the actual polling window instead.
          releaseToFoundMs: Math.max(0, Date.now() - startedAt),
        });
        return;
      }

      // A successful schedule request clears transport failures only when the
      // downstream confirmation path was not attempted. Otherwise a persistent
      // confirmation 5xx must retain its backoff count across calendar refreshes.
      transientFailures = 0;

      if (overrides.forceOneShot) {
        throw new MatchiError(schedule.notice.advanceDays
          ? `目标尚未开放：${schedule.notice.text}`
          : "本次检查没有找到符合配置的连续空位");
      }

      const scheduleIsOpen = schedule.slots.length > 0;
      if (scheduleIsOpen && !config.keepPollingIfUnavailable) {
        throw new MatchiError("日历已经开放，但目标时间/候选场地没有足够连续空位");
      }

      const releaseElapsedMs = Date.now() - releaseAt.getTime();
      const releaseRetryDelayMs = computeReleaseRetryDelayMs({
        baseIntervalMs: nextDelayMs,
        burstIntervalMs: Number(config.releaseBurstIntervalMs ?? 250),
        burstSeconds: Number(config.releaseBurstSeconds ?? 3),
        releaseElapsedMs,
        scheduleIsOpen,
      });
      if (releaseRetryDelayMs < nextDelayMs) {
        nextDelayMs = releaseRetryDelayMs;
        emitEvent("release-burst", { attempts, delayMs: nextDelayMs, releaseElapsedMs });
      }

      if (target.publishedCells > 0) {
        targetUnavailableSince ??= Date.now();
        const graceMs = Number(config.unavailableTargetGraceSeconds ?? 30) * 1000;
        if (Date.now() - targetUnavailableSince >= graceMs) {
          throw new MatchiError(
            `目标 ${config.startTime} 已发布，但没有足够的可预订连续场地；停止请求以避免触发限流`,
          );
        }
        nextDelayMs = Math.max(nextDelayMs, 3_000);
      } else {
        targetUnavailableSince = null;
      }
    } catch (error) {
      const status = error instanceof MatchiError ? error.details?.status : null;
      const code = error instanceof MatchiError ? error.details?.code : null;
      if (code === "SLOT_CONFLICT") {
        nextDelayMs = Math.min(nextDelayMs, Number(config.releaseBurstIntervalMs ?? 250));
        console.warn(`[${timestamp()}] 候选场地在确认前失效，${nextDelayMs}ms 后刷新并改选下一组`);
        emitEvent("slot-conflict", { attempts, delayMs: nextDelayMs });
      } else if (code === "AUTH_EXPIRED" && reauthenticationAttempts < 2) {
        reauthenticationAttempts += 1;
        await client.reauthenticate(`/facilities/${config.facilitySlug}`);
        nextDelayMs = 250;
        console.warn(`[${timestamp()}] MATCHi 会话已自动重新登录，第 ${reauthenticationAttempts} 次恢复`);
        emitEvent("session-restored", { attempt: reauthenticationAttempts, delayMs: nextDelayMs });
      } else if (code === "NETWORK_TRANSIENT" || isTransientHttpStatus(status)) {
        transientFailures += 1;
        if (code === "CONFIRMATION_HTTP" && transientFailures >= 3) {
          throw new MatchiError("MATCHi 确认接口连续 3 次返回服务器错误；已在付款前停止，避免无效重试");
        }
        nextDelayMs = computeTransientBackoffMs(
          status,
          transientFailures,
          error.details?.retryAfter,
          Number(config.retryJitterMs ?? 250),
        );
        console.warn(`[${timestamp()}] 临时错误 ${status}，退避 ${(nextDelayMs / 1000).toFixed(1)} 秒后重试`);
        emitEvent("backoff", { status, failures: transientFailures, delayMs: nextDelayMs });
      } else {
        throw error;
      }
    }
    await sleep(nextDelayMs);
  }
  throw new MatchiError(`轮询 ${attempts} 次后仍未找到目标时段`);
}

async function handleFound(client, config, selections, options, telemetry = {}) {
  const slotIds = selections.flatMap((selection) => selection.slots.map((slot) => slot.id));
  console.log("\n找到目标：");
  for (const selection of selections) {
    console.log(`- ${selection.court} ${selection.slots[0].start}-${selection.slots.at(-1).end}`);
  }
  emitEvent("slots-found", {
    courts: selections.map((selection) => selection.court),
    start: selections[0].slots[0].start,
    end: selections[0].slots.at(-1).end,
  });

  if (config.mode === "dry-run") {
    console.log("DRY-RUN：没有打开确认页，也没有创建预订或付款。");
    emitEvent("dry-run-completed", {
      courts: selections.map((selection) => selection.court),
      date: config.targetDate,
      startTime: config.startTime,
    });
    return;
  }

  if (config.mode === "value-card") {
    await handleMultiValueCardBooking(client, config, selections, options, telemetry);
    return;
  }

  if (selections.length > 1 && config.mode === "confirm") {
      const {
        confirmations,
        conflicts,
        transientFailures,
        elapsedMs: confirmationsMs,
      } = await getIndividualConfirmations(
        client,
        config,
        selections,
      );
      if (transientFailures.length) {
        throw transientFailures[0].error;
      }
      if (conflicts.length) {
        throw new MatchiError("部分场地在确认页阶段已被抢走；刷新日历后改选", {
          code: "SLOT_CONFLICT",
        });
      }
      console.log(`已分别生成 ${confirmations.length} 个确认页（并行 ${confirmationsMs.toFixed(1)}ms），没有进入付款入口。`);
      for (const item of confirmations) {
        console.log(`- ${item.selection.court}：${item.confirmation.price || "价格未解析"}`);
      }
      emitEvent("confirm-completed", {
        courts: selections.map((selection) => selection.court),
        prices: confirmations.map((item) => item.confirmation.price),
        confirmationsMs,
        date: config.targetDate,
        startTime: config.startTime,
      });
      return;
  }

  const confirmationStartedAt = performance.now();
  const confirmation = await client.getConfirmation({
    facilityId: config.facilityId,
    slotIds,
    refererSlug: config.facilitySlug,
  });
  const confirmationMs = elapsedMs(confirmationStartedAt);
  confirmation.facilitySlug = config.facilitySlug;
  console.log(`确认页已生成（${confirmationMs.toFixed(1)}ms）；价格：${confirmation.price || "未解析"}；付款方式：${confirmation.paymentMethods.join(", ") || "未解析"}`);
  emitEvent("confirmation", {
    price: confirmation.price,
    paymentMethods: confirmation.paymentMethods,
    confirmationMs,
    releaseToFoundMs: telemetry.releaseToFoundMs,
  });

  if (config.mode === "confirm") {
    console.log("CONFIRM 模式：停在确认页数据阶段，没有进入付款入口。");
    emitEvent("confirm-completed", {
      price: confirmation.price,
      courts: selections.map((selection) => selection.court),
      date: config.targetDate,
      startTime: config.startTime,
    });
    return;
  }

  if (config.mode === "value-card") {
    await handleValueCardBooking(client, config, confirmation, selections, options, {
      ...telemetry,
      confirmationMs,
    });
    return;
  }

  const allowed = options.allowCheckout || process.env.MATCHI_ALLOW_CHECKOUT === "YES";
  if (!allowed) {
    throw new MatchiError("checkout 模式还需要 --allow-checkout 或 MATCHI_ALLOW_CHECKOUT=YES；未进入付款入口");
  }
  const paymentUrl = await client.createOnlineCheckout(confirmation);
  console.log("\n已进入在线支付流程，但没有付款、没有使用账号余额：");
  console.log(paymentUrl);
  console.log("请立即在浏览器中打开上面的地址并自行完成付款；MATCHi 是否临时保留该时段由其支付流程决定。");
  emitEvent("checkout-created");
}

async function handleMultiValueCardBooking(client, config, selections, options, telemetry = {}) {
  const allowed = options.allowValueCardPayment || process.env.MATCHI_ALLOW_VALUE_CARD_PAYMENT === "YES";
  if (!allowed) {
    throw new MatchiError("value-card 模式还需要 --allow-value-card-payment 或 MATCHI_ALLOW_VALUE_CARD_PAYMENT=YES；未使用余额");
  }
  assertValueCardTargetSafety(config, selections);

  const requiredQuantity = Number(config.requiredQuantity);
  console.log(`正在为 ${requiredQuantity} 个场地分别生成确认页（MATCHi 不接受多场地合并确认）…`);
  const confirmationDeadline = Date.now() + Number(config.replacementTimeoutSeconds ?? 20) * 1000;
  const initialAttemptedCourts = new Set();
  const preparationFailures = [];
  const confirmations = [];
  let confirmationCandidates = [...selections];
  let confirmationRounds = 0;
  let confirmationsMs = 0;

  while (confirmations.length < requiredQuantity) {
    if (confirmationCandidates.length) {
      for (const selection of confirmationCandidates) initialAttemptedCourts.add(selection.court);
      const batch = await getIndividualConfirmations(client, config, confirmationCandidates);
      confirmationsMs += batch.elapsedMs;
      confirmations.push(...batch.confirmations);
      for (const conflict of batch.conflicts) {
        preparationFailures.push({
          court: conflict.selection.court,
          status: "safe-to-replace",
          paymentStage: "confirmation",
          failedAt: new Date().toISOString(),
        });
      }
      if (batch.conflicts.length) {
        console.warn(
          `确认阶段已有 ${batch.conflicts.length} 个候选失效；保留 ${batch.confirmations.length} 个有效确认页并立即补位`,
        );
        emitEvent("replacement-needed", {
          failedCourts: batch.conflicts.map((item) => item.selection.court),
          completed: confirmations.length,
          total: requiredQuantity,
          paymentStage: "confirmation",
        });
      }
      if (batch.transientFailures.length) {
        if (Date.now() >= confirmationDeadline) {
          throw new MatchiError("确认页阶段持续遇到临时网络或服务器错误；尚未使用 Value Card", {
            code: "NETWORK_TRANSIENT",
          });
        }
        confirmationRounds += 1;
        const representative = batch.transientFailures[0];
        const status = Number.isFinite(representative.status) ? representative.status : 503;
        const delayMs = computeTransientBackoffMs(
          status,
          confirmationRounds,
          representative.error?.details?.retryAfter,
          Number(config.retryJitterMs ?? 250),
        );
        confirmationCandidates = batch.transientFailures.map((item) => item.selection);
        console.warn(
          `确认阶段 ${batch.transientFailures.length} 个请求临时失败；`
          + `保留 ${batch.confirmations.length} 个有效确认页，仅重试失败项`,
        );
        emitEvent("confirmation-backoff", {
          failedCourts: confirmationCandidates.map((item) => item.court),
          preserved: confirmations.length,
          status,
          delayMs,
        });
        await sleep(Math.min(delayMs, Math.max(0, confirmationDeadline - Date.now())));
        continue;
      }
    }
    if (confirmations.length >= requiredQuantity) break;
    if (Date.now() >= confirmationDeadline) {
      throw new MatchiError("确认页阶段的补位时间已用完；尚未使用 Value Card", {
        code: "SLOT_CONFLICT",
      });
    }

    confirmationRounds += 1;
    const schedule = await client.getSchedule({
      facilityId: config.facilityId,
      sportId: config.sportId,
      date: config.targetDate,
    });
    confirmationCandidates = chooseReplacementSlots(schedule.slots, config, {
      excludeCourts: [...initialAttemptedCourts],
      quantity: requiredQuantity - confirmations.length,
    });
    emitEvent("replacement-scan", {
      round: confirmationRounds,
      needed: requiredQuantity - confirmations.length,
      found: confirmationCandidates.length,
      courts: confirmationCandidates.map((item) => item.court),
      paymentStage: "confirmation",
    });
    if (!confirmationCandidates.length) {
      await sleep(Math.min(
        Number(config.replacementPollIntervalMs ?? 1000),
        Math.max(0, confirmationDeadline - Date.now()),
      ));
    }
  }
  const expectedCharges = confirmations.map(({ confirmation }) => parseConfirmationPrice(confirmation.price, "SEK"));
  const expectedChargeTotal = roundMoney(expectedCharges.reduce((sum, amount) => sum + amount, 0));
  if (expectedChargeTotal > Number(config.maxValueCardChargeSek)) {
    throw new MatchiError(
      `${requiredQuantity} 个确认页合计场地价 ${expectedChargeTotal.toFixed(2)} SEK 超过扣款上限 ${config.maxValueCardChargeSek} SEK；拒绝付款`,
    );
  }
  emitEvent("multi-confirmation", {
    confirmationsMs,
    courts: confirmations.map((item) => item.selection.court),
    prices: confirmations.map((item) => item.confirmation.price),
    expectedChargeTotal,
  });

  console.log(`正在并行只读核对 ${requiredQuantity} 个托管结账模型与指定 Value Card…`);
  const prepareStartedAt = performance.now();
  const preparedOrders = [];
  let preparationCandidates = confirmations.map((item, index) => ({
    ...item,
    expectedCharge: expectedCharges[index],
  }));
  let preparationRound = 0;
  while (preparationCandidates.length && preparationRound < 3) {
    preparationRound += 1;
    const batch = await prepareValueCardCheckoutBatch(client, preparationCandidates, (item) => ({
      currency: "SEK",
      maxTotal: Number(config.maxTotalSek),
      valueCardId: Number(config.valueCardId),
      valueCardName: config.valueCardName,
      expectedValueCardCharge: item.expectedCharge,
      maxValueCardCharge: Number(config.maxValueCardChargeSek),
    }));
    preparedOrders.push(...batch.preparedOrders);
    if (!batch.failures.length) {
      preparationCandidates = [];
      break;
    }

    const hardFailure = batch.failures.find(({ error }) => {
      const status = error instanceof MatchiError ? Number(error.details?.status) : Number.NaN;
      const code = error instanceof MatchiError ? error.details?.code : null;
      return !["NETWORK_TRANSIENT", "CHECKOUT_CONTEXT_MISSING", "AUTH_EXPIRED"].includes(code)
        && !isTransientHttpStatus(status);
    });
    if (hardFailure) throw hardFailure.error;
    if (batch.failures.some(({ error }) => error instanceof MatchiError && error.details?.code === "AUTH_EXPIRED")) {
      await client.reauthenticate(`/facilities/${config.facilitySlug}`);
      emitEvent("session-restored", { paymentStage: "checkout-preparation", attempt: preparationRound });
    }
    preparationCandidates = batch.failures.map(({ item }) => item);
    emitEvent("checkout-preparation-retry", {
      round: preparationRound,
      preserved: preparedOrders.length,
      failedCourts: preparationCandidates.map((item) => item.selection.court),
    });
    if (preparationRound < 3) await sleep(preparationRound * 300);
  }
  if (preparationCandidates.length) {
    throw new MatchiError(
      `结账上下文准备重试后仍有 ${preparationCandidates.length} 个失败；尚未使用 Value Card`,
      { code: "NETWORK_TRANSIENT" },
    );
  }
  const prepareMs = elapsedMs(prepareStartedAt);
  const preliminaryTotal = roundMoney(preparedOrders.reduce((sum, item) => sum + item.prepared.total, 0));
  const balanceBefore = Number(preparedOrders[0]?.prepared.card.amount);
  if (preliminaryTotal > Number(config.maxTotalSek)) {
    throw new MatchiError(
      `${requiredQuantity} 个结账模型合计 ${preliminaryTotal.toFixed(2)} SEK 超过总额保护 ${config.maxTotalSek} SEK；拒绝付款`,
    );
  }
  if (!Number.isFinite(balanceBefore) || balanceBefore < expectedChargeTotal) {
    throw new MatchiError(`指定 Value Card 的实时余额不足以覆盖 ${requiredQuantity} 个场地的实际扣款；拒绝付款`);
  }
  console.log(
    `付款保护通过（确认 ${confirmationsMs.toFixed(1)}ms；并行预检 ${prepareMs.toFixed(1)}ms）：`
    + `场地价合计 ${expectedChargeTotal.toFixed(2)} SEK；Value Card 余额 ${balanceBefore.toFixed(2)} SEK`,
  );
  emitEvent("multi-value-card-validated", {
    confirmationsMs,
    prepareMs,
    preliminaryTotal,
    expectedChargeTotal,
    currency: "SEK",
    balance: balanceBefore,
    steps: preparedOrders.map((item) => ({ court: item.selection.court, ...item.prepared.timings })),
  });

  const guard = await createMultiTransactionGuard(config, preparedOrders, {
    preliminaryTotal,
    expectedChargeTotal,
    balanceBefore,
  });
  const receipts = [];
  const failedAttempts = [...preparationFailures];
  const uncertainAttempts = [];
  const attemptedCourts = new Set(preparedOrders.map((item) => item.selection.court));
  const pendingOrders = [...preparedOrders];
  const maxOverbookCourts = config.allowOverbookingOnUncertain
    ? Number(config.maxOverbookCourts || 0)
    : 0;
  const maximumPossibleCourts = requiredQuantity + maxOverbookCourts;
  const replacementDeadline = Date.now() + Number(config.replacementTimeoutSeconds ?? 20) * 1000;
  const replacementMaxRounds = Number(config.replacementMaxRounds ?? Math.max(6, requiredQuantity * 2));
  let replacementRounds = 0;
  const commitStartedAt = performance.now();
  try {
    while (receipts.length < requiredQuantity) {
      const allowance = computeReplacementAllowance({
        requiredQuantity,
        confirmedCount: receipts.length,
        uncertainCount: uncertainAttempts.length,
        allowOverbooking: config.allowOverbookingOnUncertain,
        maxOverbookCourts,
      });
      if (allowance.replacementsAllowed <= 0) {
        throw new MatchiError(
          `已确认 ${receipts.length}/${requiredQuantity} 个，另有 ${uncertainAttempts.length} 个结果不确定；已达到最多 ${maximumPossibleCourts} 个的风险上限`,
          { code: "PARTIAL_RISK_LIMIT" },
        );
      }
      if (!pendingOrders.length) {
        const needed = allowance.replacementsAllowed;
        if (Date.now() >= replacementDeadline || replacementRounds >= replacementMaxRounds) {
          throw new MatchiError(
            `已明确成功 ${receipts.length}/${requiredQuantity} 个场地，但补位时间或次数已用完`,
            { code: "PARTIAL_KNOWN" },
          );
        }
        replacementRounds += 1;
        const chargedSoFar = roundMoney(receipts.reduce(
          (sum, item) => sum + Number(item.receipt.chargedAmount),
          0,
        ) + uncertainAttempts.reduce((sum, item) => sum + Number(item.expectedCharge), 0));
        let replacements;
        try {
          replacements = await prepareReplacementOrders(client, config, {
            needed,
            excludeCourts: [...attemptedCourts],
            chargedSoFar,
            round: replacementRounds,
          });
        } catch (error) {
          const status = error instanceof MatchiError ? Number(error.details?.status) : Number.NaN;
          if (error instanceof MatchiError && error.details?.code === "AUTH_EXPIRED" && Date.now() < replacementDeadline) {
            await client.reauthenticate(`/facilities/${config.facilitySlug}`);
            emitEvent("session-restored", { paymentStage: "replacement", round: replacementRounds });
            continue;
          }
          if (
            (error instanceof MatchiError && ["NETWORK_TRANSIENT", "CHECKOUT_CONTEXT_MISSING"].includes(error.details?.code)
              || isTransientHttpStatus(status))
            && Date.now() < replacementDeadline
          ) {
            const delayMs = computeTransientBackoffMs(
              Number.isFinite(status) ? status : 503,
              replacementRounds,
              error.details?.retryAfter,
              Number(config.retryJitterMs ?? 250),
            );
            emitEvent("replacement-backoff", { round: replacementRounds, status, delayMs });
            await sleep(Math.min(delayMs, Math.max(0, replacementDeadline - Date.now())));
            continue;
          }
          throw error;
        }
        if (!replacements.length) {
          const delayMs = Number(config.replacementPollIntervalMs ?? 1000);
          emitEvent("replacement-scan", {
            round: replacementRounds,
            needed,
            found: 0,
            delayMs,
          });
          await sleep(delayMs);
          continue;
        }
        for (const item of replacements) attemptedCourts.add(item.selection.court);
        pendingOrders.push(...replacements);
        console.log(`补位候选已准备：${replacements.map((item) => item.selection.court).join(", ")}`);
        emitEvent("replacement-found", {
          round: replacementRounds,
          needed,
          courts: replacements.map((item) => item.selection.court),
        });
      }

      const item = pendingOrders.shift();
      await updateTransactionState(guard, {
        status: "submitting",
        submittedAt: guard.state.submittedAt || new Date().toISOString(),
        currentCourt: item.selection.court,
        completedCount: receipts.length,
        orders: receipts,
        failedAttempts,
        uncertainAttempts,
        attemptedCourts: [...attemptedCourts],
        maximumPossibleCourts: receipts.length + uncertainAttempts.length + 1,
      });
      const knownCharge = receipts.reduce((sum, prior) => sum + Number(prior.receipt.chargedAmount), 0);
      const uncertainRiskCharge = uncertainAttempts.reduce((sum, prior) => sum + Number(prior.expectedCharge), 0);
      if (roundMoney(knownCharge + uncertainRiskCharge + Number(item.expectedCharge)) > Number(config.maxValueCardChargeSek)) {
        throw new MatchiError("继续提交会超过包含潜在超订在内的 Value Card 整次扣款上限", {
          code: "PARTIAL_RISK_LIMIT",
        });
      }
      const itemStartedAt = performance.now();
      let receipt;
      try {
        receipt = await client.commitValueCardCheckout(item.prepared);
      } catch (error) {
        if (error instanceof MatchiError && error.details?.safeToReplace === true) {
          const failure = {
            court: item.selection.court,
            status: "safe-to-replace",
            paymentStage: error.details.paymentStage,
            httpStatus: error.details.status || null,
            rollbackSucceeded: Boolean(error.details.rollbackSucceeded),
            failedAt: new Date().toISOString(),
          };
          failedAttempts.push(failure);
          await updateTransactionState(guard, {
            status: "replacing",
            currentCourt: null,
            completedCount: receipts.length,
            orders: receipts,
            failedAttempts,
            uncertainAttempts,
            attemptedCourts: [...attemptedCourts],
          });
          console.warn(`- ${item.selection.court} 已被其他人抢先，确认未生成订单；立即改选其他场地`);
          emitEvent("replacement-needed", {
            failedCourt: item.selection.court,
            completed: receipts.length,
            total: requiredQuantity,
            paymentStage: error.details.paymentStage,
          });
          continue;
        }
        if (
          error instanceof MatchiError
          && error.details?.code === "PAYMENT_UNCERTAIN"
          && error.details?.finalSubmissionStarted === true
        ) {
          const chargedSoFar = roundMoney(receipts.reduce(
            (sum, prior) => sum + Number(prior.receipt.chargedAmount),
            0,
          ));
          const reconciled = await reconcileUncertainOrder(client, config, item, {
            expectedBalanceBefore: roundMoney(balanceBefore - chargedSoFar),
            priorUncertainCharges: uncertainAttempts.map((attempt) => Number(attempt.expectedCharge)),
          });
          if (reconciled) {
            receipt = reconciled;
            console.warn(`- ${item.selection.court} 提交响应不确定，但账号预订和卡余额已共同确认成功`);
            emitEvent("order-reconciled", {
              court: item.selection.court,
              completed: receipts.length + 1,
              total: requiredQuantity,
              balance: receipt.expectedBalanceAfter,
            });
          } else {
            const uncertain = {
              court: item.selection.court,
              status: "unresolved-final-submission",
              expectedCharge: Number(item.expectedCharge),
              paymentStage: error.details.paymentStage,
              observedAt: new Date().toISOString(),
            };
            uncertainAttempts.push(uncertain);
            await updateTransactionState(guard, {
              status: "replacing-with-overbook-risk",
              currentCourt: null,
              completedCount: receipts.length,
              orders: receipts,
              failedAttempts,
              uncertainAttempts,
              attemptedCourts: [...attemptedCourts],
              maximumPossibleCourts: receipts.length + uncertainAttempts.length,
            });
            console.warn(
              `- ${item.selection.court} 最终结果仍不确定；按数量优先策略继续补位，`
              + `最坏情况下最多 ${maximumPossibleCourts} 个场地`,
            );
            emitEvent("overbook-risk-accepted", {
              court: item.selection.court,
              completed: receipts.length,
              uncertain: uncertainAttempts.length,
              target: requiredQuantity,
              maximumPossibleCourts,
            });
            continue;
          }
        } else {
          throw error;
        }
      }
      const logicalBalanceBefore = roundMoney(balanceBefore - knownCharge);
      receipt = {
        ...receipt,
        balanceBefore: logicalBalanceBefore,
        expectedBalanceAfter: roundMoney(logicalBalanceBefore - Number(receipt.chargedAmount)),
        minimumPossibleBalanceBefore: roundMoney(logicalBalanceBefore - uncertainRiskCharge),
        minimumPossibleBalanceAfter: roundMoney(
          logicalBalanceBefore - uncertainRiskCharge - Number(receipt.chargedAmount),
        ),
        balanceTelemetrySource: "batch-sequential-ledger",
      };
      const order = {
        court: item.selection.court,
        receipt,
        commitMs: elapsedMs(itemStartedAt),
        completedAt: new Date().toISOString(),
      };
      receipts.push(order);
      await updateTransactionState(guard, {
        status: "submitting",
        currentCourt: null,
        completedCount: receipts.length,
        orders: receipts,
        failedAttempts,
        uncertainAttempts,
        attemptedCourts: [...attemptedCourts],
        maximumPossibleCourts: receipts.length + uncertainAttempts.length,
      });
      console.log(`- ${item.selection.court} 提交成功：${receipt.chargedAmount.toFixed(2)} SEK；订单 ${receipt.orderId || "待账号页确认"}`);
      emitEvent("multi-booking-progress", {
        completed: receipts.length,
        total: requiredQuantity,
        court: item.selection.court,
        orderId: receipt.orderId,
        commitMs: order.commitMs,
      });
    }

    const commitMs = elapsedMs(commitStartedAt);
    const finalSelections = receipts.map((item) => ({ court: item.court }));
    const chargedAmount = roundMoney(receipts.reduce((sum, item) => sum + Number(item.receipt.chargedAmount), 0));
    const uncertainCharge = roundMoney(uncertainAttempts.reduce((sum, item) => sum + Number(item.expectedCharge), 0));
    const verificationStartedAt = performance.now();
    const postPaymentVerification = await verifyCommittedValueCardBooking(client, config, finalSelections, {
      balanceBefore,
      chargedAmount,
      uncertainCharges: uncertainAttempts.map((attempt) => Number(attempt.expectedCharge)),
    });
    const profileVerifyMs = elapsedMs(verificationStartedAt);
    const { profileVerified, balanceVerified } = postPaymentVerification;
    const postPaymentVerified = profileVerified && balanceVerified;
    const receipt = {
      orderIds: receipts.map((item) => item.receipt.orderId).filter(Boolean),
      orderStatus: uncertainAttempts.length
        ? "TARGET_COMPLETED_WITH_POSSIBLE_OVERBOOK"
        : receipts.every((item) => item.receipt.orderStatus === "COMPLETED") ? "COMPLETED" : "SUBMITTED",
      chargedAmount,
      maximumPossibleChargedAmount: roundMoney(chargedAmount + uncertainCharge),
      currency: "SEK",
      valueCardId: Number(config.valueCardId),
      valueCardName: config.valueCardName,
      balanceBefore,
      expectedBalanceAfter: roundMoney(balanceBefore - chargedAmount),
      minimumPossibleBalanceAfter: roundMoney(balanceBefore - chargedAmount - uncertainCharge),
      observedBalanceAfter: postPaymentVerification.observedBalanceAfter,
      balanceVerified,
      confirmedCourts: receipts.length,
      uncertainCourts: uncertainAttempts.length,
      maximumPossibleCourts: receipts.length + uncertainAttempts.length,
      timings: {
        confirmationsMs,
        prepareMs,
        commitMs,
        profileVerifyMs,
        perOrder: receipts.map((item) => ({ court: item.court, commitMs: item.commitMs, ...item.receipt.timings })),
      },
    };
    await updateTransactionState(guard, {
      status: postPaymentVerified ? "completed" : "completed-verification-warning",
      completedAt: new Date().toISOString(),
      completedCount: receipts.length,
      currentCourt: null,
      orders: receipts,
      failedAttempts,
      uncertainAttempts,
      attemptedCourts: [...attemptedCourts],
      maximumPossibleCourts: receipts.length + uncertainAttempts.length,
      target: {
        ...guard.state.target,
        courts: receipts.map((item) => item.court),
      },
      profileVerified,
      balanceVerified,
      postPaymentVerified,
      postPaymentVerification,
      receipt,
    });

    console.log(`\n${requiredQuantity} 个场地的 Value Card 预订已全部提交成功；永久交易锁已生效，不会重复下单：`);
    console.log(`- 目标：${config.targetDate} ${config.startTime}，${receipts.map((item) => item.court).join(", ")}`);
    if (failedAttempts.length) console.log(`- 自动补位：${failedAttempts.length} 个失败候选已替换`);
    console.log(
      `- 合计扣款：${chargedAmount.toFixed(2)} SEK；`
      + `实时余额：${postPaymentVerification.observedBalanceAfter === null
        ? "读取失败"
        : `${postPaymentVerification.observedBalanceAfter.toFixed(2)} SEK`}`,
    );
    if (uncertainAttempts.length) {
      console.log(
        `- 超订风险：另有 ${uncertainAttempts.length} 个订单结果未确认；`
        + `最多可能 ${receipt.maximumPossibleCourts} 个场地、扣款 ${receipt.maximumPossibleChargedAmount.toFixed(2)} SEK`,
      );
    }
    console.log(`- 订单：${receipt.orderIds.join(", ") || "请以账号预订页为准"}`);
    console.log(
      `- 事后复核：精确日期/场号/${config.startTime}-${postPaymentVerification.expectedEndTime} `
      + `${profileVerified ? "已匹配" : "未匹配"}；Value Card 余额 ${balanceVerified ? "已匹配" : "未匹配"}`,
    );
    if (!postPaymentVerified) {
      console.warn("- 警告：订单提交已发生，但事后双重核验不完整；交易锁继续保留，脚本不会自动重下");
    }
    console.log(`- 性能：并行确认 ${confirmationsMs.toFixed(1)}ms；并行预检 ${prepareMs.toFixed(1)}ms；顺序提交 ${commitMs.toFixed(1)}ms；精确复核 ${profileVerifyMs.toFixed(1)}ms`);
    emitEvent("booking-completed", {
      courts: receipts.map((item) => item.court),
      date: config.targetDate,
      startTime: config.startTime,
      receipt,
      timing: { ...telemetry, confirmationsMs, prepareMs, commitMs, profileVerifyMs },
      profileVerified,
      balanceVerified,
      postPaymentVerified,
    });
  } catch (error) {
    const knownPartial = error instanceof MatchiError
      && ["PARTIAL_KNOWN", "PARTIAL_RISK_LIMIT"].includes(error.details?.code);
    await updateTransactionState(guard, {
      status: knownPartial ? "partial" : "failed-or-uncertain",
      failedAt: new Date().toISOString(),
      completedCount: receipts.length,
      orders: receipts,
      failedAttempts,
      uncertainAttempts,
      attemptedCourts: [...attemptedCourts],
      maximumPossibleCourts: receipts.length + uncertainAttempts.length,
      target: {
        ...guard.state.target,
        courts: receipts.map((item) => item.court),
      },
      error: error instanceof Error ? error.message : String(error),
    });
    throw new MatchiError(error instanceof Error ? error.message : String(error), {
      code: knownPartial ? error.details.code : "TRANSACTION_LOCKED_FAILURE",
      completedCount: receipts.length,
      requiredQuantity,
    });
  }
}

async function reconcileUncertainOrder(client, config, item, {
  expectedBalanceBefore,
  priorUncertainCharges = [],
}) {
  const expectedCharge = Number(item.expectedCharge);
  const possibleBalancesAfter = computePossibleBalances(
    expectedBalanceBefore,
    [...priorUncertainCharges, expectedCharge],
  ).filter((balance) => balance <= roundMoney(expectedBalanceBefore - expectedCharge) + 0.009);
  const expectedBalanceAfter = roundMoney(expectedBalanceBefore - expectedCharge);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const [profileMatched, cards] = await Promise.all([
        verifyProfileBooking(client, config, [item.selection]),
        client.getProfileValueCards(),
      ]);
      const card = cards.find((candidate) => Number(candidate.id) === Number(config.valueCardId));
      const balanceMatched = card && possibleBalancesAfter.some(
        (possible) => Math.abs(Number(card.balance) - possible) < 0.01,
      );
      emitEvent("order-reconciliation", {
        court: item.selection.court,
        attempt,
        profileMatched,
        balanceMatched: Boolean(balanceMatched),
        possibleBalancesAfter,
      });
      if (profileMatched && balanceMatched) {
        return {
          orderId: null,
          orderStatus: "PROFILE_AND_BALANCE_VERIFIED",
          chargedAmount: expectedCharge,
          currency: "SEK",
          valueCardId: Number(config.valueCardId),
          valueCardName: config.valueCardName,
          balanceBefore: expectedBalanceBefore,
          expectedBalanceAfter,
          reconciled: true,
          timings: {},
        };
      }
    } catch (error) {
      // A transient reconciliation read must not trigger a replacement. Retry
      // briefly, then leave the transaction locked and uncertain.
      if (error instanceof MatchiError && error.details?.code === "AUTH_EXPIRED") {
        try {
          await client.reauthenticate("/profile/home");
          emitEvent("session-restored", { paymentStage: "order-reconciliation", attempt });
        } catch {
          // Preserve the uncertain state if reauthentication itself fails.
        }
      }
    }
    if (attempt < 3) await sleep(500);
  }
  return null;
}

async function prepareReplacementOrders(client, config, {
  needed,
  excludeCourts,
  chargedSoFar,
  round,
}) {
  const scheduleStartedAt = performance.now();
  const schedule = await client.getSchedule({
    facilityId: config.facilityId,
    sportId: config.sportId,
    date: config.targetDate,
  });
  let selections = chooseReplacementSlots(schedule.slots, config, {
    excludeCourts,
    quantity: needed,
  });
  // Do not wait for all missing courts to appear at once. If only one safe
  // replacement is available, secure it first and keep searching for the rest.
  if (!selections.length && needed > 1) {
    for (let partialQuantity = needed - 1; partialQuantity >= 1; partialQuantity -= 1) {
      selections = chooseReplacementSlots(schedule.slots, config, {
        excludeCourts,
        quantity: partialQuantity,
      });
      if (selections.length) break;
    }
  }
  emitEvent("replacement-scan", {
    round,
    needed,
    found: selections.length,
    courts: selections.map((item) => item.court),
    requestMs: elapsedMs(scheduleStartedAt),
  });
  if (!selections.length) return [];

  let confirmations;
  try {
    const batch = await getIndividualConfirmations(client, config, selections);
    confirmations = batch.confirmations;
    if (!confirmations.length && batch.transientFailures.length) throw batch.transientFailures[0].error;
  } catch (error) {
    if (error instanceof MatchiError && error.details?.code === "SLOT_CONFLICT") return [];
    throw error;
  }
  if (!confirmations.length) return [];
  const expectedCharges = confirmations.map(({ confirmation }) => parseConfirmationPrice(confirmation.price, "SEK"));
  const expectedChargeTotal = roundMoney(expectedCharges.reduce((sum, amount) => sum + amount, 0));
  if (roundMoney(chargedSoFar + expectedChargeTotal) > Number(config.maxValueCardChargeSek)) {
    throw new MatchiError("补位订单会超过本次 Value Card 总扣款上限；停止补位");
  }

  try {
    const confirmationItems = confirmations.map((item, index) => ({
      ...item,
      expectedCharge: expectedCharges[index],
    }));
    const batch = await prepareValueCardCheckoutBatch(client, confirmationItems, (item) => ({
        currency: "SEK",
        maxTotal: Number(config.maxTotalSek),
        valueCardId: Number(config.valueCardId),
        valueCardName: config.valueCardName,
        expectedValueCardCharge: item.expectedCharge,
        maxValueCardCharge: Number(config.maxValueCardChargeSek),
      }));
    const preparedOrders = batch.preparedOrders.map((item) => ({ ...item, replacementRound: round }));
    if (!preparedOrders.length && batch.failures.length) throw batch.failures[0].error;
    const currentBalance = Number(preparedOrders[0]?.prepared.card.amount);
    const preparedChargeTotal = roundMoney(preparedOrders.reduce(
      (sum, item) => sum + Number(item.expectedCharge),
      0,
    ));
    if (!Number.isFinite(currentBalance) || currentBalance < preparedChargeTotal) {
      throw new MatchiError("Value Card 当前余额不足以完成剩余补位订单");
    }
    return preparedOrders;
  } catch (error) {
    if (error instanceof MatchiError && error.details?.code === "SLOT_CONFLICT") return [];
    throw error;
  }
}

async function handleValueCardBooking(client, config, confirmation, selections, options, telemetry = {}) {
  const allowed = options.allowValueCardPayment || process.env.MATCHI_ALLOW_VALUE_CARD_PAYMENT === "YES";
  if (!allowed) {
    throw new MatchiError("value-card 模式还需要 --allow-value-card-payment 或 MATCHI_ALLOW_VALUE_CARD_PAYMENT=YES；未使用余额");
  }
  assertValueCardTargetSafety(config, selections);

  console.log("正在只读核对 MATCHi 托管结账模型与指定 Value Card…");
  const expectedValueCardCharge = parseConfirmationPrice(confirmation.price, "SEK");
  if (expectedValueCardCharge > Number(config.maxValueCardChargeSek)) {
    throw new MatchiError(
      `确认页场地价 ${expectedValueCardCharge.toFixed(2)} SEK 超过扣款上限 ${config.maxValueCardChargeSek} SEK；拒绝付款`,
    );
  }
  const constraints = {
    currency: "SEK",
    maxTotal: Number(config.maxTotalSek),
    valueCardId: Number(config.valueCardId),
    valueCardName: config.valueCardName,
    expectedValueCardCharge,
    maxValueCardCharge: Number(config.maxValueCardChargeSek),
  };
  const preparedStartedAt = performance.now();
  const prepared = await client.prepareValueCardCheckout(confirmation, constraints);
  const prepareMs = elapsedMs(preparedStartedAt);
  console.log(
    `付款保护通过（${prepareMs.toFixed(1)}ms）：总额 ${prepared.total.toFixed(2)} ${prepared.currency}；`
    + `Value Card「${prepared.card.name}」余额 ${Number(prepared.card.amount).toFixed(2)} ${prepared.card.currency}`,
  );
  emitEvent("value-card-validated", {
    preliminaryTotal: prepared.total,
    expectedCharge: expectedValueCardCharge,
    currency: prepared.currency,
    balance: Number(prepared.card.amount),
    prepareMs,
    steps: prepared.timings,
  });

  const guard = await createTransactionGuard(config, selections, prepared);
  try {
    await updateTransactionState(guard, { status: "submitting", submittedAt: new Date().toISOString() });
    const commitStartedAt = performance.now();
    const submittedReceipt = await client.commitValueCardCheckout(prepared);
    const commitMs = elapsedMs(commitStartedAt);
    const verificationStartedAt = performance.now();
    const postPaymentVerification = await verifyCommittedValueCardBooking(client, config, selections, {
      balanceBefore: Number(prepared.card.amount),
      chargedAmount: Number(submittedReceipt.chargedAmount),
    });
    const profileVerifyMs = elapsedMs(verificationStartedAt);
    const { profileVerified, balanceVerified } = postPaymentVerification;
    const postPaymentVerified = profileVerified && balanceVerified;
    const receipt = {
      ...submittedReceipt,
      observedBalanceAfter: postPaymentVerification.observedBalanceAfter,
      balanceVerified,
    };
    await updateTransactionState(guard, {
      status: postPaymentVerified ? "completed" : "completed-verification-warning",
      completedAt: new Date().toISOString(),
      profileVerified,
      balanceVerified,
      postPaymentVerified,
      postPaymentVerification,
      receipt,
    });

    console.log("\nValue Card 预订提交成功；脚本已永久锁定本次 transactionId，不会再次下单：");
    console.log(`- 目标：${config.targetDate} ${config.startTime}，${selections.map((item) => item.court).join(", ")}`);
    console.log(`- 扣款：${receipt.chargedAmount.toFixed(2)} ${receipt.currency}`);
    console.log(
      `- 实时余额：${receipt.observedBalanceAfter === null
        ? "读取失败"
        : `${receipt.observedBalanceAfter.toFixed(2)} ${receipt.currency}`}`,
    );
    console.log(`- 订单状态：${receipt.orderStatus}${receipt.orderId ? `；订单 ${receipt.orderId}` : ""}`);
    console.log(
      `- 事后复核：精确日期/场号/${config.startTime}-${postPaymentVerification.expectedEndTime} `
      + `${profileVerified ? "已匹配" : "未匹配"}；Value Card 余额 ${balanceVerified ? "已匹配" : "未匹配"}`,
    );
    if (!postPaymentVerified) {
      console.warn("- 警告：订单提交已发生，但事后双重核验不完整；交易锁继续保留，脚本不会自动重下");
    }
    console.log(`- 性能：结账提交 ${commitMs.toFixed(1)}ms；精确复核 ${profileVerifyMs.toFixed(1)}ms`);
    emitEvent("booking-completed", {
      courts: selections.map((selection) => selection.court),
      date: config.targetDate,
      startTime: config.startTime,
      receipt,
      timing: {
        ...telemetry,
        prepareMs,
        commitMs,
        profileVerifyMs,
      },
      profileVerified,
      balanceVerified,
      postPaymentVerified,
    });
  } catch (error) {
    await updateTransactionState(guard, {
      status: "failed-or-uncertain",
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function assertValueCardTargetSafety(config, selections) {
  if (config.targetDate !== config.requiredTargetDate || config.startTime !== config.requiredStartTime) {
    throw new MatchiError("实际目标与锁定的日期/时间不一致；拒绝付款");
  }
  if (Number(config.quantity) !== Number(config.requiredQuantity) || selections.length !== Number(config.requiredQuantity)) {
    throw new MatchiError("实际场地数量与锁定数量不一致；拒绝付款");
  }
  if (Number(config.durationMinutes) !== Number(config.requiredDurationMinutes)) {
    throw new MatchiError("实际预订时长与锁定时长不一致；拒绝付款");
  }
  if (selections.some((selection) => selection.slots[0]?.start !== config.requiredStartTime)) {
    throw new MatchiError("MATCHi 返回的开始时间与锁定时间不一致；拒绝付款");
  }
  const targetStart = computeTargetStartInstant(config.targetDate, config.startTime, config.timeZone);
  const leadHours = (targetStart.getTime() - Date.now()) / 3_600_000;
  if (leadHours < Number(config.minimumLeadHours)) {
    throw new MatchiError(
      `目标只剩 ${leadHours.toFixed(1)} 小时，不满足至少 ${config.minimumLeadHours} 小时的远期保护；拒绝付款`,
    );
  }
}

async function createTransactionGuard(config, selections, prepared) {
  const statePath = resolve(config.stateFile);
  const lockPath = `${statePath}.lock`;
  await mkdir(dirname(statePath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      let prior = "";
      let priorStatus = "";
      try {
        prior = await readFile(statePath, "utf8");
        priorStatus = JSON.parse(prior).status || "状态未知";
      } catch {
        // The lock itself is authoritative even if the state file is unavailable.
      }
      throw new MatchiError(
        `本次单次交易已有锁，拒绝重复下单${prior ? `：${priorStatus || "状态未知"}` : ""}`,
      );
    }
    throw error;
  }

  const initial = {
    transactionId: config.transactionId,
    executionId: config.executionId || null,
    status: "prepared",
    createdAt: new Date().toISOString(),
    target: {
      facilityId: Number(config.facilityId),
      sportId: Number(config.sportId),
      date: config.targetDate,
      startTime: config.startTime,
      durationMinutes: Number(config.durationMinutes),
      courts: selections.map((selection) => selection.court),
    },
    payment: {
      method: "VALUE_CARD_ONLY",
      valueCardId: Number(config.valueCardId),
      valueCardName: config.valueCardName,
      total: prepared.total,
      currency: prepared.currency,
      balanceBefore: Number(prepared.card.amount),
      maxTotal: Number(config.maxTotalSek),
      maxValueCardCharge: Number(config.maxValueCardChargeSek),
    },
  };
  await handle.writeFile(`${JSON.stringify({ transactionId: config.transactionId, createdAt: initial.createdAt })}\n`, "utf8");
  await handle.close();
  await writeFile(statePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
  return { statePath, state: initial };
}

async function createMultiTransactionGuard(config, preparedOrders, totals) {
  const statePath = resolve(config.stateFile);
  const lockPath = `${statePath}.lock`;
  await mkdir(dirname(statePath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      let prior = "";
      let priorStatus = "";
      try {
        prior = await readFile(statePath, "utf8");
        priorStatus = JSON.parse(prior).status || "状态未知";
      } catch {
        // The lock itself is authoritative even if the state file is unavailable.
      }
      throw new MatchiError(
        `本次多场地交易已有锁，拒绝重复下单${prior ? `：${priorStatus || "状态未知"}` : ""}`,
      );
    }
    throw error;
  }

  const initial = {
    transactionId: config.transactionId,
    executionId: config.executionId || null,
    status: "prepared",
    createdAt: new Date().toISOString(),
    target: {
      facilityId: Number(config.facilityId),
      sportId: Number(config.sportId),
      date: config.targetDate,
      startTime: config.startTime,
      durationMinutes: Number(config.durationMinutes),
      courts: preparedOrders.map((item) => item.selection.court),
    },
    payment: {
      method: "VALUE_CARD_ONLY_SEPARATE_ORDERS",
      valueCardId: Number(config.valueCardId),
      valueCardName: config.valueCardName,
      preliminaryTotal: totals.preliminaryTotal,
      expectedChargeTotal: totals.expectedChargeTotal,
      currency: "SEK",
      balanceBefore: totals.balanceBefore,
      maxTotal: Number(config.maxTotalSek),
      maxValueCardCharge: Number(config.maxValueCardChargeSek),
    },
    completedCount: 0,
    requiredQuantity: Number(config.requiredQuantity),
    allowOverbookingOnUncertain: Boolean(config.allowOverbookingOnUncertain),
    maxOverbookCourts: config.allowOverbookingOnUncertain ? Number(config.maxOverbookCourts || 0) : 0,
    maximumPossibleCourts: Number(config.requiredQuantity)
      + (config.allowOverbookingOnUncertain ? Number(config.maxOverbookCourts || 0) : 0),
    orders: [],
    failedAttempts: [],
    uncertainAttempts: [],
  };
  await handle.writeFile(`${JSON.stringify({ transactionId: config.transactionId, createdAt: initial.createdAt })}\n`, "utf8");
  await handle.close();
  await writeFile(statePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
  return { statePath, state: initial };
}

async function updateTransactionState(guard, patch) {
  guard.state = { ...guard.state, ...patch };
  await writeFile(guard.statePath, `${JSON.stringify(guard.state, null, 2)}\n`, "utf8");
}

async function verifyProfileBooking(client, config, selections) {
  try {
    const profile = await client.text("/profile/home");
    if (!profile.response.ok) return false;
    const [, month, day] = config.targetDate.split("-");
    const dateHints = [
      `${Number(day)}/${Number(month)}`,
      `${day}/${month}`,
    ];
    const candidateUrls = [...new Set(extractCancellationAnchors(profile.html)
      .filter((anchor) => (
        anchor.text.includes(config.startTime)
        && dateHints.some((hint) => anchor.text.includes(hint))
      ))
      .map((anchor) => anchor.href))];
    if (candidateUrls.length < selections.length) return false;

    const settled = await Promise.allSettled(candidateUrls.map(async (url) => {
      const detail = await client.text(url);
      if (!detail.response.ok) throw new MatchiError(`预订详情返回 HTTP ${detail.response.status}`);
      return detail.html;
    }));
    const details = settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    return selections.every((selection) => details.some((html) => analyzeBookingDetail(html, {
      facilityName: config.facilityName,
      date: config.targetDate,
      startTime: config.startTime,
      durationMinutes: Number(config.durationMinutes),
      court: selection.court,
      requireValueCard: config.mode === "value-card",
    }).matched));
  } catch (error) {
    if (error instanceof MatchiError && error.details?.code === "AUTH_EXPIRED") throw error;
    return false;
  }
}

async function verifyCommittedValueCardBooking(client, config, selections, {
  balanceBefore,
  chargedAmount,
  uncertainCharges = [],
}) {
  const expectedBalanceAfter = roundMoney(Number(balanceBefore) - Number(chargedAmount));
  const possibleBalancesAfter = computePossibleBalances(expectedBalanceAfter, uncertainCharges);
  const minimumPossibleBalanceAfter = possibleBalancesAfter.at(-1) ?? expectedBalanceAfter;
  const expectedEndTime = addMinutesToClock(config.startTime, Number(config.durationMinutes));
  let profileVerified = false;
  let balanceVerified = false;
  let observedBalanceAfter = null;
  let attempts = 0;
  const readErrors = [];

  for (attempts = 1; attempts <= 4; attempts += 1) {
    const [profileResult, cardsResult] = await Promise.allSettled([
      verifyProfileBooking(client, config, selections),
      client.getProfileValueCards(),
    ]);
    profileVerified = profileResult.status === "fulfilled" && profileResult.value === true;
    if (profileResult.status === "rejected") {
      readErrors.push(profileResult.reason instanceof Error ? profileResult.reason.message : String(profileResult.reason));
    }
    if (cardsResult.status === "fulfilled") {
      const card = cardsResult.value.find((candidate) => Number(candidate.id) === Number(config.valueCardId));
      observedBalanceAfter = card && Number.isFinite(Number(card.balance)) ? Number(card.balance) : null;
      balanceVerified = observedBalanceAfter !== null && possibleBalancesAfter.some(
        (possible) => Math.abs(observedBalanceAfter - possible) < 0.01,
      );
    } else {
      readErrors.push(cardsResult.reason instanceof Error ? cardsResult.reason.message : String(cardsResult.reason));
    }
    const authExpired = [profileResult, cardsResult].some((result) => (
      result.status === "rejected"
      && result.reason instanceof MatchiError
      && result.reason.details?.code === "AUTH_EXPIRED"
    ));
    if (authExpired && attempts < 4) {
      await client.reauthenticate("/profile/home");
      emitEvent("session-restored", { paymentStage: "post-payment-verification", attempt: attempts });
      continue;
    }
    emitEvent("post-payment-verification", {
      attempt: attempts,
      profileVerified,
      balanceVerified,
      observedBalanceAfter,
      expectedBalanceAfter,
      minimumPossibleBalanceAfter,
      possibleBalancesAfter,
    });
    if (profileVerified && balanceVerified) break;
    if (attempts < 4) await sleep(attempts * 350);
  }
  attempts = Math.min(attempts, 4);

  return {
    profileVerified,
    balanceVerified,
    observedBalanceAfter,
    expectedBalanceAfter,
    minimumPossibleBalanceAfter,
    possibleBalancesAfter,
    expectedEndTime,
    attempts,
    readErrors: [...new Set(readErrors)],
  };
}

async function wizard(options) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const slug = (await rl.question("场馆 slug（ATL 输入 atl）[atl]: ")).trim() || "atl";
    const client = new MatchiClient();
    console.log("正在读取场馆资料…");
    const facility = await client.discoverFacility(slug);
    console.log(`场馆：${facility.name}（ID ${facility.id}）`);
    for (const sport of facility.sports) console.log(`  ${sport.id}: ${sport.name}`);
    const sportId = Number((await rl.question(`运动编号 [${facility.sports[0]?.id || 1}]: `)).trim() || facility.sports[0]?.id || 1);
    const sport = facility.sports.find((item) => item.id === sportId);
    const targetDate = (await rl.question("目标日期 YYYY-MM-DD: ")).trim();
    const startTime = (await rl.question("开始整点 HH:00: ")).trim();
    const durationMinutes = Number((await rl.question("时长（分钟）[60]: ")).trim() || 60);
    const courts = (await rl.question("候选场地，逗号分隔（如 B7,B8,B9；留空表示任意）: ")).split(",").map((item) => item.trim()).filter(Boolean);
    const quantity = Number((await rl.question("同时需要几块场地 [1]: ")).trim() || 1);
    const mode = (await rl.question("模式 dry-run/confirm/checkout [dry-run]: ")).trim() || "dry-run";
    const config = {
      facilitySlug: slug,
      facilityId: facility.id,
      facilityName: facility.name,
      timeZone: "Europe/Stockholm",
      sportId,
      sportName: sport?.name || String(sportId),
      targetDate,
      startTime,
      durationMinutes,
      courtPreferences: courts,
      allowAnyCourt: courts.length === 0,
      quantity,
      advanceDays: 14,
      releaseAt: null,
      loginLeadSeconds: 180,
      pollIntervalMs: 1000,
      pollTimeoutSeconds: 180,
      keepPollingIfUnavailable: false,
      mode,
    };
    validateConfig(config);
    const output = resolve(options.config || "config.json");
    await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    console.log(`已保存：${output}`);
  } finally {
    rl.close();
  }
}

async function getCredentials() {
  let email = process.env.MATCHI_EMAIL || "";
  let password = process.env.MATCHI_PASSWORD || "";
  if (email && password) return { email, password };
  if (!process.stdin.isTTY) throw new MatchiError("非交互环境请设置 MATCHI_EMAIL 和 MATCHI_PASSWORD");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!email) email = (await rl.question("MATCHi 邮箱: ")).trim();
  } finally {
    rl.close();
  }
  if (!password) password = await hiddenPrompt("MATCHi 密码: ");
  return { email, password };
}

async function hiddenPrompt(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new MatchiError("当前终端不能隐藏密码，请临时设置 MATCHI_PASSWORD 环境变量");
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  try {
    for await (const chunk of process.stdin) {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          process.stdout.write("\n");
          return value;
        }
        if (char === "\u0003") throw new MatchiError("用户取消");
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return value;
}

function printTarget(config, releaseAt) {
  console.log("MATCHi 抢订目标");
  console.log(`- 场馆：${config.facilityName || config.facilitySlug} (${config.facilityId})`);
  console.log(`- 运动：${config.sportName || config.sportId}`);
  console.log(`- 时间：${config.targetDate} ${config.startTime}，${config.durationMinutes} 分钟`);
  console.log(`- 场地：${config.courtPreferences?.join(", ") || "任意"}；数量=${config.quantity || 1}`);
  console.log(`- 放票：${formatInZone(releaseAt, config.timeZone)} (${config.timeZone})`);
  console.log(`- 模式：${config.mode}\n`);
}

async function waitUntil(target, label) {
  let lastLoggedMinute = null;
  let waited = false;
  while (Date.now() < target.getTime()) {
    waited = true;
    const remaining = target.getTime() - Date.now();
    if (remaining > 10_000) {
      if (process.stdout.isTTY) {
        process.stdout.write(`\r${label}：还剩 ${Math.ceil(remaining / 1000)} 秒   `);
      } else {
        const remainingMinute = Math.ceil(remaining / 60_000);
        if (remainingMinute !== lastLoggedMinute) {
          console.log(`[${timestamp()}] ${label}：还剩约 ${remainingMinute} 分钟`);
          lastLoggedMinute = remainingMinute;
        }
      }
    }
    await sleep(Math.min(remaining, 1000));
  }
  if (waited) {
    if (process.stdout.isTTY) process.stdout.write("\r" + " ".repeat(70) + "\r");
    else console.log(`[${timestamp()}] ${label}结束`);
  }
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") result.config = args[++index];
    else if (arg === "--mode") result.mode = args[++index];
    else if (arg === "--allow-checkout") result.allowCheckout = true;
    else if (arg === "--allow-value-card-payment") result.allowValueCardPayment = true;
    else if (arg === "--help" || arg === "-h") showHelp(0);
    else throw new MatchiError(`未知参数：${arg}`);
  }
  return result;
}

function showHelp(exitCode) {
  console.log(`用法：
  node src/cli.mjs wizard [--config config.json]
  node src/cli.mjs check  [--config config.json]
  node src/cli.mjs run    [--config config.json] [--mode dry-run|confirm|checkout|value-card]
                          [--allow-checkout] [--allow-value-card-payment]

模式：
  dry-run   只检测，不打开确认页
  confirm   打开并解析确认页，不进入付款入口
  checkout   只创建在线支付入口；必须显式允许，脚本不会付款
  value-card 仅在 Value Card 全额覆盖且满足硬保护时提交一次真实预订`);
  process.exit(exitCode);
}

function formatInZone(date, timeZone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function timestamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function emitEvent(type, data = {}) {
  console.log(`MATCHI_EVENT ${JSON.stringify({ type, at: new Date().toISOString(), ...data })}`);
}

function parseConfirmationPrice(label, expectedCurrency) {
  const match = String(label || "").match(/(\d+(?:[.,]\d+)?)\s*([A-Z]{3})/i);
  if (!match || match[2].toUpperCase() !== expectedCurrency) {
    throw new MatchiError(`无法从确认页验证 ${expectedCurrency} 场地价；拒绝付款`);
  }
  return Number(match[1].replace(",", "."));
}

function roundMoney(value) {
  return Number(Number(value).toFixed(2));
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, ms)));
}

function elapsedMs(startedAt) {
  return Number((performance.now() - startedAt).toFixed(1));
}
