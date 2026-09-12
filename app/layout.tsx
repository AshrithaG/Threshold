import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Threshold',
  description: 'AI incident command for the minutes before the ambulance arrives.',
  applicationName: 'Threshold',
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // maximum-scale stops iOS zooming the page when a thumb hits an input mid-emergency
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0a0a0b',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Persistent on every screen. Not tappable: it must never swallow a tap,
            and it must never dial anything. */}
        <div
          className="sim-badge"
          role="note"
          aria-label="Simulation only. In a real emergency, call 911."
        >
          <span className="sim-dot" aria-hidden="true" />
          <span>SIMULATION — CALL 911</span>
        </div>
        {children}
      </body>
    </html>
  );
}
