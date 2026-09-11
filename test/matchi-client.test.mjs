import test from "node:test";
import assert from "node:assert/strict";
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
  parseConfirmation,
  parseProfileValueCards,
  parseScheduleContext,
  parseScheduleNotice,
  parseScheduleSlots,
  validateAppliedValueCardModel,
  validateConfig,
  validateValueCardModel,
} from "../src/matchi-client.mjs";

test("computes only discrete balances for uncertain concurrent charges", () => {
  assert.deepEqual(computePossibleBalances(840, [70, 210]), [840, 770, 630, 560]);
  assert.deepEqual(computePossibleBalances(840, [70, 70]), [840, 770, 700]);
  assert.deepEqual(computePossibleBalances(Number.NaN, [70]), []);
});

test("locks schedule HTML to the requested date, facility, and sport context", () => {
  const html = `
    <input name="fromDate" value="2026-09-11">
    <ul><li class="active"><a href="/booking/schedule?facilityId=2560&sport=2">Badminton</a></li></ul>`;
  assert.deepEqual(parseScheduleContext(html), {
    date: "2026-09-11",
    facilityId: 2560,
    sportId: 2,
  });
  assert.deepEqual(parseScheduleContext("<p>partial response</p>"), {
    date: null,
    facilityId: null,
    sportId: null,
  });
});

test("rejects minute-level, impossible, cross-midnight, and over-limit targets", () => {
  const base = {
    facilitySlug: "atl",
    facilityId: 2560,
    sportId: 2,
    targetDate: "2026-09-11",
    startTime: "07:00",
    durationMinutes: 60,
    quantity: 4,
    courtPreferences: [],
    pollIntervalMs: 1000,
    releaseAt: "2026-08-28T00:00:00+02:00",
    timeZone: "Europe/Stockholm",
    dailyBookingLimitMinutes: 600,
    mode: "dry-run",
  };
  assert.doesNotThrow(() => validateConfig(base));
  assert.throws(() => validateConfig({ ...base, startTime: "07:30" }), /整点/);
  assert.throws(() => validateConfig({ ...base, targetDate: "2026-02-31" }), /真实有效/);
  assert.throws(() => validateConfig({ ...base, startTime: "23:00", durationMinutes: 120 }), /跨越午夜/);
  assert.throws(() => validateConfig({ ...base, quantity: 6, durationMinutes: 120 }), /每日上限/);
});

test("detects an authenticated request redirected back to login", async () => {
  const client = new MatchiClient();
  client.authenticated = true;
  client.request = async () => ({
    response: new Response("login", { status: 200 }),
    url: "https://auth.matchi.com/realms/matchi/login-actions/authenticate",
  });
  await assert.rejects(() => client.text("/profile/home"), (error) => error?.details?.code === "AUTH_EXPIRED");
});

test("lists monetary Value Cards with IDs and ignores punch cards", () => {
  const html = `
    <li class="list-group-item"><a href="/profile/showOfferHistory/1435780"><span>2</span></a>
      <span>Punches left</span><h4>Klippkort</h4></li>
    <li class="list-group-item"><a href="/profile/showOfferHistory/900001"><span>75.00</span></a>
      <span>SEK left</span><h4>Example Value Card</h4>
      <a class="coupon-facility-name">ATL Victoriastadion</a><span>Valid until 20 September 2030 incl.</span></li>
    <li class="list-group-item"><a href="/profile/showOfferHistory/900002"><span>2200.00</span></a>
      <span>SEK left</span><h4>Example Value Card</h4>
      <a class="coupon-facility-name">ATL Victoriastadion</a><span>Valid until 21 July 2030 incl.</span></li>`;
  assert.deepEqual(parseProfileValueCards(html), [
    { id: 900001, name: "Example Value Card", balance: 75, currency: "SEK", facility: "ATL Victoriastadion", validUntil: "20 September 2030" },
    { id: 900002, name: "Example Value Card", balance: 2200, currency: "SEK", facility: "ATL Victoriastadion", validUntil: "21 July 2030" },
  ]);
});

