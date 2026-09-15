// Captivo Access brand mark: the parent "orbit" symbol (open C-arc) with the
// product-specific keyhole dot at the gap, in the cyan→violet brand gradient.
// The functional UI accent stays teal; this gradient is used only for the mark.
export function BrandMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="ca-orbit" x1="16" y1="12" x2="84" y2="88" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2EE6C9" />
          <stop offset="0.52" stopColor="#12B5B0" />
          <stop offset="1" stopColor="#0B7D73" />
        </linearGradient>
      </defs>
      <path d="M77.98 67.49 A33 33 0 1 1 77.98 32.51" stroke="url(#ca-orbit)" strokeWidth="7.5" strokeLinecap="round" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M83 41.6 a8.4 8.4 0 1 1 0 16.8 a8.4 8.4 0 0 1 0 -16.8 Z M83 44.8 a3.1 3.1 0 0 0 -1.25 5.94 l -0.85 4.06 h 4.2 l -0.85 -4.06 A3.1 3.1 0 0 0 83 44.8 Z"
        fill="url(#ca-orbit)"
      />
    </svg>
  );
}

// Full compact lockup: symbol + "Captivo" (Space Grotesk) + bordered ACCESS chip.
// Theme/context styling comes from CSS (.brand-word / .brand-access), so the same
// lockup works on the dark nav bar and the auth screens.
export function BrandLockup({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <span className={className ? `brand-lockup ${className}` : "brand-lockup"}>
      <BrandMark size={size} />
      <span className="brand-word">Captivo</span>
      <span className="brand-access">Access</span>
    </span>
  );
}
