// Inline icon set for the session shell (stroke icons, currentColor).
import type { ReactNode } from "react";

const wrap = (d: ReactNode, size = 18) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);

export const Icon = {
  fullscreen: (s?: number) => wrap(<><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>, s),
  clipboard: (s?: number) => wrap(<><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 12h6M9 16h4" /></>, s),
  upload: (s?: number) => wrap(<><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 20h16" /></>, s),
  download: (s?: number) => wrap(<><path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></>, s),
  keyboard: (s?: number) => wrap(<><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></>, s),
  record: (s?: number) => wrap(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" /></>, s),
  leave: (s?: number) => wrap(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>, s),
  info: (s?: number) => wrap(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>, s),
  sound: (s?: number) => wrap(<><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>, s),
  mute: (s?: number) => wrap(<><path d="M11 5 6 9H3v6h3l5 4z" /><path d="m22 9-6 6M16 9l6 6" /></>, s),
  printer: (s?: number) => wrap(<><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M6 21h12v-6H6z" /></>, s),
  gauge: (s?: number) => wrap(<><path d="M4 14a8 8 0 1 1 16 0" /><path d="m12 14 3.5-3.5" /><circle cx="12" cy="14" r="1.2" fill="currentColor" stroke="none" /></>, s),
  shield: (s?: number) => wrap(<><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></>, s),
  eye: (s?: number) => wrap(<><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>, s),
  drop: (s?: number) => wrap(<><path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>, s),
  block: (s?: number) => wrap(<><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>, s),
  chevron: (s?: number) => wrap(<path d="m9 6 6 6-6 6" />, s),
  close: (s?: number) => wrap(<path d="M6 6l12 12M18 6 6 18" />, s),
  panel: (s?: number) => wrap(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>, s),
  paste: (s?: number) => wrap(<><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 10v7M9 14l3 3 3-3" /></>, s),
};
export type IconName = keyof typeof Icon;