test("parses Danish and Swedish Value Card account labels", () => {
  const danish = `
    <li class="list-group-item"><a href="/profile/showOfferHistory/900002">
      <span class="block h3">840.00</span></a><span class="block">SEK tilbage</span>
      <h4>Example Value Card</h4><a class="coupon-facility-name">ATL Victoriastadion</a>
      <span>Gyldig indtil 21 juli 2028 Inkl.</span></li>`;
  assert.deepEqual(parseProfileValueCards(danish), [{
    id: 900002,
    name: "Example Value Card",
    balance: 840,
    currency: "SEK",
    facility: "ATL Victoriastadion",
    validUntil: "21 juli 2028",
  }]);
  const swedish = danish.replace("SEK tilbage", "SEK kvar").replace("Gyldig indtil", "Giltig till");
  assert.equal(parseProfileValueCards(swedish)[0].balance, 840);
});

test("accepts localized Value Card labels in exact booking verification", () => {
  const base = `<h3>B1</h3><p>ATL Victoriastadion</p><p>Onsdag (9/9)</p><p>07:00-08:00</p>`;
  for (const label of ["Payment method: Value card", "Betalingsmetode: Værdikort", "Betalningsmetod: Värdekort"]) {
    assert.equal(analyzeBookingDetail(`${base}<p>${label}</p>`, {
      facilityName: "ATL Victoriastadion",
      date: "2026-09-09",
      startTime: "07:00",
      durationMinutes: 60,
      court: "B1",
      requireValueCard: true,
    }).matched, true);
  }
});

test("extracts cancellation links and verifies the exact end time and Value Card method", () => {
  const profile = `
    <a href="/user/booking/cancelConfirm?slotId=abc&amp;returnUrl=%2Fprofile%2Fhome">
      ATL Victoriastadion 11/09 18:00 B2
    </a>`;
  assert.deepEqual(extractCancellationAnchors(profile), [{
    href: "/user/booking/cancelConfirm?slotId=abc&returnUrl=%2Fprofile%2Fhome",
    text: "ATL Victoriastadion 11/09 18:00 B2",
  }]);

  const exact = `
    <h3>Booking B2</h3><p>ATL Victoriastadion</p>
    <p>Date : Friday (11/9)</p><p>Time : 18:00-20:00</p>
    <p>Payment method: Value card</p>`;
  assert.deepEqual(analyzeBookingDetail(exact, {
    facilityName: "ATL Victoriastadion",
    date: "2026-09-11",
    startTime: "18:00",
    durationMinutes: 120,
    court: "B2",
    requireValueCard: true,
  }), {
    matched: true,
    checks: { facility: true, date: true, time: true, court: true, payment: true },
    expectedEndTime: "20:00",
  });

  assert.equal(analyzeBookingDetail(exact, {
    facilityName: "ATL Victoriastadion",
    date: "2026-09-11",
    startTime: "18:00",
    durationMinutes: 60,
    court: "B2",
    requireValueCard: true,
  }).matched, false);
  assert.equal(analyzeBookingDetail(exact.replace("B2", "B20"), {
    facilityName: "ATL Victoriastadion",
    date: "2026-09-11",
    startTime: "18:00",
    durationMinutes: 120,
    court: "B2",
    requireValueCard: true,
  }).matched, false);
  assert.equal(addMinutesToClock("18:00", 180), "21:00");
});

test("marks a vanished confirmation slot as a safe pre-payment conflict", async () => {
  const client = new MatchiClient();
  client.authenticated = true;
  client.text = async () => ({
    response: new Response("<p>This slot is no longer available</p>", { status: 200 }),
    html: "<p>This slot is no longer available</p>",
    url: "https://www.matchi.se/bookingPayment/confirm",
  });
  await assert.rejects(
    () => client.getConfirmation({ facilityId: 2560, slotIds: ["lost-slot"], refererSlug: "atl" }),
    (error) => error?.details?.code === "SLOT_CONFLICT",
  );
});

