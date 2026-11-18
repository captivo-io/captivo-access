import type { NextConfig } from "next";

// Baseline security headers applied to every response. Deliberately no
// Content-Security-Policy: the console renders chart libraries and inline
// styles that a strict CSP would break (a global CSP is an explicit non-goal
// for this app). These headers don't touch that surface.
const securityHeaders = [
  // HSTS: the console is always served over TLS in production. Two years,
  // includeSubDomains; no preload (opt-in separately if ever desired).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Clickjacking: the console is never meant to be framed.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Powerful features the console never uses.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // The live viewer opens inside the console's Sessions page, so it may be
      // framed by this origin and no other. Listed after the baseline so its
      // X-Frame-Options replaces DENY for these paths only.
      {
        source: "/live/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
