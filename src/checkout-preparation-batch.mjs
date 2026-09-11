export async function prepareValueCardCheckoutBatch(client, items, constraintsFor) {
  const startedAt = performance.now();
  const settled = await Promise.allSettled(items.map(async (item, index) => {
    const constraints = constraintsFor(item, index);
    const prepared = await client.prepareValueCardCheckout(item.confirmation, constraints);
    return { ...item, prepared, constraints };
  }));

  const preparedOrders = [];
  const failures = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      preparedOrders.push(result.value);
    } else {
      failures.push({ item: items[index], error: result.reason });
    }
  });
  return {
    preparedOrders,
    failures,
    elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
  };
}
