import { createContext, useContext } from "react"
import { useApi, type ApiContextValue } from "./use-api"

const ApiContext = createContext<ApiContextValue | null>(null)

export function ApiProvider({ children }: { children: React.ReactNode }) {
  const api = useApi()
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}

export function useApiContext(): ApiContextValue {
  const ctx = useContext(ApiContext)
  if (!ctx) throw new Error("useApiContext must be used within <ApiProvider>")
  return ctx
}
