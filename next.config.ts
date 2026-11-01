import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone", // self-hosted (systemd/PM2) deployment, no Docker required
  poweredByHeader: false,
  reactStrictMode: true,
  // Security headers (CSP etc.) are added in a later phase together with the real UI.
};

export default nextConfig;
