import type { NextConfig } from "next";

/**
 * The web UI is a front end only: every API, the creator agent's A2A endpoints and the older console
 * are served by the agents backend (agents/src/app/server.ts) on 127.0.0.1:8788, proxied here.
 */
const backend = process.env.FACEVISA_BACKEND ?? process.env.LIKENESS_BACKEND ?? "http://127.0.0.1:8788";

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  output: "standalone",
  images: { unoptimized: true },
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
    ];
  },
};

export default nextConfig;
