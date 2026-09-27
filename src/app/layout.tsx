import type { Metadata, Viewport } from "next";
import { grotesk, plexMono, plexSans, publicSans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Captivo Access", template: "%s · Captivo Access" },
  description: "Open-source, self-hosted Zero Trust secure vendor access.",
  applicationName: "Captivo Access",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0e14" },
    { media: "(prefers-color-scheme: light)", color: "#f7f8fc" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} ${publicSans.variable} ${grotesk.variable}`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=localStorage.getItem('ca-theme');var t=(p==='light'||p==='dark')?p:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='light';}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