test("extends a long booking through MATCHi's duration model before checkout", async () => {
  const client = new MatchiClient();
  client.authenticated = true;
  const calls = [];
  client.text = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("updateConfirmModalModel")) {
      const model = {
        prices: { "slot-18": 170, "slot-19": 170 },
        totalPrice: 340,
        nPrices: 2,
        methods: [{ name: "CHECKOUT_SESSION" }],
        bookTrainerModel: { slotsAreConsecutive: true, slotsAreSameCourt: true },
      };
      return {
        response: new Response(JSON.stringify(model), { status: 200 }),
        html: JSON.stringify(model),
        url: String(url),
      };
    }
    const html = `
      <form action="/bookingPayment/payEntryPoint" method="post" id="confirmForm">
        <input type="hidden" name="slotIds" value="slot-18" />
        <input type="hidden" name="facilityId" value="2560" />
        <input type="radio" name="method" value="CHECKOUT_SESSION" />
      </form>
      <select class="trailingSlotSelector" rel="slot-18"
        data-slotids="[&quot;slot-18&quot;,&quot;slot-19&quot;,&quot;slot-20&quot;]">
      </select>
      <p>The total price for this booking will be 170 SEK.</p>`;
    return {
      response: new Response(html, { status: 200 }),
      html,
      url: String(url),
    };
  };

  const confirmation = await client.getConfirmation({
    facilityId: 2560,
    slotIds: ["slot-18", "slot-19"],
    refererSlug: "atl",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body, "slotIds=slot-18&facilityId=2560");
  const durationUrl = new URL(calls[1].url);
  assert.equal(durationUrl.searchParams.get("slotIds"), "slot-18,slot-19");
  assert.equal(durationUrl.searchParams.get("firstSlotIds"), "slot-18");
  assert.equal(confirmation.price, "340 SEK");
  assert.deepEqual(confirmation.fields.slice(0, 2), [
    ["slotIds", "slot-18,slot-19"],
    ["facilityId", "2560"],
  ]);
  assert.deepEqual(confirmation.extendedSlotIds, ["slot-18", "slot-19"]);
});

test("extends a three-hour booking with exactly three consecutive prices", async () => {
  const client = new MatchiClient();
  client.authenticated = true;
  client.text = async (url) => {
    if (String(url).includes("updateConfirmModalModel")) {
      const model = {
        prices: { "slot-18": 170, "slot-19": 170, "slot-20": 170 },
        totalPrice: 510,
        nPrices: 3,
        methods: [{ name: "CHECKOUT_SESSION" }],
        bookTrainerModel: { slotsAreConsecutive: true, slotsAreSameCourt: true },
      };
      return { response: new Response(JSON.stringify(model), { status: 200 }), html: JSON.stringify(model), url };
    }
    const html = `
      <form action="/bookingPayment/payEntryPoint" method="post" id="confirmForm">
        <input type="hidden" name="slotIds" value="slot-18" />
        <input type="hidden" name="facilityId" value="2560" />
        <input type="radio" name="method" value="CHECKOUT_SESSION" />
      </form>
      <select class="trailingSlotSelector" rel="slot-18"
        data-slotids="[&quot;slot-18&quot;,&quot;slot-19&quot;,&quot;slot-20&quot;]">
      </select>
      <p>The total price for this booking will be 170 SEK.</p>`;
    return { response: new Response(html, { status: 200 }), html, url };
  };
  const confirmation = await client.getConfirmation({
    facilityId: 2560,
    slotIds: ["slot-18", "slot-19", "slot-20"],
    refererSlug: "atl",
  });
  assert.equal(confirmation.price, "510 SEK");
  assert.deepEqual(confirmation.extendedSlotIds, ["slot-18", "slot-19", "slot-20"]);
});

