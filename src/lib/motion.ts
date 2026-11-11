// The viewer's motion preference, read live so changing it in the system
// settings takes effect without a reload.

export const REDUCED_MOTION: MediaQueryList = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : ({ matches: false } as MediaQueryList);

/** Touch screens get bigger targets on the map. */
export const COARSE_POINTER: MediaQueryList = typeof matchMedia === 'function'
  ? matchMedia('(pointer: coarse)')
  : ({ matches: false } as MediaQueryList);
