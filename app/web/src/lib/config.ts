export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3100"
export const WS_URL = import.meta.env.VITE_WS_URL ?? API_BASE.replace(/^http/, "ws") + "/ws"