test("does not misclassify a venue daily-limit response as a replaceable slot conflict", async () => {
  const client = new MatchiClient();
  client.authenticated = true;
  client.text = async (url) => {
    if (String(url).includes("updateConfirmModalModel")) {
      const html = "You may not complete this booking in accordance with the venue's rules. Each customer is allowed a maximum 600 of ordinary bookings per day.";
      return { response: new Response(html, { status: 405 }), html, url };
    }
    const html = `
      <form action="/bookingPayment/payEntryPoint" method="post" id="confirmForm">
        <input type="hidden" name="slotIds" value="slot-18" />
        <input type="radio" name="method" value="CHECKOUT_SESSION" />
      </form>
      <select class="trailingSlotSelector" rel="slot-18"
        data-slotids="[&quot;slot-18&quot;,&quot;slot-19&quot;,&quot;slot-20&quot;]"></select>
      <p>The total price for this booking will be 170 SEK.</p>`;
    return { response: new Response(html, { status: 200 }), html, url };
  };
  await assert.rejects(
    () => client.getConfirmation({
      facilityId: 2560,
      slotIds: ["slot-18", "slot-19", "slot-20"],
      refererSlug: "atl",
    }),
    (error) => error?.details?.code === "BOOKING_RULE_LIMIT",
  );
});

test("recognizes a published target whose courts are all occupied", () => {
  const slots = [
    { id: "b3", state: "booked", court: "B3 Euro Finans", start: "07:00", end: "08:00", canStart: true },
    { id: "b4", state: "booked", court: "B4 Euro Finans", start: "07:00", end: "08:00", canStart: true },
    { id: "b1", state: "free", court: "B1", start: "08:00", end: "09:00", canStart: true },
  ];
  const result = analyzeTargetAvailability(slots, {
    startTime: "07:00",
    durationMinutes: 60,
    quantity: 1,
    courtPreferences: [],
    allowAnyCourt: true,
  });
  assert.deepEqual(result, { publishedCells: 2, freeCells: 0, selectionCount: 0 });
});

test("distinguishes a target that has not been published", () => {
  const result = analyzeTargetAvailability([], {
    startTime: "07:00",
    durationMinutes: 60,
    quantity: 1,
    courtPreferences: [],
    allowAnyCourt: true,
  });
  assert.deepEqual(result, { publishedCells: 0, freeCells: 0, selectionCount: 0 });
});

test("backs off progressively after rate limits and honors Retry-After", () => {
  assert.equal(computeTransientBackoffMs(429, 1), 5_000);
  assert.equal(computeTransientBackoffMs(429, 3), 20_000);
  assert.equal(computeTransientBackoffMs(429, 1, "12"), 12_000);
  assert.equal(computeTransientBackoffMs(503, 3), 4_000);
  assert.equal(computeTransientBackoffMs(503, 1, null, 250, () => 0), 1_000);
  assert.equal(computeTransientBackoffMs(503, 1, null, 250, () => 1), 1_250);
  assert.equal(computeTransientBackoffMs(429, 1, "12", 250, () => 1), 12_250);
});

test("uses a short bounded retry only while the just-released calendar is still closed", () => {
  assert.equal(computeReleaseRetryDelayMs({
    baseIntervalMs: 1000,
    burstIntervalMs: 250,
    burstSeconds: 3,
    releaseElapsedMs: 800,
    scheduleIsOpen: false,
  }), 250);
  assert.equal(computeReleaseRetryDelayMs({
    baseIntervalMs: 1000,
    burstIntervalMs: 250,
    burstSeconds: 3,
    releaseElapsedMs: 3100,
    scheduleIsOpen: false,
  }), 1000);
  assert.equal(computeReleaseRetryDelayMs({
    baseIntervalMs: 1000,
    burstIntervalMs: 250,
    burstSeconds: 3,
    releaseElapsedMs: 800,
    scheduleIsOpen: true,
  }), 1000);
});

test("parses MATCHi desktop schedule cells", () => {
  const html = `
    <td slotid="slot-1" class="slot free" data-slot-duration="60" data-slot-min-duration="60"
        data-slot-can-start="true" title="Available<br>B7<br> 18:00 - 19:00"></td>
    <td slotid="slot-2" class="slot red" data-slot-duration="60"
        title="Booked<br> B8<br> 18:00 - 19:00"></td>`;
  const slots = parseScheduleSlots(html);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots[0], {
    id: "slot-1",
    state: "free",
    court: "B7",
    start: "18:00",
    end: "19:00",
    durationMinutes: 60,
    minimumDurationMinutes: 60,
    canStart: true,
  });
  assert.equal(slots[1].state, "booked");
});

