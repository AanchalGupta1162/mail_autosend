import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { securityHeaders } from "./lib/csp";

// Express backend. Read when the server starts (dev) and when building (`next build` bakes
// rewrites into the routes manifest), so set BACKEND_URL for both.
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  // web/ has its own lockfile; keep Turbopack from treating the repo root as the workspace.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  poweredByHeader: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  // Same-origin API: the browser only ever talks to this origin; the session cookie set by
  // Express (httpOnly, SameSite=Strict) passes through unchanged.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
  async headers() {
    return [{ source: "/:path*", headers: Object.entries(securityHeaders(process.env.NODE_ENV)).map(([key, value]) => ({ key, value })) }];
  },
};

export default nextConfig;
