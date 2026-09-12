'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

export interface JoinQRProps {
  /** absolute URL a phone should open, e.g. https://host/scene/4B2K */
  url: string;
  /** pixel edge of the QR itself, quiet zone included. Default 220. */
  size?: number;
}

/**
 * QR for the join link.
 *
 * Rendered dark-on-white with a white quiet zone: that is the combination every
 * phone camera reads first time off a lit screen, and the white plate reads as a
 * deliberate object on the near-black console rather than a styling accident.
 * If generation fails for any reason the URL is shown as large selectable text —
 * an empty box in the middle of an emergency is not an option.
 */
export default function JoinQR({ url, size = 220 }: JoinQRProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const text = typeof url === 'string' ? url.trim() : '';

    if (!canvas || text.length === 0) {
      setFailed(true);
      return;
    }

    let cancelled = false;
    const edge = Math.max(96, Math.min(512, Math.round(Number(size) || 220)));

    (async () => {
      try {
        await QRCode.toCanvas(canvas, text, {
          width: edge,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#0a0a0bff', light: '#ffffffff' },
        });
        if (!cancelled) setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, size]);

  return (
    <div className="qr-block">
      <div className="qr" style={{ display: failed ? 'none' : 'inline-flex' }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={url ? `QR code for ${url}` : 'QR code'}
          width={size}
          height={size}
        />
      </div>
      {failed ? (
        <div className="qr-fallback" aria-label="Join link">
          {url && url.trim().length > 0 ? url : 'Join link unavailable'}
        </div>
      ) : null}
    </div>
  );
}