test("does not lose the first slot inside MATCHi's nested court table", () => {
  const html = `
    <td colspan="16"><table><tr>
      <td slotid="b1-07" class="slot free" data-slot-duration="60" data-slot-can-start="true"
          title="Available<br>B1<br> 07:00 - 08:00"></td>
      <td slotid="b1-08" class="slot free" data-slot-duration="60" data-slot-can-start="true"
          title="Available<br>B1<br> 08:00 - 09:00"></td>
    </tr></table></td>`;
  const slots = parseScheduleSlots(html);
  assert.deepEqual(slots.map((slot) => [slot.id, slot.court, slot.start]), [
    ["b1-07", "B1", "07:00"],
    ["b1-08", "B1", "08:00"],
  ]);
});

test("chooses preferred court and consecutive duration", () => {
  const slots = [
    { id: "b7-18", state: "free", court: "B7", start: "18:00", end: "19:00", durationMinutes: 60, canStart: true },
    { id: "b7-19", state: "free", court: "B7", start: "19:00", end: "20:00", durationMinutes: 60, canStart: true },
    { id: "b8-18", state: "free", court: "B8", start: "18:00", end: "19:00", durationMinutes: 60, canStart: true },
  ];
  const selections = chooseSlots(slots, {
    startTime: "18:00",
    durationMinutes: 120,
    quantity: 1,
    courtPreferences: ["B8", "B7"],
    allowAnyCourt: false,
  });
  assert.equal(selections[0].court, "B7");
  assert.deepEqual(selections[0].slots.map((slot) => slot.id), ["b7-18", "b7-19"]);
});

test("matches a short court name to a sponsored display name", () => {
  const slots = [
    { id: "b3-18", state: "free", court: "B3 Euro Finans", start: "18:00", end: "19:00", durationMinutes: 60, canStart: true },
  ];
  const selections = chooseSlots(slots, {
    startTime: "18:00",
    durationMinutes: 60,
    quantity: 1,
    courtPreferences: ["B3"],
    allowAnyCourt: false,
  });
  assert.equal(selections[0].court, "B3 Euro Finans");
});

test("prefers consecutively numbered courts for multi-court booking", () => {
  const slots = [
    { id: "b1", state: "free", court: "B1", start: "18:00", end: "19:00", durationMinutes: 60, canStart: true },
    { id: "b3", state: "free", court: "B3 Euro Finans", start: "18:00", end: "19:00", durationMinutes: 60, canStart: true },
    { id: "b4", state: "free", court: "B4", start: "18:00", end: "19:00", durationMinutes: 60, canStart: true },
  ];
  const selections = chooseSlots(slots, {
    startTime: "18:00",
    durationMinutes: 60,
    quantity: 2,
    courtPreferences: [],
    allowAnyCourt: true,
    preferConsecutiveCourts: true,
    allowNonConsecutiveCourts: true,
  });
  assert.deepEqual(selections.map((selection) => selection.court), ["B3 Euro Finans", "B4"]);
});

test("can require consecutive courts and reject a scattered fallback", () => {
  const slots = [
    { id: "b1", state: "free", court: "B1", start: "18:00", end: "19:00", durationMinutes: 60, canStart: true },
    { id: "b3", state: "free", court: "B3", start: "18:00", end: "19:00", durationMinutes: 60, canStart: true },
  ];
  const selections = chooseSlots(slots, {
    startTime: "18:00",
    durationMinutes: 60,
    quantity: 2,
    courtPreferences: [],
    allowAnyCourt: true,
    preferConsecutiveCourts: true,
    allowNonConsecutiveCourts: false,
  });
  assert.deepEqual(selections, []);
});

