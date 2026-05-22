import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import path from "path"
import { createRequire } from "module"

const require = createRequire(import.meta.url)

// Resolve React packages to their actual locations (Bun may hoist some to root node_modules)
const resolvePackage = (pkg: string) => path.dirname(require.resolve(`${pkg}/package.json`))

export default defineConfig({
  plugins: [TanStackRouterVite({ routesDirectory: "./src/routes" }), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Force Vite to use app/web's React 19, not the monorepo root's React 18 (used by Ink TUI)
      "react": resolvePackage("react"),
      "react-dom": resolvePackage("react-dom"),
      "react/jsx-runtime": path.join(resolvePackage("react"), "jsx-runtime"),
      "react/jsx-dev-runtime": path.join(resolvePackage("react"), "jsx-dev-runtime"),
    },
  },
})
