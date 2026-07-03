import { useEffect, useRef, useState } from 'react';
import { LogBox } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { lightTheme, darkTheme } from '@/utils/theme';
import { supabase } from '@/services/supabase';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore } from '@/stores/theme.store';
import { getProfile } from '@/services/auth.service';
import { registerForPushNotifications } from '@/services/notification.service';
import { respondToLocationRequests, registerLocateBackgroundTask } from '@/services/location.service';
import { startBackgroundMonitoring, stopBackgroundMonitoring } from '@/services/monitoring.service';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OfflineBanner } from '@/components/OfflineBanner';
import { FallOverlayHost } from '@/components/FallOverlayHost';
import { initOfflineQueue, disposeOfflineQueue } from '@/services/offline-queue.service';
import { initI18n } from '@/i18n';
import { initWearListener, disposeWearListener } from '@/services/wear';
import { useActivityHistoryStore } from '@/stores/activity-history.store';
import { startActivityTicker, stopActivityTicker } from '@/services/activity-ticker';
import { useDesignFonts } from '@/design/fonts';
import { initializeAI, onFallDetected } from '@/services/ai';
import { useFallAlertStore } from '@/stores/fall-alert.store';

// ── Dev-only log filters ──────────────────────────────────────────────
// Known upstream issues, both cosmetic and dev-only (neither occurs in a
// production build):
//  1. react-native-svg dispatches a `svgLayout` native event that Fabric's
//     event plugin maps to `topSvgLayout` without a registered handler, so
//     it logs an error. SVG rendering is unaffected. RN 0.81 + Fabric +
//     react-native-svg interaction, tracked upstream.
//  2. expo-dev-client keeps the screen awake while developing; when the app
//     is backgrounded (e.g. we launch the system maps app via a deep link)
//     expo-keep-awake can't grab the wake lock and throws "Unable to
//     activate keep awake". Harmless — the dev client isn't in prod builds.
if (__DEV__) {
  LogBox.ignoreLogs([
    /Unsupported top level event type "topSvgLayout"/,
    /Unable to activate keep awake/,
  ]);

  // Also silence the matching console.error so they don't pollute Metro.
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    const msg = typeof first === 'string' ? first : String(first ?? '');
    if (msg.includes('Unsupported top level event type "topSvgLayout"')) return;
    if (msg.includes('Unable to activate keep awake')) return;
    origError(...(args as []));
  };
}

