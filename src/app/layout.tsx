import type { Metadata, Viewport } from "next";
import { geist, geistMono, grotesk } from "./fonts";
import "./globals.css";
import "./styles/people.css";
import "./styles/directory.css";
import "./styles/sso-email.css";
import "./styles/updates.css";
import "./styles/policy.css";

export const metadata: Metadata = {
  title: { default: "Captivo Access", template: "%s · Captivo Access" },
  description: "Open-source, self-hosted Zero Trust secure vendor access.",
  applicationName: "Captivo Access",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#080b14" },
    { media: "(prefers-color-scheme: light)", color: "#f3f4f7" },
  ],
};

// The theme before first paint: the family's captivo-theme cookie, else this
// host's old ca-theme setting, else dark (see components/theme-switcher.tsx).
const THEME_SCRIPT = `(function(){var t='dark';try{var m=document.cookie.match(/(?:^|; )captivo-theme=(light|dark)/);if(m){t=m[1];}else{var p=localStorage.getItem('ca-theme');if(p==='light'||p==='dark')t=p;}}catch(e){}document.documentElement.dataset.theme=t;})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${grotesk.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
