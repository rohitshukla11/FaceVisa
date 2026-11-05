/** Inline icons. Decorative by default (aria-hidden); label the control that holds them instead. */
type P = { size?: number; className?: string; stroke?: string };

const base = (size = 20) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true as const, focusable: false as const });

export const IconPerson = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2">
    <circle cx="12" cy="9" r="4" />
    <path d="M4 21c1-4 4-6 8-6s7 2 8 6" />
  </svg>
);

export const IconSearch = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.4" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </svg>
);

export const IconCheck = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12l5 5L20 7" />
  </svg>
);

export const IconCross = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconQuestion = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 9a3 3 0 1 1 4 2.8c-.7.3-1 1-1 1.7V15" />
    <path d="M12 19h.01" />
  </svg>
);

export const IconArrowUpRight = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 17L17 7M8 7h9v9" />
  </svg>
);

export const IconArrowRight = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const IconArrowLeft = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

export const IconChevron = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.2" strokeLinecap="round">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const IconUpload = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 16V4M6 10l6-6 6 6M4 20h16" />
  </svg>
);

export const IconBookmark = ({ size, className, stroke = "currentColor", filled }: P & { filled?: boolean }) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2" strokeLinejoin="round" fill={filled ? stroke : "none"}>
    <path d="M6 4h12v16l-6-4-6 4z" />
  </svg>
);

export const IconShield = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

export const IconCamera = ({ size, className }: P) => (
  <svg {...base(size)} className={className} fill="currentColor">
    <path d="M4 7h11a2 2 0 0 1 2 2v1.5l4-2.5v8l-4-2.5V15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" />
  </svg>
);

/** The verified rosette from the marketplace mockup; carries its own accessible name. */
export const VerifiedMark = ({ size = 20, label = "Verified human" }: { size?: number; label?: string }) => (
  <svg role="img" aria-label={label} viewBox="0 0 24 24" width={size} height={size} className="shrink-0">
    <path d="M12 2l2.6 2.2 3.4-.4.8 3.3 3 1.6-1.3 3.2 1.3 3.2-3 1.6-.8 3.3-3.4-.4L12 22l-2.6-2.2-3.4.4-.8-3.3-3-1.6 1.3-3.2-1.3-3.2 3-1.6.8-3.3 3.4.4z" fill="#121316" />
    <path d="M8 12l3 3 5-6" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconLock = ({ size, className, stroke = "currentColor" }: P) => (
  <svg {...base(size)} className={className} stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
