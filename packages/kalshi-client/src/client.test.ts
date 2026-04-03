import { test, expect, describe, mock, beforeEach } from "bun:test";

// Mock config and auth before importing client
mock.module("@kcb/config", () => ({
  getConfig: () => ({
    kalshi: {
      apiKey: "test-key",
      apiSecret: "test-secret",
      baseUrl: "https://api.test.kalshi.com/trade-api/v2",
    },
  }),
}));

mock.module("./auth", () => ({
  getAuthHeaders: () => ({
    "KALSHI-ACCESS-KEY": "test-key",
    "KALSHI-ACCESS-SIGNATURE": "test-sig",
    "KALSHI-ACCESS-TIMESTAMP": "1234567890",
  }),
}));

import { KalshiClient } from "./client";

// Mock Bun.sleep to avoid real delays in retry tests
const originalSleep = Bun.sleep;
Bun.sleep = (() => Promise.resolve()) as any;

describe("KalshiClient.request() retry logic", () => {
  let fetchCalls: number;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = 0;
  });

  test("succeeds on first try with 200", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response(JSON.stringify({ balance: 1000 }), { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      const result = await client.getBalance();
      expect(result).toEqual({ balance: 1000 });
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries on 429 and succeeds", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Promise.resolve(new Response("rate limited", { status: 429 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ balance: 500 }), { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      const result = await client.getBalance();
      expect(result).toEqual({ balance: 500 });
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries on 503 and succeeds", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      if (fetchCalls <= 2) {
        return Promise.resolve(new Response("service unavailable", { status: 503 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ balance: 300 }), { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      const result = await client.getBalance();
      expect(result).toEqual({ balance: 300 });
      expect(fetchCalls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("respects Retry-After header and retries successfully", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Promise.resolve(new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "1" },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ balance: 100 }), { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      const result = await client.getBalance();
      expect(result).toEqual({ balance: 100 });
      // Should have retried after the 429
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws after exhausting retries on 429", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response("rate limited", { status: 429 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      await expect(client.getBalance()).rejects.toThrow("after 3 retries");
      // 1 initial + 3 retries = 4 total
      expect(fetchCalls).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws immediately on non-retryable error (400)", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response("bad request", { status: 400 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      await expect(client.getBalance()).rejects.toThrow("400");
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws immediately on 401 unauthorized", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response("unauthorized", { status: 401 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      await expect(client.getBalance()).rejects.toThrow("401");
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries on 504 gateway timeout and succeeds", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: { code: "context_deadline_exceeded" } }),
          { status: 504 }
        ));
      }
      return Promise.resolve(new Response(JSON.stringify({ balance: 400 }), { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      const result = await client.getBalance();
      expect(result).toEqual({ balance: 400 });
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws after exhausting retries on 504", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response("gateway timeout", { status: 504 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      await expect(client.getBalance()).rejects.toThrow("after 3 retries");
      expect(fetchCalls).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries on network error (timeout) and succeeds", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Promise.reject(new Error("The operation timed out."));
      }
      return Promise.resolve(new Response(JSON.stringify({ balance: 150 }), { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      const result = await client.getBalance();
      expect(result).toEqual({ balance: 150 });
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws after exhausting retries on network error", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      return Promise.reject(new Error("The operation timed out."));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      await expect(client.getBalance()).rejects.toThrow("timed out");
      expect(fetchCalls).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries on JSON parse error and succeeds", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Promise.resolve(new Response("not json{{{", { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ balance: 250 }), { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      const result = await client.getBalance();
      expect(result).toEqual({ balance: 250 });
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws after exhausting retries on JSON parse error", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response("not json{{{", { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      await expect(client.getBalance()).rejects.toThrow("Failed to parse JSON");
      expect(fetchCalls).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries on 401 header_timestamp_expired and succeeds", async () => {
    const mockFetch = mock(() => {
      fetchCalls++;
      if (fetchCalls === 1) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: { code: "header_timestamp_expired", message: "header timestamp expired" } }),
          { status: 401 }
        ));
      }
      return Promise.resolve(new Response(JSON.stringify({ balance: 200 }), { status: 200 }));
    });
    globalThis.fetch = mockFetch as any;

    try {
      const client = new KalshiClient({
        apiKey: "test",
        apiSecret: "test",
        baseUrl: "https://api.test.kalshi.com/trade-api/v2",
      });
      const result = await client.getBalance();
      expect(result).toEqual({ balance: 200 });
      expect(fetchCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
