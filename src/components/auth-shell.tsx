import { headers } from "next/headers";
import { BrandLockup } from "@/components/brand";
import { ThemeSwitcher } from "@/components/theme-switcher";

// Shared frame for the pre-login screens (sign in / setup / recover / invite /
// new workspace): the design hand-off's dot grid and glow, the theme toggle,
// the lockup, a card whose top strip names the host it is on, and the footer.
// Purely presentational: the page's content is the card body.
export async function AuthShell({ children }: { children: React.ReactNode }) {
  const host = (await headers()).get("host") ?? "";
  return (
    <div className="authx">
      <div className="authx-top"><ThemeSwitcher /></div>
      <BrandLockup size={30} className="authx-lockup" />
      <div className="authx-card">
        <div className="authx-bar">
          <span className="authx-host">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            {host}
          </span>
          <span className="authx-stepno" id="authx-stepno" />
        </div>
        <div className="authx-body">{children}</div>
      </div>
      <div className="authx-foot">
        <span>© {new Date().getFullYear()} Captivo</span>·<a href="https://captivo.io/en/privacy" target="_blank" rel="noopener noreferrer">Privacy</a>·<a href="https://captivo.io" target="_blank" rel="noopener noreferrer">captivo.io</a>
      </div>
    </div>
  );
}