test("selects the longest useful consecutive group for the real 07:00 pattern", () => {
  const freeCourts = ["B1", "B2", "B5", "B6", "B9", "B10", "B11", "B12"];
  const slots = freeCourts.map((court) => ({
    id: court.toLowerCase(),
    state: "free",
    court,
    start: "07:00",
    end: "08:00",
    durationMinutes: 60,
    canStart: true,
  }));
  const common = {
    startTime: "07:00",
    durationMinutes: 60,
    courtPreferences: [],
    allowAnyCourt: true,
    preferConsecutiveCourts: true,
    allowNonConsecutiveCourts: true,
  };
  assert.deepEqual(chooseSlots(slots, { ...common, quantity: 3 }).map((item) => item.court), ["B9", "B10", "B11"]);
  assert.deepEqual(chooseSlots(slots, { ...common, quantity: 4 }).map((item) => item.court), ["B9", "B10", "B11", "B12"]);
  assert.deepEqual(chooseSlots(slots, { ...common, quantity: 5 }).map((item) => item.court), ["B1", "B2", "B5", "B6", "B9"]);
});

test("replaces failed courts with another consecutive group while excluding completed attempts", () => {
  const slots = ["B1", "B2", "B3", "B4", "B5", "B6", "B9"].map((court) => ({
    id: court.toLowerCase(),
    state: "free",
    court,
    start: "07:00",
    end: "08:00",
    durationMinutes: 60,
    canStart: true,
  }));
  const replacements = chooseReplacementSlots(slots, {
    startTime: "07:00",
    durationMinutes: 60,
    courtPreferences: [],
    allowAnyCourt: true,
    preferConsecutiveCourts: true,
    allowNonConsecutiveCourts: false,
  }, {
    excludeCourts: ["B1", "B2", "B3 Euro Finans", "B4 Euro Finans"],
    quantity: 2,
  });
  assert.deepEqual(replacements.map((item) => item.court), ["B5", "B6"]);
});

test("secures one replacement immediately when fewer courts than requested remain", () => {
  const replacements = chooseReplacementSlots([{
    id: "b5",
    state: "free",
    court: "B5",
    start: "07:00",
    end: "08:00",
    durationMinutes: 60,
    canStart: true,
  }], {
    startTime: "07:00",
    durationMinutes: 60,
    courtPreferences: [],
    allowAnyCourt: true,
  }, {
    excludeCourts: ["B1", "B2", "B3", "B4"],
    quantity: 2,
  });
  assert.deepEqual(replacements.map((item) => item.court), ["B5"]);
});

test("custom overbooking limit controls how many uncertain orders may be replaced", () => {
  assert.deepEqual(computeReplacementAllowance({
    requiredQuantity: 4,
    confirmedCount: 2,
    uncertainCount: 2,
    allowOverbooking: true,
    maxOverbookCourts: 2,
  }), {
    requiredQuantity: 4,
    maximumPossibleCourts: 6,
    currentPotentialCourts: 4,
    riskHeadroom: 2,
    replacementsAllowed: 2,
  });
  assert.equal(computeReplacementAllowance({
    requiredQuantity: 4,
    confirmedCount: 2,
    uncertainCount: 2,
    allowOverbooking: true,
    maxOverbookCourts: 1,
  }).replacementsAllowed, 1);
  assert.equal(computeReplacementAllowance({
    requiredQuantity: 4,
    confirmedCount: 3,
    uncertainCount: 1,
    allowOverbooking: false,
    maxOverbookCourts: 6,
  }).replacementsAllowed, 0);
});

test("marks an explicit final-submit slot conflict as safely replaceable after rollback", async () => {
  const client = new MatchiClient();
  client.authenticated = true;
  const calls = [];
  client.checkoutApi = async (_context, path, options = {}) => {
    calls.push({ path, method: options.method || "GET" });
    if (path.endsWith("/valuecard") && options.method === "POST") return {};
    if (path.includes("/valuecard/") && options.method === "DELETE") return {};
    if (options.method === "POST") {
      throw new MatchiError("slot lost", { status: 409 });
    }
    return {
      amountToPay: "0.00",
      price: { amount: "0.00", currency: "SEK" },
      valueCardOutcomes: [{ amount: "70.00", valueCard: { id: 900002 } }],
    };
  };
  await assert.rejects(
    () => client.commitValueCardCheckout({
      context: { checkoutToken: "token", bearerToken: "bearer" },
      card: { id: 900002, name: "Card", amount: 2200 },
      total: 73,
      constraints: {
        valueCardId: 900002,
        expectedValueCardCharge: 70,
        maxValueCardCharge: 280,
        currency: "SEK",
      },
    }),
    (error) => (
      error?.details?.code === "SAFE_SLOT_REPLACEMENT"
      && error.details.safeToReplace === true
      && error.details.rollbackSucceeded === true
      && error.details.paymentStage === "submit-order"
    ),
  );
  assert.equal(calls.some((call) => call.method === "DELETE"), true);
});

