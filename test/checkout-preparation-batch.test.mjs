import test from "node:test";
import assert from "node:assert/strict";
import { prepareValueCardCheckoutBatch } from "../src/checkout-preparation-batch.mjs";

test("preserves successful checkout contexts when another parallel preparation fails", async () => {
  const client = {
    async prepareValueCardCheckout(confirmation, constraints) {
      if (confirmation.id === "B2") throw new Error("hosted checkout missing");
      return { token: confirmation.id, constraints };
    },
  };
  const batch = await prepareValueCardCheckoutBatch(client, [
    { selection: { court: "B1" }, confirmation: { id: "B1" } },
    { selection: { court: "B2" }, confirmation: { id: "B2" } },
  ], (item) => ({ expected: item.selection.court }));
  assert.deepEqual(batch.preparedOrders.map((item) => item.selection.court), ["B1"]);
  assert.equal(batch.failures.length, 1);
  assert.equal(batch.failures[0].item.selection.court, "B2");
});
