import test from "node:test";
import assert from "node:assert/strict";
import { getIndividualConfirmations } from "../src/confirmation-batch.mjs";
import { MatchiError } from "../src/matchi-client.mjs";

const config = { facilityId: 2560, facilitySlug: "atl" };
const selections = [
  { court: "B1", slots: [{ id: "b1-18" }] },
  { court: "B2", slots: [{ id: "b2-18" }] },
  { court: "B3", slots: [{ id: "b3-18" }] },
];

test("preserves successful confirmation pages when another parallel request gets a transient 500", async () => {
  let b2Attempts = 0;
  const client = {
    async getConfirmation({ slotIds }) {
      if (slotIds[0] === "b2-18" && ++b2Attempts === 1) {
        throw new MatchiError("temporary server error", { status: 500, code: "CONFIRMATION_HTTP" });
      }
      return { price: "70 SEK" };
    },
  };
  const first = await getIndividualConfirmations(client, config, selections);
  assert.deepEqual(first.confirmations.map((item) => item.selection.court), ["B1", "B3"]);
  assert.deepEqual(first.transientFailures.map((item) => item.selection.court), ["B2"]);
  assert.deepEqual(first.conflicts, []);

  const retry = await getIndividualConfirmations(
    client,
    config,
    first.transientFailures.map((item) => item.selection),
  );
  assert.deepEqual(retry.confirmations.map((item) => item.selection.court), ["B2"]);
  assert.deepEqual(retry.transientFailures, []);
});

test("keeps definite slot conflicts separate from retryable server failures", async () => {
  const client = {
    async getConfirmation({ slotIds }) {
      if (slotIds[0] === "b1-18") throw new MatchiError("lost", { code: "SLOT_CONFLICT", status: 409 });
      if (slotIds[0] === "b2-18") throw new MatchiError("busy", { code: "NETWORK_TRANSIENT" });
      return { price: "70 SEK" };
    },
  };
  const batch = await getIndividualConfirmations(client, config, selections);
  assert.deepEqual(batch.conflicts.map((item) => item.selection.court), ["B1"]);
  assert.deepEqual(batch.transientFailures.map((item) => item.selection.court), ["B2"]);
  assert.deepEqual(batch.confirmations.map((item) => item.selection.court), ["B3"]);
});