test("marks a final-submit timeout as uncertain for the configurable overbooking policy", async () => {
  const client = new MatchiClient();
  client.authenticated = true;
  client.checkoutApi = async (_context, path, options = {}) => {
    if (path.endsWith("/valuecard") && options.method === "POST") return {};
    if (options.method === "POST") throw new MatchiError("request timeout");
    return {
      amountToPay: "0.00",
      price: { amount: "0.00", currency: "SEK" },
      valueCardOutcomes: [{ amount: "70.00", valueCard: { id: 900002 } }],
    };
  };
  await assert.rejects(
    () => client.commitValueCardCheckout({
      context: { checkoutToken: "token", bearerToken: "bearer" },
      card: { id: 900002, name: "Card", amount: 2200 },
      total: 73,
      constraints: {
        valueCardId: 900002,
        expectedValueCardCharge: 70,
        maxValueCardCharge: 280,
        currency: "SEK",
      },
    }),
    (error) => (
      error?.details?.code === "PAYMENT_UNCERTAIN"
      && error.details.safeToReplace === false
      && error.details.finalSubmissionStarted === true
    ),
  );
});

test("skips the redundant final checkout GET when submit already returns an order id", async () => {
  const client = new MatchiClient();
  client.authenticated = true;
  let modelReads = 0;
  client.checkoutApi = async (_context, path, options = {}) => {
    if (path.endsWith("/valuecard") && options.method === "POST") return {};
    if (options.method === "POST") return { orderId: 123456789, orderStatus: "COMPLETED" };
    modelReads += 1;
    return {
      amountToPay: "0.00",
      price: { amount: "0.00", currency: "SEK" },
    valueCardOutcomes: [{ amount: "70.00", valueCard: { id: 900002 } }],
    };
  };
  const receipt = await client.commitValueCardCheckout({
    context: { checkoutToken: "token", bearerToken: "bearer" },
    card: { id: 900002, name: "Card", amount: 2200 },
    total: 73,
    constraints: {
      valueCardId: 900002,
      expectedValueCardCharge: 70,
      maxValueCardCharge: 280,
      currency: "SEK",
    },
  });
  assert.equal(receipt.orderId, 123456789);
  assert.equal(receipt.timings.finalModelSkipped, true);
  assert.equal(receipt.timings.finalModelMs, 0);
  assert.equal(modelReads, 1);
});

test("follows MATCHi's same-origin Adyen bootstrap to the hosted checkout", async () => {
  const client = new MatchiClient();
  client.authenticated = true;
  let bootstrapUrl = null;
  client.request = async () => ({
    response: new Response("", {
      status: 302,
      headers: { location: "https://www.matchi.se/adyen/checkoutSession?orderId=123" },
    }),
    url: "https://www.matchi.se/bookingPayment/payEntryPoint",
  });
  client.text = async (url) => {
    bootstrapUrl = url;
    return {
      response: new Response("", { status: 200 }),
      url,
      html: '<a id="checkout" href="https://checkout.matchi.com/pay/token?token=bearer&amp;autoRedirect=false">Pay</a>',
    };
  };
  const hosted = await client.createOnlineCheckout({
    formAction: "/bookingPayment/payEntryPoint",
    fields: [["slotIds", "slot"]],
    paymentMethods: ["CHECKOUT_SESSION"],
  });
  assert.equal(new URL(hosted).hostname, "checkout.matchi.com");
  assert.equal(new URL(hosted).pathname, "/pay/token");
  assert.match(bootstrapUrl, /\/adyen\/checkoutSession\?orderId=123$/);
});

