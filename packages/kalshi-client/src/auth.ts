import { createPrivateKey, sign, constants } from "node:crypto";

/**
 * Sign a Kalshi API request using RSA-PSS with SHA-256.
 *
 * The message to sign is: `{timestampMs}{METHOD}{path}`
 * e.g. `1708300000000GET/trade-api/v2/markets`
 */
export function signRequest(
  privateKeyPem: string,
  timestampMs: number,
  method: string,
  path: string
): string {
  const message = `${timestampMs}${method.toUpperCase()}${path}`;
  const key = createPrivateKey(privateKeyPem);

  const signature = sign("sha256", Buffer.from(message), {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST, // 32 bytes for SHA-256
  });

  return signature.toString("base64");
}

/**
 * Build the three auth headers Kalshi expects on every request.
 */
export function getAuthHeaders(
  apiKey: string,
  privateKeyPem: string,
  method: string,
  path: string
): Record<string, string> {
  const timestampMs = Date.now();
  const signature = signRequest(privateKeyPem, timestampMs, method, path);

  return {
    "KALSHI-ACCESS-KEY": apiKey,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
  };
}
