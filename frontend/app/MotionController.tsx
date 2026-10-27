'use client';

import { useEffect } from 'react';

/** Adds gentle, visual-only pointer/gyroscope motion without changing page controls. */
export default function MotionController() {
  useEffect(() => {
    const root = document.documentElement;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;

    let targetX = 0;
    let targetY = 0;
    let frame = 0;

    const apply = () => {
      root.style.setProperty('--qroyvan-motion-x', `${targetX.toFixed(2)}px`);
      root.style.setProperty('--qroyvan-motion-y', `${targetY.toFixed(2)}px`);
      frame = 0;
    };
    const queueApply = () => {
      if (!frame) frame = window.requestAnimationFrame(apply);
    };

    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const nx = (event.clientX / Math.max(window.innerWidth, 1) - 0.5) * 2;
      const ny = (event.clientY / Math.max(window.innerHeight, 1) - 0.5) * 2;
      targetX = Math.max(-8, Math.min(8, nx * 8));
      targetY = Math.max(-6, Math.min(6, ny * 6));
      queueApply();
    };

    const onOrientation = (event: DeviceOrientationEvent) => {
      if (typeof event.gamma !== 'number' || typeof event.beta !== 'number') return;
      targetX = Math.max(-8, Math.min(8, (event.gamma / 45) * 8));
      targetY = Math.max(-6, Math.min(6, ((event.beta - 45) / 45) * 6));
      queueApply();
    };

    const reset = () => {
      targetX = 0;
      targetY = 0;
      queueApply();
    };

    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('blur', reset);
      if (frame) window.cancelAnimationFrame(frame);
      root.style.removeProperty('--qroyvan-motion-x');
      root.style.removeProperty('--qroyvan-motion-y');
    };
  }, []);

  return null;
}

