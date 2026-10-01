// Jednoduché čárové ikony (24×24, currentColor) pro menu a ovládací prvky.
const PATHS = {
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
  calc: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm1 3v4h10V5H7zm1 7h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01M8 19h.01M12 19h.01M16 19h.01',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  cog: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  bellOff: 'M13.7 21a2 2 0 0 1-3.4 0M18.6 13A17 17 0 0 1 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.3-5M2 2l20 20',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  messageOff: 'M21 15a2 2 0 0 1-2 2H9m-4.6-12.6A2 2 0 0 0 3 5v16l4-4h2M9 3h10a2 2 0 0 1 2 2v8M2 2l20 20',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  external: 'M14 3h7v7M10 14 21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  warn: 'M12 3 2 20h20L12 3zm0 6v5m0 3h.01',
  mute: 'M11 5 6 9H3v6h3l5 4V5zM22 9l-6 6M16 9l6 6',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M4 12l5 5L20 6',
  chevDown: 'M6 9l6 6 6-6',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15v-5M3 7h17v4m0 4h-5a2 2 0 0 1 0-4h5v4z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  stop: 'M5 5h14v14H5z',
  info: 'M12 11v6m0-10h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
