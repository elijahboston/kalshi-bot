/**
 * Inspect raw Kalshi API responses to find field name mismatches
 */
import { KalshiClient } from "@kcb/kalshi-client";

const kalshi = new KalshiClient();

// Get one page of orders and dump raw response
console.log("=== RAW ORDER (first executed) ===\n");
const ordersRes = await kalshi.getOrders({ limit: 100 });
const executed = ordersRes.orders?.find((o: any) => o.status === "executed");
if (executed) {
  console.log(JSON.stringify(executed, null, 2));
} else {
  console.log("No executed orders in first page");
  if (ordersRes.orders?.[0]) {
    console.log("First order instead:");
    console.log(JSON.stringify(ordersRes.orders[0], null, 2));
  }
}

// Get one settlement and dump raw response
console.log("\n=== RAW SETTLEMENT (first) ===\n");
const settRes = await kalshi.getSettlements({ limit: 1 });
if (settRes.settlements?.[0]) {
  console.log(JSON.stringify(settRes.settlements[0], null, 2));
} else {
  console.log("No settlements");
  console.log("Raw response:", JSON.stringify(settRes, null, 2));
}