function AuthGate() {
  const router = useRouter();
  const segments = useSegments();
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const { session, profile, isInitialized, onboardingDone, setSession, setProfile, setLoading, setInitialized, setOnboardingDone } =
    useAuthStore();

  // Check onboarding status once on mount
  useEffect(() => {
    AsyncStorage.getItem('@onboarding_complete').then((value) => {
      const done = value === 'true';
      setOnboardingDone(done);
      setOnboardingChecked(true);
    });
  }, []);

  // Listen for auth state changes
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session);

        if (session?.user) {
          // Retry profile fetch — on signup, profile may not exist yet
          let profileData = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              profileData = await getProfile(session.user.id);
              break;
            } catch {
              if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
            }
          }
          setProfile(profileData);
        } else {
          setProfile(null);
        }

        setLoading(false);
        setInitialized(true);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Register for push notifications + init offline queue when logged in
  useEffect(() => {
    if (profile?.id) {
      registerForPushNotifications(profile.id);
      initOfflineQueue();
    }
    return () => {
      disposeOfflineQueue();
    };
  }, [profile?.id]);

  // Wearer-side: answer caregiver "Locate now" requests with a fresh GPS
  // fix. Realtime handles the foreground; the background notification task
  // handles backgrounded/killed (woken by the silent push). App-wide so it
  // works on any tab while running.
  useEffect(() => {
    if (profile?.role !== 'wearer' || !profile?.id) return;
    registerLocateBackgroundTask();
    const unsubscribe = respondToLocationRequests(profile.id);
    // Keep the vitals + fall/HAR/cardiac pipeline alive when backgrounded via a
    // foreground service — always on for a wearer; stopped on logout.
    startBackgroundMonitoring();
    return () => {
      unsubscribe();
      stopBackgroundMonitoring();
    };
  }, [profile?.id, profile?.role]);

  // Wear OS Data Layer listener — runs for the whole app session,
  // independent of login. Packets dispatched pre-login still update
  // vitals + HAR; the fall-alert path lazily reads wearerId from the
  // auth store at window-ready time, so falls before login just no-op.
  useEffect(() => {
    initWearListener();
    return () => {
      disposeWearListener();
    };
  }, []);

  // AI models + fall callback — initialized at root so the overlay
  // can fire on ANY screen, not just Home. The callback pushes into
  // the global fall-alert store; FallOverlayHost (mounted below the
  // Stack) reads it and renders the full-screen overlay.
  useEffect(() => {
    initializeAI();
    onFallDetected((confidence) => {
      useFallAlertStore.getState().trigger(confidence);
    });
    // No cleanup-time disposeAI(): the on-device AI adapters are app-session
    // singletons. Disposing them on every effect cleanup (StrictMode double-
    // invoke / Fast-Refresh remount) raced with re-entrant initializeAI() and
    // flipped freshly-loaded adapters back to 'unavailable' mid-registration,
    // producing spurious "failed to load → simulator" fallbacks (the fall
    // model actually loads fine). JS-context teardown reclaims them anyway.
  }, []);

  // Activity history — load persisted buckets, then start the
  // one-minute ticker that snapshots current vitals into the store.
  // Runs for the whole session, independent of login (so demo-mode
  // ticks also populate the chart for design review).
  useEffect(() => {
    useActivityHistoryStore.getState().load().then(() => {
      startActivityTicker();
    });
    return () => {
      stopActivityTicker();
    };
  }, []);

  // Handle notification taps — deep link to alert detail
  const notificationResponseListener = useRef<Notifications.EventSubscription | null>(null);

  useEffect(() => {
    notificationResponseListener.current =
      Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data;
        if (data?.alertId && data?.screen === 'alert-detail') {
          router.push({
            pathname: '/(shared)/alert-detail',
            params: { alertId: data.alertId as string },
          });
        }
      });

    return () => {
      if (notificationResponseListener.current) {
        notificationResponseListener.current.remove();
      }
    };
  }, []);

  // Handle routing based on auth state and role
  useEffect(() => {
    if (!isInitialized || !onboardingChecked) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!session) {
      const currentPath = segments.join('/');
      const inAuth = segments[0] === '(auth)';
      if (onboardingDone) {
        if (!inAuth || currentPath === '(auth)/onboarding') {
          router.replace('/(auth)/login');
        }
      } else {
        if (!inAuth || currentPath !== '(auth)/onboarding') {
          router.replace('/(auth)/onboarding');
        }
      }
    } else if (profile) {
      if (inAuthGroup) {
        if (profile.role === 'caregiver') {
          router.replace('/(caregiver)/dashboard');
        } else {
          router.replace('/(wearer)/home');
        }
      }
    }
  }, [session, profile, segments, isInitialized, onboardingChecked, onboardingDone]);

  return (
    <>
      <OfflineBanner />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(wearer)" />
        <Stack.Screen name="(caregiver)" />
        <Stack.Screen name="(shared)" options={{ headerShown: false, presentation: 'card' }} />
      </Stack>
      {/* Sits ABOVE the Stack so the red overlay covers tabs + every
          screen, regardless of which route the user is on when a
          fall is detected. */}
      <FallOverlayHost />
    </>
  );
}

export default function RootLayout() {
  const { isDarkMode, loadTheme } = useThemeStore();
  const [i18nReady, setI18nReady] = useState(false);
  const { fontsReady } = useDesignFonts();

  useEffect(() => {
    loadTheme();
    initI18n().then(() => setI18nReady(true));
  }, []);

  const theme = isDarkMode ? darkTheme : lightTheme;

  if (!i18nReady || !fontsReady) return null;

  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <StatusBar style="auto" />
        <AuthGate />
      </PaperProvider>
    </SafeAreaProvider>
  );
}
