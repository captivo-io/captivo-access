// The Captivo family mark: the orbit (an open C-arc) and its dot, in the brand
// gradient (#16C7F0 -> #2E84F5 -> #7A5AF5). The gradient is for the mark and
// the passkey button only; the interface's accent is the primary blue.
export function BrandMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="captivo-orbit" x1="16" y1="12" x2="84" y2="88" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#16C7F0" />
          <stop offset="0.52" stopColor="#2E84F5" />
          <stop offset="1" stopColor="#7A5AF5" />
        </linearGradient>
      </defs>
      <path d="M77.98 67.49 A33 33 0 1 1 77.98 32.51" stroke="url(#captivo-orbit)" strokeWidth="7.5" strokeLinecap="round" />
      <circle cx="83" cy="50" r="8.4" fill="url(#captivo-orbit)" />
    </svg>
  );
}

// Full compact lockup: symbol + "Captivo" (Space Grotesk) + bordered ACCESS chip.
// Theme/context styling comes from CSS (.brand-word / .brand-access).
export function BrandLockup({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <span className={className ? `brand-lockup ${className}` : "brand-lockup"}>
      <BrandMark size={size} />
      <span className="brand-word">Captivo</span>
      <span className="brand-access">Access</span>
    </span>
  );
}