test("parses advance-day notice", () => {
  const notice = parseScheduleNotice("ATL Victoriastadion allows bookings no more than 14 days in the future");
  assert.equal(notice.advanceDays, 14);
});

test("computes Friday release at Stockholm midnight", () => {
  const release = computeReleaseInstant("2026-09-11", 14, "Europe/Stockholm");
  assert.equal(release.toISOString(), "2026-08-27T22:00:00.000Z");
});

test("computes a Stockholm target start instant", () => {
  const target = computeTargetStartInstant("2026-09-08", "07:00", "Europe/Stockholm");
  assert.equal(target.toISOString(), "2026-09-08T05:00:00.000Z");
});

test("parses confirmation without selecting unchecked payment radio", () => {
  const html = `
    <form action="/bookingPayment/payEntryPoint" method="post" id="confirmForm">
      <input type="hidden" name="slotIds" value="abc" />
      <input type="hidden" name="facilityId" value="2560" />
      <input type="radio" name="method" value="CHECKOUT_SESSION" id="CHECKOUT_SESSION">
      <input type="submit" name="next" value="Next" />
    </form>
    <p>The total price for this booking will be 70 SEK.</p>`;
  const confirmation = parseConfirmation(html);
  assert.equal(confirmation.formAction, "/bookingPayment/payEntryPoint");
  assert.deepEqual(confirmation.paymentMethods, ["CHECKOUT_SESSION"]);
  assert.equal(confirmation.price, "70 SEK");
  assert.deepEqual(confirmation.fields, [["slotIds", "abc"], ["facilityId", "2560"]]);
});

test("Danish confirmations do not confuse Euro Finans court names with EUR prices", () => {
  for (const court of ['B3 Euro Finans', 'B4 Euro Finans', '3 Euro Finans']) {
    assert.equal(parseConfirmation(`<p>${court} 18:00 - 19:00 170 SEK</p>
      <p>Den samlede pris for denne reservation vil være 170 SEK.</p>`).price, '170 SEK');
    assert.equal(parseConfirmation(`<p>${court}</p>`).price, null);
  }
  assert.equal(parseConfirmation('<p>Pris 170,50 SEK</p>').price, '170,50 SEK');
  assert.equal(parseConfirmation('<p>Price 30 EUR</p>').price, '30 EUR');
});

test("accepts only the configured value card when it fully covers the capped total", () => {
  const model = {
    amountToPay: "73.00",
    price: { amount: "73.00", currency: "SEK" },
    valueCardOutcomes: [],
    valueCards: [{
      id: 900001,
      name: "Example Value Card",
      method: "GIFT_CARD",
      currency: "SEK",
      amount: "285.00",
    }],
  };
  const result = validateValueCardModel(model, {
    currency: "SEK",
    maxTotal: 75,
    valueCardId: 900001,
    valueCardName: "Example Value Card",
  });
  assert.equal(result.total, 73);
  assert.equal(result.card.id, 900001);
});

test("rejects value-card checkout if any bank-funded remainder exists", () => {
  const model = {
    amountToPay: "3.00",
    price: { amount: "3.00", currency: "SEK" },
    valueCardOutcomes: [{
      amount: "70.00",
      valueCard: { id: 900001 },
    }],
  };
  assert.throws(
    () => validateAppliedValueCardModel(model, {
      valueCardId: 900001,
      expectedAmount: 70,
      maxValueCardCharge: 70,
      currency: "SEK",
    }),
    /拒绝使用银行卡补差额/,
  );
});

test("accepts an exact full-balance value-card outcome", () => {
  const model = {
    amountToPay: "0.00",
    price: { amount: "0.00", currency: "SEK" },
    valueCardOutcomes: [{
      amount: "70.00",
      valueCard: { id: 900001 },
    }],
  };
  assert.deepEqual(
    validateAppliedValueCardModel(model, {
      valueCardId: 900001,
      expectedAmount: 70,
      maxValueCardCharge: 70,
      currency: "SEK",
    }),
    { amount: 70, currency: "SEK" },
  );
});
