import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./lib/security";

// Security headers on every route (design §10.8). The list lives in lib/security.ts, which middleware.ts
// also reads; the Content-Security-Policy is set there instead of here because it carries a per-request
// nonce and this file is evaluated once, at build time.
const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: [...STATIC_SECURITY_HEADERS] }];
  },
};

export default nextConfig;
