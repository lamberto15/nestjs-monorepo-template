import { useQuery, queryOptions } from '@tanstack/react-query';
import { unwrap, type GetResponse } from '@nestjs-monorepo-template/api-client';
import { useEffect } from 'react';
import { api } from '@/lib/api';

export type Branding = GetResponse<'/v1/branding'>;

/** The tenant's branding (docs/branding.md): read again after a tenant switch (the session's cache is reset). */
export const brandingQuery = queryOptions({
  queryKey: ['branding'],
  queryFn: () => unwrap(api.GET('/v1/branding')),
  staleTime: 5 * 60_000,
});

/** Only what the API checked: `#rrggbb`. Anything else is not put in a style. */
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function readableOn(hex: string): '#000000' | '#ffffff' {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // The crossover where black and white have the same contrast.
  return luminance > 0.179 ? '#000000' : '#ffffff';
}

/** The theme variables a brand colour sets (shadcn's tokens): the primary buttons and the sidebar's accent. */
const TOKENS = [
  '--primary',
  '--primary-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--ring',
] as const;

/**
 * Puts the tenant's colour on the theme, or takes it off (null, or a value
 * that is not `#rrggbb`): inline custom properties on `<html>` beat the
 * stylesheet's in both the light and the dark theme. Returns the undo.
 */
export function applyBrandColor(
  color: string | null,
  root = document.documentElement,
) {
  if (!color || !HEX.test(color)) {
    for (const token of TOKENS) root.style.removeProperty(token);
    return;
  }
  const foreground = readableOn(color);
  root.style.setProperty('--primary', color);
  root.style.setProperty('--primary-foreground', foreground);
  root.style.setProperty('--sidebar-primary', color);
  root.style.setProperty('--sidebar-primary-foreground', foreground);
  root.style.setProperty('--ring', color);
}

/** The tenant's branding, once loaded (a failed read leaves the default theme, with no toast). */
export function useBranding() {
  return useQuery({
    ...brandingQuery,
    retry: false,
    meta: { errorToast: false },
  }).data;
}

/** Themes the app with the tenant's colour while mounted; renders nothing. */
export function BrandTheme() {
  const color = useBranding()?.primaryColor ?? null;
  useEffect(() => {
    applyBrandColor(color);
    return () => applyBrandColor(null);
  }, [color]);
  return null;
}
