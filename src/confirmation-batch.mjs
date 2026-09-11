import { MatchiError, isTransientHttpStatus } from "./matchi-client.mjs";

export async function getIndividualConfirmations(client, config, selections) {
  const startedAt = performance.now();
  const settled = await Promise.allSettled(selections.map(async (selection) => {
    const slotIds = selection.slots.map((slot) => slot.id);
    const confirmation = await client.getConfirmation({
      facilityId: config.facilityId,
      slotIds,
      refererSlug: config.facilitySlug,
    });
    confirmation.facilitySlug = config.facilitySlug;
    return { selection, confirmation };
  }));
  const confirmations = [];
  const conflicts = [];
  const transientFailures = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      confirmations.push(result.value);
      return;
    }
    if (result.reason instanceof MatchiError && result.reason.details?.code === "SLOT_CONFLICT") {
      conflicts.push({ selection: selections[index], error: result.reason });
      return;
    }
    const status = result.reason instanceof MatchiError ? Number(result.reason.details?.status) : Number.NaN;
    if (
      (result.reason instanceof MatchiError && result.reason.details?.code === "NETWORK_TRANSIENT")
      || isTransientHttpStatus(status)
    ) {
      transientFailures.push({ selection: selections[index], error: result.reason, status });
      return;
    }
    throw result.reason;
  });
  return {
    confirmations,
    conflicts,
    transientFailures,
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
  };
}
