/**
 * Font loader for the design system.
 *
 * Three typefaces:
 *   - DM Sans (sans)             — 400 / 500 / 600
 *   - Newsreader (serif display) — 400
 *   - IBM Plex Mono (mono labels — eyebrow, timestamps, coords) — 400 / 500
 *
 * The keys registered here MUST match `fontFamily.*` in tokens.ts.
 *
 * `useDesignFonts()` is the hook RootLayout calls — it gates render until
 * fonts are loaded (or 4 seconds elapse and we proceed with system fallback).
 */

import { useEffect, useState } from 'react';
import * as Font from 'expo-font';
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
} from '@expo-google-fonts/dm-sans';
import { Newsreader_400Regular } from '@expo-google-fonts/newsreader';
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
} from '@expo-google-fonts/ibm-plex-mono';

const fontMap = {
  DMSans: DMSans_400Regular,
  'DMSans-Medium': DMSans_500Medium,
  'DMSans-Semibold': DMSans_600SemiBold,
  Newsreader: Newsreader_400Regular,
  IBMPlexMono: IBMPlexMono_400Regular,
  'IBMPlexMono-Medium': IBMPlexMono_500Medium,
};

export function useDesignFonts(): { fontsReady: boolean } {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      // Don't block the UI forever — system fonts are an acceptable fallback.
      if (!cancelled) setReady(true);
    }, 4000);
    Font.loadAsync(fontMap)
      .then(() => { if (!cancelled) setReady(true); })
      .catch(err => {
        console.warn('[fonts] load failed, proceeding with system fonts:', err);
        if (!cancelled) setReady(true);
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);
  return { fontsReady: ready };
}
