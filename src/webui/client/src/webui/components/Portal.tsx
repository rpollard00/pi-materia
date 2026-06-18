import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders children into a portal at document.body.
 *
 * Loadout modals must escape their graph panel ancestor, because the
 * `.fantasy-panel` backdrop-filter (and any canvas zoom/pan transform)
 * establishes a containing block for `position: fixed` descendants. Without a
 * portal, a modal marked `position: fixed` is centered on the full canvas/panel
 * box rather than the visible viewport, so on a long, scrolled canvas it spawns
 * far off-screen. Portaling to document.body makes the modal independent of
 * canvas size, scroll position, and zoom/pan transforms.
 */
export interface PortalProps {
  children: ReactNode;
}

export function Portal({ children }: PortalProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setContainer(document.body);
    return () => setContainer(null);
  }, []);

  return container ? createPortal(children, container) : null;
}
