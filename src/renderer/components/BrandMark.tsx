/** Screen Scout brand mark — an emerald viewfinder/scan glyph. */
export function BrandMark({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" stroke="url(#scout-grad)" strokeWidth="1.6" />
      <path
        d="M6.5 7.2v-1.9a0.8 0.8 0 0 1 0.8-0.8h1.9M15.6 4.5h1.1a0.8 0.8 0 0 1 0.8 0.8v1.9M17.5 15.2v1.6a0.8 0.8 0 0 1-0.8 0.8h-1.9M8.4 17.6H7.3a0.8 0.8 0 0 1-0.8-0.8v-1.6"
        stroke="#22e887"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="#22e887" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="0.9" fill="#22e887" />
      <defs>
        <linearGradient id="scout-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2df598" />
          <stop offset="1" stopColor="#0f9d58" />
        </linearGradient>
      </defs>
    </svg>
  )
}
