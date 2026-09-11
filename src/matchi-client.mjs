import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A local .env file is convenient for CLI use and is ignored by Git. Existing
// process environment variables always win, and passwords are never written
// by this project.
const localEnvPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(localEnvPath)) {
  for (const line of readFileSync(localEnvPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#") || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

const MATCHI_ORIGIN = "https://www.matchi.se";
const MATCHI_CHECKOUT_API_ORIGIN = "https://api.matchi.com";
const MATCHI_CHECKOUT_API_KEY = process.env.MATCHI_CHECKOUT_API_KEY || "";

export class MatchiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MatchiError";
    this.details = details;
  }
}

export class CookieJar {
  constructor() {
    this.cookies = [];
  }

  setFromResponse(response, requestUrl) {
    const values = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : splitSetCookieHeader(response.headers.get("set-cookie"));

    for (const value of values) {
      if (value) this.setCookie(value, requestUrl);
    }
  }

  setCookie(header, requestUrl) {
    const url = new URL(requestUrl);
    const pieces = header.split(";").map((part) => part.trim());
    const firstEquals = pieces[0]?.indexOf("=") ?? -1;
    if (firstEquals <= 0) return;

    const cookie = {
      name: pieces[0].slice(0, firstEquals),
      value: pieces[0].slice(firstEquals + 1),
      domain: url.hostname.toLowerCase(),
      hostOnly: true,
      path: defaultCookiePath(url.pathname),
      secure: false,
      expiresAt: null,
    };

    for (const piece of pieces.slice(1)) {
      const equals = piece.indexOf("=");
      const key = (equals === -1 ? piece : piece.slice(0, equals)).toLowerCase();
      const rawValue = equals === -1 ? "" : piece.slice(equals + 1);
      if (key === "domain") {
        cookie.domain = rawValue.replace(/^\./, "").toLowerCase();
        cookie.hostOnly = false;
      } else if (key === "path") {
        cookie.path = rawValue || "/";
      } else if (key === "secure") {
        cookie.secure = true;
      } else if (key === "max-age") {
        const seconds = Number(rawValue);
        if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
      } else if (key === "expires" && cookie.expiresAt === null) {
        const timestamp = Date.parse(rawValue);
        if (Number.isFinite(timestamp)) cookie.expiresAt = timestamp;
      }
    }

    this.cookies = this.cookies.filter((item) => !(
      item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path
    ));
    if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) return;
    this.cookies.push(cookie);
  }

  headerFor(requestUrl) {
    const url = new URL(requestUrl);
    const now = Date.now();
    this.cookies = this.cookies.filter((cookie) => cookie.expiresAt === null || cookie.expiresAt > now);
    return this.cookies
      .filter((cookie) => cookieMatches(cookie, url))
      .sort((a, b) => b.path.length - a.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }
}

export class MatchiClient {
  constructor({ timeoutMs = 20_000, userAgent } = {}) {
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent || "Mozilla/5.0 MATCHiSlotTool/0.1 (+local user automation)";
    this.jar = new CookieJar();
    this.authenticated = false;
    this.reauthenticationCredentials = null;
  }

  async request(url, options = {}) {
    let currentUrl = new URL(url, MATCHI_ORIGIN).toString();
    let method = (options.method || "GET").toUpperCase();
    let body = options.body;
    let redirects = 0;
    const maxRedirects = options.maxRedirects ?? 15;

    while (true) {
      const headers = new Headers(options.headers || {});
      headers.set("User-Agent", this.userAgent);
      headers.set("Accept-Language", "en-US,en;q=0.9");
      if (!headers.has("Accept")) headers.set("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
      const cookieHeader = this.jar.headerFor(currentUrl);
      if (cookieHeader) headers.set("Cookie", cookieHeader);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
      let response;
      try {
        response = await fetch(currentUrl, {
          method,
          body,
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (error.name === "AbortError") {
          throw new MatchiError(`请求超时：${currentUrl}`, { code: "NETWORK_TRANSIENT" });
        }
        throw new MatchiError(`网络请求失败：${currentUrl}`, {
          code: "NETWORK_TRANSIENT",
          cause: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timeout);
      }

      this.jar.setFromResponse(response, currentUrl);
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return { response, url: currentUrl };
      }

      if (maxRedirects === 0) return { response, url: currentUrl };

      if (++redirects > maxRedirects) throw new MatchiError("登录跳转次数过多");
      const location = response.headers.get("location");
      if (!location) return { response, url: currentUrl };
      const nextUrl = new URL(location, currentUrl).toString();

      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      currentUrl = nextUrl;
    }
  }

  async text(url, options = {}) {
    const result = await this.request(url, options);
    const html = await result.response.text();
    if (this.authenticated) {
      const finalUrl = new URL(result.url);
      const returnedToLogin = finalUrl.hostname === "auth.matchi.com"
        || (finalUrl.hostname === "www.matchi.se" && finalUrl.pathname.startsWith("/login/"));
      if (returnedToLogin) {
        throw new MatchiError("MATCHi 登录会话已失效", {
          code: "AUTH_EXPIRED",
          status: result.response.status,
        });
      }
    }
    return { ...result, html };
  }

  async login(email, password, returnPath = "/profile/home") {
    if (!email || !password) throw new MatchiError("需要 MATCHI_EMAIL 和 MATCHI_PASSWORD");
    this.authenticated = false;
    const loginUrl = `${MATCHI_ORIGIN}/login/auth?returnUrl=${encodeURIComponent(returnPath)}`;
    const authPage = await this.text(loginUrl);
    const loginActionMatch = authPage.html.match(/"loginAction"\s*:\s*"([^"]+)"/i);
    if (!loginActionMatch) throw new MatchiError("找不到 MATCHi 登录动作，页面结构可能已改变");

    const loginAction = decodeHtml(loginActionMatch[1]).replaceAll("\\/", "/");
    const form = new URLSearchParams({ username: email, password, credentialId: "" });
    const result = await this.text(loginAction, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const finalUrl = new URL(result.url);
    const failed = finalUrl.hostname === "auth.matchi.com" || /Invalid username or password/i.test(result.html);
    if (failed) throw new MatchiError("MATCHi 登录失败，请检查账号、密码或验证码要求");
    if (finalUrl.hostname !== "www.matchi.se") throw new MatchiError(`登录后进入了未知地址：${result.url}`);
    this.authenticated = true;
    this.reauthenticationCredentials = { email, password };
    return result;
  }

  async reauthenticate(returnPath = "/profile/home") {
    const credentials = this.reauthenticationCredentials;
    if (!credentials?.email || !credentials?.password) {
      throw new MatchiError("登录会话失效且没有可用的内存凭据", { code: "AUTH_EXPIRED" });
    }
    return this.login(credentials.email, credentials.password, returnPath);
  }

  async discoverFacility(slug) {
    const result = await this.text(`${MATCHI_ORIGIN}/facilities/${encodeURIComponent(slug)}?lang=en`);
    if (!result.response.ok) throw new MatchiError(`场馆页面返回 HTTP ${result.response.status}`);
    return parseFacilityPage(result.html, slug);
  }

  async getProfileValueCards() {
    this.ensureAuthenticated();
    const result = await this.text(`${MATCHI_ORIGIN}/profile/home`);
    if (!result.response.ok) throw new MatchiError(`账号页面返回 HTTP ${result.response.status}`);
    return parseProfileValueCards(result.html);
  }

  async getSchedule({ facilityId, sportId, date }) {
    this.ensureAuthenticated();
    const params = new URLSearchParams({
      wl: "",
      facilityId: String(facilityId),
      date,
      sport: String(sportId),
      week: "",
      year: "",
      _: String(Date.now()),
    });
    const result = await this.text(`${MATCHI_ORIGIN}/book/schedule?${params}`, {
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    if (!result.response.ok) {
      throw new MatchiError(`日历请求失败：HTTP ${result.response.status}`, {
        status: result.response.status,
        retryAfter: result.response.headers.get("retry-after"),
      });
    }
    const context = parseScheduleContext(result.html);
    if (
      context.date !== date
      || Number(context.facilityId) !== Number(facilityId)
      || Number(context.sportId) !== Number(sportId)
    ) {
      throw new MatchiError("MATCHi 日历响应的日期、场馆或运动与请求不一致；拒绝使用其中的 slot", {
        code: "SCHEDULE_CONTEXT_MISMATCH",
        requested: { date, facilityId: Number(facilityId), sportId: Number(sportId) },
        observed: context,
      });
    }
    return {
      html: result.html,
      slots: parseScheduleSlots(result.html),
      notice: parseScheduleNotice(result.html),
      serverDate: result.response.headers.get("date"),
      context,
    };
  }

  async prewarmBookingOrigins({ timeoutMs = 1_000 } = {}) {
    const urls = [
      `${MATCHI_ORIGIN}/favicon.ico`,
      "https://checkout.matchi.com/favicon.ico",
      `${MATCHI_CHECKOUT_API_ORIGIN}/favicon.ico`,
    ];
    const startedAt = performance.now();
    const results = await Promise.allSettled(urls.map((url) => this.text(url, {
      timeoutMs,
      maxRedirects: 0,
      headers: { "Cache-Control": "no-cache" },
    })));
    return {
      elapsedMs: roundElapsed(startedAt),
      fulfilled: results.filter((item) => item.status === "fulfilled").length,
      total: results.length,
    };
  }

  async getConfirmation({ facilityId, slotIds, refererSlug }) {
    this.ensureAuthenticated();
    if (!slotIds?.length) throw new MatchiError("确认页至少需要一个 slotId");
    const requestedSlotIds = slotIds.map(String);
    const firstSlotId = requestedSlotIds[0];
    const form = new URLSearchParams();
    // MATCHi first opens a confirmation for the starting slot. Longer
    // bookings are then extended through updateConfirmModalModel; posting
    // adjacent slot IDs directly to /confirm returns HTTP 500.
    form.append("slotIds", firstSlotId);
    form.append("facilityId", String(facilityId));

    const result = await this.text(`${MATCHI_ORIGIN}/bookingPayment/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${MATCHI_ORIGIN}/facilities/${encodeURIComponent(refererSlug)}`,
      },
      body: form.toString(),
    });
    if (!result.response.ok) {
      const summary = htmlToText(result.html).slice(0, 500);
      const failureCode = classifyBookingFailure(result.response.status, summary);
      throw new MatchiError(`确认页失败：HTTP ${result.response.status}`, {
        status: result.response.status,
        code: failureCode,
        retryAfter: result.response.headers.get("retry-after"),
        summary,
      });
    }
    const confirmation = parseConfirmation(result.html);
    if (!confirmation.formAction) {
      const failureCode = classifyBookingFailure(result.response.status, confirmation.summary);
      throw new MatchiError("确认页没有可验证的付款表单；未进入付款", {
        code: failureCode === "CONFIRMATION_HTTP" ? "CONFIRMATION_INVALID" : failureCode,
        text: confirmation.summary,
      });
    }
    if (requestedSlotIds.length > 1) {
      const offeredSlotIds = parseTrailingSlotIds(result.html, firstSlotId);
      const offeredPrefixMatches = requestedSlotIds.every(
        (slotId, index) => offeredSlotIds[index] === slotId,
      );
      if (!offeredPrefixMatches) {
        throw new MatchiError("MATCHi 确认页不再提供完整的连续时长；未进入付款", {
          code: "SLOT_CONFLICT",
          requestedSlotIds,
          offeredSlotIds,
        });
      }

      const params = new URLSearchParams({
        slotIds: requestedSlotIds.join(","),
        firstSlotIds: firstSlotId,
        _: String(Date.now()),
      });
      const durationResult = await this.text(
        `${MATCHI_ORIGIN}/bookingPayment/updateConfirmModalModel?${params}`,
        {
          headers: {
            "Cache-Control": "no-cache",
            "X-Requested-With": "XMLHttpRequest",
            Referer: `${MATCHI_ORIGIN}/facilities/${encodeURIComponent(refererSlug)}`,
          },
        },
      );
      if (!durationResult.response.ok) {
        const summary = htmlToText(durationResult.html).slice(0, 500);
        const failureCode = classifyBookingFailure(durationResult.response.status, summary);
        throw new MatchiError(`确认页时长更新失败：HTTP ${durationResult.response.status}`, {
          status: durationResult.response.status,
          code: failureCode,
          retryAfter: durationResult.response.headers.get("retry-after"),
          summary,
        });
      }

      let durationModel;
      try {
        durationModel = JSON.parse(durationResult.html);
      } catch {
        throw new MatchiError("MATCHi 时长更新没有返回可验证的 JSON；未进入付款", {
          code: "CONFIRMATION_HTTP",
        });
      }
      const modelPrices = durationModel?.prices || {};
      const totalPrice = Number(durationModel?.totalPrice);
      const methods = Array.isArray(durationModel?.methods)
        ? durationModel.methods.map((item) => String(item?.name || "")).filter(Boolean)
        : [];
      const trainerModel = durationModel?.bookTrainerModel;
      const everySlotPriced = requestedSlotIds.every(
        (slotId) => Number.isFinite(Number(modelPrices[slotId])),
      );
      if (!everySlotPriced
          || Number(durationModel?.nPrices) !== requestedSlotIds.length
          || !Number.isFinite(totalPrice)
          || totalPrice <= 0
          || trainerModel?.slotsAreConsecutive === false
          || trainerModel?.slotsAreSameCourt === false
          || !methods.includes("CHECKOUT_SESSION")) {
        throw new MatchiError("MATCHi 返回的长时段价格、连续性或付款方式无法通过验证；未进入付款", {
          code: "SLOT_CONFLICT",
          requestedSlotIds,
        });
      }

      const currencyMatch = String(confirmation.price || "").match(/\b([A-Z]{3})\b/i);
      if (!currencyMatch) {
        throw new MatchiError("无法从确认页验证长时段币种；未进入付款");
      }
      let replacedSlotField = false;
      confirmation.fields = confirmation.fields.map(([name, value]) => {
        if (name !== "slotIds") return [name, value];
        replacedSlotField = true;
        return [name, requestedSlotIds.join(",")];
      });
      if (!replacedSlotField) confirmation.fields.unshift(["slotIds", requestedSlotIds.join(",")]);
      confirmation.price = `${totalPrice} ${currencyMatch[1].toUpperCase()}`;
      confirmation.paymentMethods = methods;
      confirmation.durationModel = durationModel;
      confirmation.extendedSlotIds = requestedSlotIds;
    }
    return confirmation;
  }

  async createOnlineCheckout(confirmation) {
    this.ensureAuthenticated();
    if (!confirmation.paymentMethods.includes("CHECKOUT_SESSION")) {
      throw new MatchiError("确认页没有在线支付方式，拒绝使用余额或其他付款方式");
    }

    const form = new URLSearchParams();
    for (const [name, value] of confirmation.fields) {
      if (["method", "next"].includes(name)) continue;
      if (name === "splitPayment" || name === "numberOfSlots") continue;
      form.append(name, value);
    }
    form.set("method", "CHECKOUT_SESSION");
    form.set("next", "Next");

    const result = await this.request(new URL(confirmation.formAction, MATCHI_ORIGIN), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${MATCHI_ORIGIN}/facilities/${encodeURIComponent(confirmation.facilitySlug || "")}`,
      },
      body: form.toString(),
      maxRedirects: 0,
    });

    const location = result.response.headers.get("location");
    if (location) {
      const locationUrl = new URL(location, result.url);
      // MATCHi may first redirect to its same-origin Adyen bootstrap page.
      // That page contains the actual checkout.matchi.com URL and must be
      // fetched before resolving the bearer token in resolveCheckoutContext.
      if (locationUrl.hostname === new URL(MATCHI_ORIGIN).hostname
          && locationUrl.pathname === "/adyen/checkoutSession") {
        const bootstrap = await this.text(locationUrl.toString(), {
          headers: { Referer: new URL(confirmation.formAction, MATCHI_ORIGIN).toString() },
        });
        const hosted = extractHostedCheckoutUrl(bootstrap.html) || extractPaymentUrl(bootstrap.html);
        if (!hosted) {
          throw new MatchiError("Adyen 中转页没有返回托管结账地址；未使用 Value Card", {
            status: bootstrap.response.status,
          });
        }
        return new URL(hosted, bootstrap.url || locationUrl).toString();
      }
      return locationUrl.toString();
    }
    const html = await result.response.text();
    const paymentUrl = extractPaymentUrl(html);
    if (!paymentUrl) {
      const slotConflict = [409, 410, 422].includes(result.response.status);
      throw new MatchiError("付款入口没有返回可打开的在线支付地址；未继续操作", {
        status: result.response.status,
        code: slotConflict ? "SLOT_CONFLICT" : undefined,
        summary: htmlToText(html).slice(0, 500),
      });
    }
    return paymentUrl;
  }

  async prepareValueCardCheckout(confirmation, constraints = {}) {
    this.ensureAuthenticated();
    const timings = {};
    let startedAt = performance.now();
    const entryUrl = await this.createOnlineCheckout(confirmation);
    timings.checkoutEntryMs = roundElapsed(startedAt);
    startedAt = performance.now();
    const context = await this.resolveCheckoutContext(entryUrl);
    timings.resolveContextMs = roundElapsed(startedAt);
    startedAt = performance.now();
    const model = await this.getCheckoutModel(context);
    timings.initialModelMs = roundElapsed(startedAt);
    const verified = validateValueCardModel(model, constraints);
    timings.totalMs = Number((timings.checkoutEntryMs + timings.resolveContextMs + timings.initialModelMs).toFixed(1));
    return { context, model, timings, ...verified };
  }

  async commitValueCardCheckout(prepared) {
    this.ensureAuthenticated();
    const { context, card, total, constraints = {} } = prepared;
    let applied = false;
    let finalSubmissionStarted = false;
    let stage = "apply-value-card";
    const timings = {};

    try {
      let startedAt = performance.now();
      await this.checkoutApi(context, `/checkout/${encodeURIComponent(context.checkoutToken)}/valuecard`, {
        method: "POST",
        body: { customerCouponId: Number(card.id), amount: total },
      });
      timings.applyValueCardMs = roundElapsed(startedAt);
      applied = true;

      stage = "verify-applied-value-card";
      startedAt = performance.now();
      const appliedModel = await this.getCheckoutModel(context);
      timings.verifyAppliedModelMs = roundElapsed(startedAt);
      const outcome = validateAppliedValueCardModel(appliedModel, {
        ...constraints,
        valueCardId: Number(card.id),
        expectedAmount: constraints.expectedValueCardCharge,
      });

      stage = "submit-order";
      finalSubmissionStarted = true;
      startedAt = performance.now();
      const result = await this.checkoutApi(context, `/checkout/${encodeURIComponent(context.checkoutToken)}`, {
        method: "POST",
        body: { payment: { method: "FREE" } },
      });
      timings.submitOrderMs = roundElapsed(startedAt);

      let finalModel = null;
      const submittedOrderId = result && typeof result === "object" ? result.orderId ?? null : null;
      const submittedOrderStatus = String(result?.orderStatus || "").toUpperCase();
      if (["FAILED", "CANCELLED", "CANCELED", "REJECTED"].includes(submittedOrderStatus)) {
        throw new MatchiError(`MATCHi 最终订单状态为 ${submittedOrderStatus}`, {
          code: "PAYMENT_SUBMISSION_REJECTED",
          orderId: submittedOrderId,
        });
      }
      if (submittedOrderId === null) {
        startedAt = performance.now();
        try {
          finalModel = await this.getCheckoutModel(context);
        } catch {
          // A completed checkout may become unreadable immediately. The successful
          // POST remains the authoritative result and is verified separately by CLI.
        }
        timings.finalModelMs = roundElapsed(startedAt);
        timings.finalModelSkipped = false;
      } else {
        // The successful submit response is authoritative and already identifies
        // the order. The CLI performs an account-page verification after the batch,
        // so another checkout GET here only delays the next contested court.
        timings.finalModelMs = 0;
        timings.finalModelSkipped = true;
      }
      timings.totalMs = Number([
        timings.applyValueCardMs,
        timings.verifyAppliedModelMs,
        timings.submitOrderMs,
        timings.finalModelMs,
      ].reduce((sum, value) => sum + value, 0).toFixed(1));

      return {
        orderId: submittedOrderId ?? finalModel?.orderId ?? appliedModel.orderId ?? modelOrderId(result),
        orderStatus: finalModel?.orderStatus ?? result?.orderStatus ?? "SUBMITTED",
        chargedAmount: outcome.amount,
        currency: outcome.currency,
        valueCardId: Number(card.id),
        valueCardName: card.name,
        balanceBefore: Number(card.amount),
        expectedBalanceAfter: Number((Number(card.amount) - outcome.amount).toFixed(2)),
        timings,
      };
    } catch (error) {
      const status = error instanceof MatchiError ? Number(error.details?.status) : Number.NaN;
      const explicitSlotConflict = [409, 410, 422].includes(status);
      const transientFailure = (error instanceof MatchiError && error.details?.code === "NETWORK_TRANSIENT")
        || isTransientHttpStatus(status);
      const expiredBeforeApply = stage === "apply-value-card" && !applied && status === 404;
      const shouldRollback = applied && (!finalSubmissionStarted || explicitSlotConflict);
      let rollbackAttempted = false;
      let rollbackSucceeded = false;
      if (shouldRollback) {
        rollbackAttempted = true;
        try {
          await this.checkoutApi(
            context,
            `/checkout/${encodeURIComponent(context.checkoutToken)}/valuecard/${encodeURIComponent(card.id)}`,
            { method: "DELETE" },
          );
          rollbackSucceeded = true;
        } catch {
          // Preserve the original error. Applying a value card to an unfinished
          // checkout does not authorize switching to any other payment method.
        }
      }
      const safeToReplace = (explicitSlotConflict && (!applied || rollbackSucceeded))
        || expiredBeforeApply
        || (!finalSubmissionStarted && rollbackSucceeded && transientFailure);
      const message = error instanceof Error ? error.message : String(error);
      throw new MatchiError(message, {
        ...(error instanceof MatchiError ? error.details : {}),
        code: safeToReplace ? "SAFE_SLOT_REPLACEMENT" : "PAYMENT_UNCERTAIN",
        safeToReplace,
        paymentStage: stage,
        valueCardApplied: applied,
        finalSubmissionStarted,
        rollbackAttempted,
        rollbackSucceeded,
      });
    }
  }

  async resolveCheckoutContext(entryUrl) {
    let hostedUrl = null;
    const parsedEntry = new URL(entryUrl, MATCHI_ORIGIN);
    if (parsedEntry.hostname === "checkout.matchi.com" && parsedEntry.pathname.startsWith("/pay/")) {
      hostedUrl = parsedEntry.toString();
    } else {
      if (parsedEntry.protocol !== "https:" || parsedEntry.hostname !== "www.matchi.se") {
        throw new MatchiError("付款入口跳转到了不允许的域名；拒绝继续");
      }
      const entry = await this.text(parsedEntry.toString());
      hostedUrl = extractHostedCheckoutUrl(entry.html);
    }

    if (!hostedUrl) {
      throw new MatchiError("MATCHi 没有返回托管结账页面；未使用 Value Card", {
        code: "CHECKOUT_CONTEXT_MISSING",
      });
    }
    const parsedHosted = new URL(hostedUrl);
    if (parsedHosted.protocol !== "https:" || parsedHosted.hostname !== "checkout.matchi.com") {
      throw new MatchiError("结账页面不属于 checkout.matchi.com；拒绝继续");
    }
    const checkoutToken = parsedHosted.pathname.split("/").filter(Boolean).at(-1);
    const bearerToken = parsedHosted.searchParams.get("token");
    if (!checkoutToken || !bearerToken) throw new MatchiError("结账页面缺少安全令牌；拒绝继续");
    return { checkoutToken, bearerToken };
  }

  async getCheckoutModel(context) {
    return this.checkoutApi(context, `/checkout/${encodeURIComponent(context.checkoutToken)}`);
  }

  async checkoutApi(context, path, options = {}) {
    if (!MATCHI_CHECKOUT_API_KEY) {
      throw new MatchiError(
        "缺少 MATCHI_CHECKOUT_API_KEY；只检测、确认预览和在线付款交接不需要此设置，Value Card 模式需要它",
        { code: "CHECKOUT_API_KEY_MISSING" },
      );
    }
    const method = (options.method || "GET").toUpperCase();
    const result = await this.text(`${MATCHI_CHECKOUT_API_ORIGIN}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${context.bearerToken}`,
        "x-api-key": MATCHI_CHECKOUT_API_KEY,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    let data = null;
    if (result.html.trim()) {
      try {
        data = JSON.parse(result.html);
      } catch {
        const slotConflict = [409, 410, 422].includes(result.response.status);
        throw new MatchiError(`MATCHi 结账 API 返回了非 JSON 内容（HTTP ${result.response.status}）`, {
          status: result.response.status,
          code: slotConflict ? "SLOT_CONFLICT" : undefined,
        });
      }
    }
    if (!result.response.ok) {
      const slotConflict = [409, 410, 422].includes(result.response.status);
      throw new MatchiError(`MATCHi 结账 API ${method} 失败：HTTP ${result.response.status}`, {
        status: result.response.status,
        code: slotConflict ? "SLOT_CONFLICT" : undefined,
        message: data?.message,
      });
    }
    return data;
  }

  ensureAuthenticated() {
    if (!this.authenticated) throw new MatchiError("请先登录 MATCHi");
  }
}

export function parseFacilityPage(html, slug = "") {
  const idMatch = html.match(/facilityId[=:\s"']+(\d+)/i);
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  const sports = [];
  for (const match of html.matchAll(/<option[^>]+value=["'](\d+)["'][^>]*>([\s\S]*?)<\/option>/gi)) {
    const rawName = htmlToText(match[2]);
    const name = (rawName.split(">").at(-1) || rawName).replace(/^[^A-Za-zÀ-ž]+/, "").trim();
    if (name && !sports.some((sport) => sport.id === Number(match[1]))) {
      sports.push({ id: Number(match[1]), name });
    }
  }
  if (!idMatch) throw new MatchiError(`无法从场馆 ${slug} 读取 facilityId`);
  return {
    slug,
    id: Number(idMatch[1]),
    name: titleMatch ? htmlToText(titleMatch[1]) : slug,
    sports,
  };
}

export function parseScheduleSlots(html) {
  const slots = [];
  // MATCHi nests the real slot table inside an outer <td>. Matching through
  // </td> swallows the first (07:00) inner cell of each court row, so only
  // inspect opening tags; every field needed by the parser is an attribute.
  for (const match of html.matchAll(/<td\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
    const cell = match[0];
    const slotId = attributeValue(cell, "slotid");
    const className = attributeValue(cell, "class") || "";
    if (!slotId || !className.split(/\s+/).includes("slot")) continue;

    const title = decodeHtml(attributeValue(cell, "title") || "");
    const parts = title.split(/<br\s*\/?>/i).map((part) => htmlToText(part)).filter(Boolean);
    const timeMatch = parts.at(-1)?.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
    slots.push({
      id: slotId,
      state: className.split(/\s+/).includes("free") ? "free" : "booked",
      court: parts.length >= 2 ? parts[1].trim() : "",
      start: timeMatch?.[1] || "",
      end: timeMatch?.[2] || "",
      durationMinutes: Number(attributeValue(cell, "data-slot-duration")) || minutesBetween(timeMatch?.[1], timeMatch?.[2]),
      minimumDurationMinutes: Number(attributeValue(cell, "data-slot-min-duration")) || 0,
      canStart: attributeValue(cell, "data-slot-can-start") !== "false",
    });
  }
  return slots;
}

export function parseScheduleContext(html) {
  const source = String(html);
  const dateMatch = source.match(/\bname=["']fromDate["'][^>]*\bvalue=["'](\d{4}-\d{2}-\d{2})/i)
    || source.match(/\bvalue=["'](\d{4}-\d{2}-\d{2})[^"']*["'][^>]*\bname=["']fromDate["']/i);
  const activeSportBlock = source.match(/<li\b[^>]*class=["'][^"']*(?:\bactive\b|\btab-current\b)[^"']*["'][^>]*>[\s\S]*?<\/li>/i)?.[0] || "";
  const activeHref = decodeHtml(attributeValue(activeSportBlock, "href") || "");
  let facilityId = null;
  let sportId = null;
  if (activeHref) {
    const params = new URL(activeHref, MATCHI_ORIGIN).searchParams;
    facilityId = Number(params.get("facilityId"));
    sportId = Number(params.get("sport"));
  }
  return {
    date: dateMatch?.[1] || null,
    facilityId: Number.isInteger(facilityId) ? facilityId : null,
    sportId: Number.isInteger(sportId) ? sportId : null,
  };
}

export function parseScheduleNotice(html) {
  const text = htmlToText(html);
  const advance = text.match(/allows bookings no more than\s+(\d+)\s+days/i);
  return {
    text: advance?.[0] || "",
    advanceDays: advance ? Number(advance[1]) : null,
  };
}

export function isTransientHttpStatus(status) {
  const value = Number(status);
  return [408, 425, 429].includes(value) || (value >= 500 && value < 600);
}

export function parseProfileValueCards(html) {
  const cards = [];
  for (const match of String(html).matchAll(/<li\b[^>]*class=["'][^"']*\blist-group-item\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi)) {
    const block = match[0];
    const text = htmlToText(block);
    const balanceMatch = text.match(/(\d+(?:[.,]\d{1,2})?)\s*SEK(?:\s+(?:left|tilbage|kvar))?/iu);
    if (!balanceMatch) continue;
    const idMatch = block.match(/\/profile\/showOfferHistory\/(\d+)/i);
    const nameMatch = block.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i);
    const facilityMatch = block.match(/<a\b[^>]*class=["'][^"']*\bcoupon-facility-name\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    const validUntilMatch = text.match(
      /(?:Valid until|Gyldig indtil|Gyldig til|Giltig till)\s+(.+?)(?:\s+(?:incl\.|Inkl\.)|\s+\d+(?:[.,]\d+)?\s*SEK)/iu,
    );
    if (!idMatch || !nameMatch) continue;
    cards.push({
      id: Number(idMatch[1]),
      name: htmlToText(nameMatch[1]),
      balance: Number(balanceMatch[1].replace(",", ".")),
      currency: "SEK",
      facility: facilityMatch ? htmlToText(facilityMatch[1]) : "",
      validUntil: validUntilMatch?.[1]?.trim() || "",
    });
  }
  return cards;
}

export function addMinutesToClock(startTime, durationMinutes) {
  const match = String(startTime || "").match(/^(\d{2}):(\d{2})$/);
  const duration = Number(durationMinutes);
  if (!match || !Number.isInteger(duration) || duration <= 0) {
    throw new MatchiError("无法计算预订结束时间");
  }
  const start = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[1]) > 23 || Number(match[2]) > 59 || start + duration > 24 * 60) {
    throw new MatchiError("预订时间超出同一自然日");
  }
  const end = start + duration;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

export function extractCancellationAnchors(html) {
  const anchors = [];
  for (const match of String(html).matchAll(/<a\b[\s\S]*?<\/a>/gi)) {
    const block = match[0];
    const href = decodeHtml(attributeValue(block, "href") || "");
    if (!href.includes("/user/booking/cancelConfirm?")) continue;
    anchors.push({ href, text: htmlToText(block) });
  }
  return anchors;
}

export function analyzeBookingDetail(html, expected) {
  const text = htmlToText(html);
  const lower = text.toLocaleLowerCase();
  const [, month, day] = String(expected.date || "").split("-");
  const endTime = addMinutesToClock(expected.startTime, Number(expected.durationMinutes));
  const dateHints = [
    `(${Number(day)}/${Number(month)})`,
    `(${day}/${month})`,
  ];
  const court = String(expected.court || "").trim();
  const courtCode = court.match(/\b[A-Z]+\s*0*\d+\b/i)?.[0]?.replace(/\s+/g, "") || "";
  const courtPattern = courtCode
    ? new RegExp(`(^|[^A-Z0-9])${escapeRegExp(courtCode)}([^A-Z0-9]|$)`, "i")
    : null;
  const compactText = text.replace(/\s+/g, " ");
  const checks = {
    facility: !expected.facilityName || lower.includes(String(expected.facilityName).toLocaleLowerCase()),
    date: dateHints.some((hint) => text.includes(hint)),
    time: new RegExp(`\\b${escapeRegExp(expected.startTime)}\\s*-\\s*${escapeRegExp(endTime)}\\b`).test(text),
    court: courtPattern ? courtPattern.test(compactText.replace(/\s+(?=\d)/g, "")) : lower.includes(court.toLocaleLowerCase()),
    payment: expected.requireValueCard !== true || /(?:payment\s+method\s*:\s*value\s+card|betalingsmetode\s*:\s*værdikort|betalningsmetod\s*:\s*värdekort)/iu.test(text),
  };
  return {
    matched: Object.values(checks).every(Boolean),
    checks,
    expectedEndTime: endTime,
  };
}

export function chooseSlots(slots, config) {
  const duration = Number(config.durationMinutes || 60);
  const quantity = Number(config.quantity || 1);
  const requested = (config.courtPreferences || []).map(normalizeCourt).filter(Boolean);
  const allCourts = [...new Set(slots.map((slot) => slot.court).filter(Boolean))];
  const orderedCourts = [
    ...requested,
    ...(config.allowAnyCourt ? allCourts.map(normalizeCourt).filter((court) => !requested.includes(court)) : []),
  ];

  const candidates = [];
  for (const normalizedCourt of orderedCourts) {
    const courtSlots = slots.filter((slot) => courtMatches(slot.court, normalizedCourt) && slot.state === "free");
    const chain = consecutiveChain(courtSlots, config.startTime, duration);
    if (chain) {
      candidates.push({ court: chain[0].court, slots: chain });
    }
  }
  if (candidates.length < quantity) return [];

  if (quantity > 1 && config.preferConsecutiveCourts !== false) {
    const consecutive = findConsecutiveCourtSelections(candidates, quantity);
    if (consecutive.length) return consecutive;
    if (config.allowNonConsecutiveCourts === false) return [];
  }
  return candidates.slice(0, quantity);
}

export function chooseReplacementSlots(slots, config, {
  excludeCourts = [],
  quantity = 1,
} = {}) {
  const excluded = excludeCourts.map(normalizeCourt).filter(Boolean);
  const remainingSlots = slots.filter((slot) => (
    !excluded.some((court) => courtMatches(slot.court, court) || courtMatches(court, slot.court))
  ));
  const requested = Math.max(1, Number(quantity));
  for (let candidateQuantity = requested; candidateQuantity >= 1; candidateQuantity -= 1) {
    const selected = chooseSlots(remainingSlots, {
      ...config,
      quantity: candidateQuantity,
      courtPreferences: [],
      allowAnyCourt: true,
      preferConsecutiveCourts: true,
      // Once part of a multi-court request has already succeeded, preserving the
      // requested quantity is more important than requiring one global number run.
      allowNonConsecutiveCourts: true,
    });
    if (selected.length) return selected;
  }
  return [];
}

export function computeReplacementAllowance({
  requiredQuantity,
  confirmedCount,
  uncertainCount,
  allowOverbooking = false,
  maxOverbookCourts = 0,
}) {
  const required = Math.max(1, Math.trunc(Number(requiredQuantity) || 1));
  const confirmed = Math.max(0, Math.trunc(Number(confirmedCount) || 0));
  const uncertain = Math.max(0, Math.trunc(Number(uncertainCount) || 0));
  const extra = allowOverbooking
    ? Math.max(0, Math.trunc(Number(maxOverbookCourts) || 0))
    : 0;
  const maximumPossibleCourts = required + extra;
  const currentPotentialCourts = confirmed + uncertain;
  const riskHeadroom = Math.max(0, maximumPossibleCourts - currentPotentialCourts);
  return {
    requiredQuantity: required,
    maximumPossibleCourts,
    currentPotentialCourts,
    riskHeadroom,
    replacementsAllowed: Math.min(Math.max(0, required - confirmed), riskHeadroom),
  };
}

export function analyzeTargetAvailability(slots, config, selections = chooseSlots(slots, config)) {
  const targetCells = slots.filter((slot) => slot.start === config.startTime && slot.canStart !== false);
  return {
    publishedCells: targetCells.length,
    freeCells: targetCells.filter((slot) => slot.state === "free").length,
    selectionCount: selections.length,
  };
}

export function computeTransientBackoffMs(
  status,
  failureCount,
  retryAfterValue = null,
  jitterMs = 0,
  randomFn = Math.random,
) {
  const count = Math.max(1, Math.trunc(Number(failureCount) || 1));
  const isRateLimit = Number(status) === 429;
  const baseMs = isRateLimit ? 5_000 : 1_000;
  const capMs = isRateLimit ? 30_000 : 10_000;
  const exponentialMs = Math.min(capMs, baseMs * (2 ** Math.min(count - 1, 5)));
  const retryAfterMs = parseRetryAfterMs(retryAfterValue);
  const baseDelayMs = Math.max(exponentialMs, retryAfterMs);
  const maximumJitterMs = Math.max(0, Math.trunc(Number(jitterMs) || 0));
  let addedJitterMs = 0;
  if (maximumJitterMs > 0) {
    const randomValue = Number(randomFn());
    const normalizedRandom = Number.isFinite(randomValue)
      ? Math.min(1, Math.max(0, randomValue))
      : 0;
    addedJitterMs = Math.floor(normalizedRandom * maximumJitterMs);
  }
  return Math.min(60_000, baseDelayMs + addedJitterMs);
}

export function computeReleaseRetryDelayMs({
  baseIntervalMs,
  burstIntervalMs = 250,
  burstSeconds = 3,
  releaseElapsedMs,
  scheduleIsOpen,
}) {
  const base = Number(baseIntervalMs);
  if (!scheduleIsOpen && releaseElapsedMs >= 0 && releaseElapsedMs <= Number(burstSeconds) * 1000) {
    return Math.min(base, Number(burstIntervalMs));
  }
  return base;
}

function parseRetryAfterMs(value) {
  if (value === null || value === undefined || String(value).trim() === "") return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const retryAt = Date.parse(String(value));
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
}

export function parseConfirmation(html) {
  const formMatch = html.match(/<form[^>]+id=["']confirmForm["'][^>]*>([\s\S]*?)<\/form>/i);
  const openingTag = formMatch ? formMatch[0].match(/^<form[^>]*>/i)?.[0] || "" : "";
  const formHtml = formMatch?.[1] || "";
  const fields = [];
  const paymentMethods = [];

  for (const match of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = decodeHtml(attributeValue(tag, "name") || "");
    if (!name) continue;
    const type = (attributeValue(tag, "type") || "text").toLowerCase();
    const value = decodeHtml(attributeValue(tag, "value") || "");
    if (type === "radio" && name === "method") paymentMethods.push(value);
    if (["checkbox", "radio"].includes(type) && !/\schecked(?:\s|=|>)/i.test(tag)) continue;
    if (type === "submit") continue;
    fields.push([name, value]);
  }

  const summary = htmlToText(html);
  // Require complete money tokens: B3 Euro Finans is a court name, not 3 EUR.
  const priceMatch = summary.match(/total price[^\d]*(\d+(?:[.,]\d+)?)\s*(SEK|DKK|NOK|EUR|GBP)\b/i)
    || summary.match(/(?<![\p{L}\p{N}_.,])(\d+(?:[.,]\d+)?)\s*(SEK|DKK|NOK|EUR|GBP)\b/iu);
  return {
    formAction: decodeHtml(attributeValue(openingTag, "action") || ""),
    fields,
    paymentMethods,
    price: priceMatch ? `${priceMatch[1]} ${priceMatch[2].toUpperCase()}` : null,
    summary: summary.slice(0, 1200),
    html,
  };
}

function parseTrailingSlotIds(html, firstSlotId) {
  for (const match of String(html).matchAll(/<select\b(?:(?:"[^"]*")|(?:'[^']*')|[^'">])*>/gi)) {
    const tag = match[0];
    const className = attributeValue(tag, "class") || "";
    if (!className.split(/\s+/).includes("trailingSlotSelector")) continue;
    if (decodeHtml(attributeValue(tag, "rel") || "") !== String(firstSlotId)) continue;
    const encoded = decodeHtml(attributeValue(tag, "data-slotids") || "");
    try {
      const slotIds = JSON.parse(encoded);
      return Array.isArray(slotIds) ? slotIds.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function validateValueCardModel(model, constraints = {}) {
  if (!model || typeof model !== "object") throw new MatchiError("结账模型为空；拒绝付款");
  const currency = String(model.price?.currency || "").toUpperCase();
  const expectedCurrency = String(constraints.currency || "SEK").toUpperCase();
  const total = parseMoney(model.amountToPay);
  const maxTotal = parseMoney(constraints.maxTotal);
  if (currency !== expectedCurrency) {
    throw new MatchiError(`币种为 ${currency || "未知"}，不是允许的 ${expectedCurrency}；拒绝付款`);
  }
  if (!Number.isFinite(total) || total <= 0) throw new MatchiError("无法确认正数结账总额；拒绝付款");
  if (!Number.isFinite(maxTotal) || maxTotal <= 0 || total > maxTotal) {
    throw new MatchiError(`结账总额 ${total.toFixed(2)} ${currency} 超过上限 ${constraints.maxTotal}；拒绝付款`);
  }
  if (Array.isArray(model.valueCardOutcomes) && model.valueCardOutcomes.length) {
    throw new MatchiError("结账已有 Value Card 抵扣记录；为避免重复扣款，拒绝继续");
  }

  const requestedId = Number(constraints.valueCardId);
  const cards = Array.isArray(model.valueCards) ? model.valueCards : [];
  const matches = cards.filter((item) => Number(item.id) === requestedId);
  if (!Number.isInteger(requestedId) || matches.length !== 1) {
    throw new MatchiError(`没有唯一匹配的 Value Card ${constraints.valueCardId}；拒绝付款`);
  }
  const card = matches[0];
  if (constraints.valueCardName && card.name !== constraints.valueCardName) {
    throw new MatchiError(`Value Card 名称不匹配（实际：${card.name || "未知"}）；拒绝付款`);
  }
  if (card.method !== "GIFT_CARD") {
    throw new MatchiError(`Value Card 方法为 ${card.method || "未知"}，不是 GIFT_CARD；拒绝付款`);
  }
  if (String(card.currency || "").toUpperCase() !== expectedCurrency) {
    throw new MatchiError("Value Card 币种与订单不一致；拒绝付款");
  }
  const balance = parseMoney(card.amount);
  const expectedCharge = parseMoney(constraints.expectedValueCardCharge);
  const requiredBalance = Number.isFinite(expectedCharge) && expectedCharge > 0 ? expectedCharge : total;
  if (!Number.isFinite(balance) || balance < requiredBalance) {
    throw new MatchiError(`Value Card 余额 ${card.amount || "未知"} 不足以全额支付 ${requiredBalance.toFixed(2)}；拒绝使用银行卡补差额`);
  }
  return { card, total, currency, constraints };
}

export function validateAppliedValueCardModel(model, constraints = {}) {
  const amountToPay = parseMoney(model?.amountToPay);
  if (amountToPay !== 0) {
    throw new MatchiError(`Value Card 抵扣后仍需支付 ${model?.amountToPay ?? "未知"}；拒绝使用银行卡补差额`);
  }
  const outcomes = Array.isArray(model?.valueCardOutcomes) ? model.valueCardOutcomes : [];
  if (outcomes.length !== 1 || Number(outcomes[0]?.valueCard?.id) !== Number(constraints.valueCardId)) {
    throw new MatchiError("Value Card 抵扣结果不唯一或卡片 ID 不匹配；拒绝确认订单");
  }
  const amount = parseMoney(outcomes[0].amount);
  const expectedAmount = parseMoney(constraints.expectedAmount);
  if (!Number.isFinite(amount) || amount !== expectedAmount) {
    throw new MatchiError(`Value Card 抵扣金额 ${outcomes[0]?.amount ?? "未知"} 与锁定场地价不一致；拒绝确认订单`);
  }
  const priceAfterValueCard = parseMoney(model?.price?.amount);
  if (priceAfterValueCard !== 0) {
    throw new MatchiError(`Value Card 应用后结账价格仍为 ${model?.price?.amount ?? "未知"}；拒绝确认订单`);
  }
  const maxCharge = parseMoney(constraints.maxValueCardCharge);
  if (!Number.isFinite(maxCharge) || amount > maxCharge) {
    throw new MatchiError(`Value Card 实际扣款 ${amount.toFixed(2)} 超过上限 ${constraints.maxValueCardCharge}；拒绝确认订单`);
  }
  const currency = String(model.price?.currency || constraints.currency || "").toUpperCase();
  const expectedCurrency = String(constraints.currency || "SEK").toUpperCase();
  if (currency !== expectedCurrency) {
    throw new MatchiError(`Value Card 应用后的币种为 ${currency || "未知"}，不是 ${expectedCurrency}；拒绝确认订单`);
  }
  return { amount, currency };
}

export function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

export function computePossibleBalances(balanceBefore, charges = []) {
  const startingCents = Math.round(Number(balanceBefore) * 100);
  if (!Number.isFinite(startingCents)) return [];
  let possibleChargeCents = new Set([0]);
  for (const charge of charges) {
    const cents = Math.round(Number(charge) * 100);
    if (!Number.isFinite(cents) || cents < 0) return [];
    const next = new Set(possibleChargeCents);
    for (const current of possibleChargeCents) next.add(current + cents);
    possibleChargeCents = next;
  }
  return [...possibleChargeCents]
    .map((chargedCents) => (startingCents - chargedCents) / 100)
    .sort((a, b) => b - a);
}

export function computeReleaseInstant(targetDate, advanceDays, timeZone = "Europe/Stockholm") {
  if (!isValidIsoDate(targetDate)) throw new MatchiError("targetDate 必须是真实有效的 YYYY-MM-DD 日期");
  if (!Number.isInteger(Number(advanceDays)) || Number(advanceDays) < 1) {
    throw new MatchiError("advanceDays 必须是正整数");
  }
  assertTimeZone(timeZone);
  const [year, month, day] = targetDate.split("-").map(Number);
  const releaseDateUtc = new Date(Date.UTC(year, month - 1, day));
  releaseDateUtc.setUTCDate(releaseDateUtc.getUTCDate() - Number(advanceDays));
  const releaseParts = {
    year: releaseDateUtc.getUTCFullYear(),
    month: releaseDateUtc.getUTCMonth() + 1,
    day: releaseDateUtc.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
  return zonedTimeToDate(releaseParts, timeZone);
}

export function computeTargetStartInstant(targetDate, startTime, timeZone = "Europe/Stockholm") {
  if (!isValidIsoDate(targetDate)) throw new MatchiError("targetDate 必须是真实有效的 YYYY-MM-DD 日期");
  if (!/^(?:[01]\d|2[0-3]):00$/.test(startTime)) throw new MatchiError("startTime 必须是整点 HH:00");
  assertTimeZone(timeZone);
  const [year, month, day] = targetDate.split("-").map(Number);
  const [hour, minute] = startTime.split(":").map(Number);
  return zonedTimeToDate({ year, month, day, hour, minute, second: 0 }, timeZone);
}

export function validateConfig(config) {
  const errors = [];
  if (!config.facilitySlug) errors.push("facilitySlug 不能为空");
  if (!Number.isInteger(Number(config.facilityId))) errors.push("facilityId 必须是整数");
  if (!Number.isInteger(Number(config.sportId))) errors.push("sportId 必须是整数");
  if (!isValidIsoDate(config.targetDate)) errors.push("targetDate 必须是真实有效的 YYYY-MM-DD 日期");
  if (!/^(?:[01]\d|2[0-3]):00$/.test(config.startTime || "")) errors.push("startTime 必须是整点 HH:00");
  if (![60, 120, 180].includes(Number(config.durationMinutes))) errors.push("durationMinutes 只能是 60、120 或 180");
  const quantity = Number(config.quantity || 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 6) errors.push("quantity 必须是 1 到 6 的整数");
  if (Array.isArray(config.courtPreferences) === false && config.courtPreferences !== undefined) {
    errors.push("courtPreferences 必须是数组");
  }
  const pollInterval = Number(config.pollIntervalMs);
  if (!Number.isFinite(pollInterval) || pollInterval < 1000) errors.push("pollIntervalMs 不能低于 1000ms");
  if (config.releaseAt === null || config.releaseAt === undefined || config.releaseAt === "") {
    if (!Number.isInteger(Number(config.advanceDays)) || Number(config.advanceDays) < 1) {
      errors.push("自动计算放票时间时 advanceDays 必须是正整数");
    }
  }
  try {
    assertTimeZone(config.timeZone || "Europe/Stockholm");
  } catch (error) {
    errors.push(error.message);
  }
  if (config.pollTimeoutSeconds !== undefined) {
    const timeout = Number(config.pollTimeoutSeconds);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600) {
      errors.push("pollTimeoutSeconds 必须在 1 到 3600 秒之间");
    }
  }
  if (config.loginLeadSeconds !== undefined) {
    const lead = Number(config.loginLeadSeconds);
    if (!Number.isFinite(lead) || lead < 0 || lead > 3600) {
      errors.push("loginLeadSeconds 必须在 0 到 3600 秒之间");
    }
  }
  if (/^(?:[01]\d|2[0-3]):00$/.test(config.startTime || "")
      && [60, 120, 180].includes(Number(config.durationMinutes))) {
    const startMinutes = Number(config.startTime.slice(0, 2)) * 60;
    if (startMinutes + Number(config.durationMinutes) > 24 * 60) {
      errors.push("开始时间加预订时长不能跨越午夜");
    }
  }
  if (config.dailyBookingLimitMinutes !== undefined) {
    const dailyLimit = Number(config.dailyBookingLimitMinutes);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 60) {
      errors.push("dailyBookingLimitMinutes 必须是至少 60 的整数");
    } else if (quantity * Number(config.durationMinutes) > dailyLimit) {
      errors.push(`目标场地总分钟数超过场馆每日上限 ${dailyLimit}`);
    }
  }
  if (config.releaseBurstIntervalMs !== undefined) {
    const burstInterval = Number(config.releaseBurstIntervalMs);
    if (!Number.isFinite(burstInterval) || burstInterval < 200 || burstInterval > 1000) {
      errors.push("releaseBurstIntervalMs 必须在 200 到 1000ms 之间");
    }
  }
  if (config.releaseBurstSeconds !== undefined) {
    const burstSeconds = Number(config.releaseBurstSeconds);
    if (!Number.isFinite(burstSeconds) || burstSeconds < 0 || burstSeconds > 10) {
      errors.push("releaseBurstSeconds 必须在 0 到 10 秒之间");
    }
  }
  if (config.prewarmLeadSeconds !== undefined) {
    const prewarmLead = Number(config.prewarmLeadSeconds);
    if (!Number.isFinite(prewarmLead) || prewarmLead < 0 || prewarmLead > 30) {
      errors.push("prewarmLeadSeconds 必须在 0 到 30 秒之间");
    }
  }
  if (config.retryJitterMs !== undefined) {
    const retryJitter = Number(config.retryJitterMs);
    if (!Number.isFinite(retryJitter) || retryJitter < 0 || retryJitter > 1_000) {
      errors.push("retryJitterMs 必须在 0 到 1000ms 之间");
    }
  }
  if (config.unavailableTargetGraceSeconds !== undefined) {
    const grace = Number(config.unavailableTargetGraceSeconds);
    if (!Number.isFinite(grace) || grace < 0 || grace > 300) {
      errors.push("unavailableTargetGraceSeconds 必须在 0 到 300 秒之间");
    }
  }
  if (config.replacementTimeoutSeconds !== undefined) {
    const timeout = Number(config.replacementTimeoutSeconds);
    if (!Number.isFinite(timeout) || timeout < 5 || timeout > 120) {
      errors.push("replacementTimeoutSeconds 必须在 5 到 120 秒之间");
    }
  }
  if (config.replacementPollIntervalMs !== undefined) {
    const interval = Number(config.replacementPollIntervalMs);
    if (!Number.isFinite(interval) || interval < 500 || interval > 5_000) {
      errors.push("replacementPollIntervalMs 必须在 500 到 5000ms 之间");
    }
  }
  if (config.replacementMaxRounds !== undefined) {
    const rounds = Number(config.replacementMaxRounds);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) {
      errors.push("replacementMaxRounds 必须是 1 到 50 的整数");
    }
  }
  if (config.maxOverbookCourts !== undefined) {
    const extra = Number(config.maxOverbookCourts);
    if (!Number.isInteger(extra) || extra < 0 || extra > 6) {
      errors.push("maxOverbookCourts 必须是 0 到 6 的整数");
    }
    if (config.allowOverbookingOnUncertain === true && extra < 1) {
      errors.push("允许超订时 maxOverbookCourts 必须至少为 1");
    }
  }
  if (config.allowOverbookingOnUncertain === true && config.maxOverbookCourts === undefined) {
    errors.push("允许超订时必须设置 maxOverbookCourts");
  }
  if (!["dry-run", "confirm", "checkout", "value-card"].includes(config.mode || "dry-run")) {
    errors.push("mode 只能是 dry-run、confirm、checkout 或 value-card");
  }
  if (config.mode === "value-card") {
    if (!Number.isInteger(Number(config.valueCardId))) errors.push("value-card 模式需要整数 valueCardId");
    if (!config.valueCardName) errors.push("value-card 模式需要 valueCardName");
    if (!Number.isFinite(Number(config.maxTotalSek)) || !(Number(config.maxTotalSek) > 0)) errors.push("value-card 模式需要正数 maxTotalSek");
    if (!Number.isFinite(Number(config.maxValueCardChargeSek)) || !(Number(config.maxValueCardChargeSek) > 0)) errors.push("value-card 模式需要正数 maxValueCardChargeSek");
    if (!Number.isFinite(Number(config.minimumLeadHours)) || !(Number(config.minimumLeadHours) > 0)) errors.push("value-card 模式需要正数 minimumLeadHours");
    if (!config.transactionId || typeof config.transactionId !== "string") errors.push("value-card 模式需要 transactionId");
    if (!config.requiredTargetDate || config.requiredTargetDate !== config.targetDate) {
      errors.push("value-card 模式的 requiredTargetDate 必须与 targetDate 完全一致");
    }
    if (!config.requiredStartTime || config.requiredStartTime !== config.startTime) {
      errors.push("value-card 模式的 requiredStartTime 必须与 startTime 完全一致");
    }
    if (Number(config.requiredQuantity) !== Number(config.quantity)) {
      errors.push("value-card 模式的 requiredQuantity 必须与 quantity 完全一致");
    }
    if (Number(config.requiredDurationMinutes) !== Number(config.durationMinutes)) {
      errors.push("value-card 模式的 requiredDurationMinutes 必须与 durationMinutes 完全一致");
    }
    if (!config.stateFile) errors.push("value-card 模式需要 stateFile 作为单次交易锁");
  }
  if (errors.length) throw new MatchiError(`配置错误：\n- ${errors.join("\n- ")}`);
}

export function htmlToText(html) {
  return decodeHtml(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeHtml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ");
}

function attributeValue(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyBookingFailure(status, summary = "") {
  const text = String(summary || "");
  if (/venue'?s rules|maximum\s+\d+|may not complete this booking/i.test(text)) {
    return "BOOKING_RULE_LIMIT";
  }
  if (
    [409, 410, 422].includes(Number(status))
    || /(?:slot|time|court).{0,60}(?:no longer available|unavailable|already (?:booked|reserved)|has been taken)/i.test(text)
    || /(?:no longer available|unavailable|already (?:booked|reserved)|has been taken).{0,60}(?:slot|time|court)?/i.test(text)
  ) {
    return "SLOT_CONFLICT";
  }
  return "CONFIRMATION_HTTP";
}

function consecutiveChain(slots, startTime, durationMinutes) {
  let cursor = startTime;
  let total = 0;
  const chain = [];
  while (total < durationMinutes) {
    const slot = slots.find((item) => item.start === cursor && (chain.length > 0 || item.canStart));
    if (!slot || !slot.end || slot.durationMinutes <= 0) return null;
    chain.push(slot);
    total += slot.durationMinutes;
    cursor = slot.end;
  }
  return total === durationMinutes ? chain : null;
}

function normalizeCourt(value) {
  return String(value || "").trim().toLocaleUpperCase();
}

function courtMatches(actual, requested) {
  const normalizedActual = normalizeCourt(actual);
  const normalizedRequested = normalizeCourt(requested);
  return normalizedActual === normalizedRequested || normalizedActual.startsWith(`${normalizedRequested} `);
}

function findConsecutiveCourtSelections(candidates, quantity) {
  const parsed = candidates.map((selection, index) => {
    const match = normalizeCourt(selection.court).match(/^([A-Z]+)\s*0*(\d+)(?:\D|$)/);
    return match
      ? { selection, index, prefix: match[1], number: Number(match[2]) }
      : null;
  }).filter(Boolean);

  for (const start of parsed) {
    const group = [];
    for (let offset = 0; offset < quantity; offset += 1) {
      const match = parsed.find((item) => (
        item.prefix === start.prefix && item.number === start.number + offset
      ));
      if (!match) break;
      group.push(match.selection);
    }
    if (group.length === quantity) return group;
  }
  return [];
}

function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const toMinutes = (value) => {
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
  };
  return toMinutes(end) - toMinutes(start);
}

function roundElapsed(startedAt) {
  return Number((performance.now() - startedAt).toFixed(1));
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day;
}

function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new MatchiError(`timeZone 无效：${timeZone || "空"}`);
  }
}

function zonedTimeToDate(parts, timeZone) {
  const desiredUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = desiredUtc;
  for (let index = 0; index < 3; index += 1) {
    const shown = partsInZone(new Date(guess), timeZone);
    const shownUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    guess += desiredUtc - shownUtc;
  }
  return new Date(guess);
}

function partsInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const mapped = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return Object.fromEntries(["year", "month", "day", "hour", "minute", "second"].map((key) => [key, Number(mapped[key])]));
}

function extractPaymentUrl(html) {
  const candidates = [
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/i,
    /url\s*:\s*["'](https?:\/\/[^"']+)["']/i,
  ];
  for (const pattern of candidates) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return null;
}

function extractHostedCheckoutUrl(html) {
  const match = String(html).match(/<a[^>]+id=["']checkout["'][^>]+href=["']([^"']+)["']/i)
    || String(html).match(/https:\/\/checkout\.matchi\.com\/pay\/[^"'\s<]+/i);
  const raw = match?.[1] || match?.[0];
  return raw ? decodeHtml(raw) : null;
}

function modelOrderId(result) {
  return result && typeof result === "object" ? result.orderId ?? result.id ?? null : null;
}

function splitSetCookieHeader(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/g);
}

function defaultCookiePath(pathname) {
  if (!pathname || !pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function cookieMatches(cookie, url) {
  const host = url.hostname.toLowerCase();
  const domainMatches = cookie.hostOnly ? host === cookie.domain : host === cookie.domain || host.endsWith(`.${cookie.domain}`);
  const pathMatches = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`);
  return domainMatches && pathMatches && (!cookie.secure || url.protocol === "https:");
}
