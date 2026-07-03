import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { supabase } from './supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Register for push notifications and save the token to Supabase.
 */
export async function registerForPushNotifications(userId: string): Promise<string | null> {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') return null;

    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: 'ed89d3c8-5373-4747-ab04-52ab707fdf5f',
    });
    const token = tokenData.data;

    await supabase
      .from('profiles')
      .update({ fcm_token: token })
      .eq('id', userId);

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('alerts', {
        name: 'Health Alerts',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        sound: 'default',
      });
    }

    return token;
  } catch {
    return null;
  }
}

/**
 * Send push notification to a specific user via Expo Push API.
 */
export async function sendPushToUser(
  targetUserId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('fcm_token, notifications_enabled')
    .eq('id', targetUserId)
    .single();

  if (error || !profile?.fcm_token) return;
  // Respect the recipient's notification preference (the Settings toggle).
  // Only an explicit `false` suppresses — null/true (default) still sends.
  if (profile.notifications_enabled === false) return;

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: profile.fcm_token,
        title,
        body,
        sound: 'default',
        priority: 'high',
        data: data || {},
      }),
    });
  } catch {
    // push delivery failed silently
  }
}

/**
 * Send a SILENT, high-priority data-only push (no title/body). On Android a
 * data message wakes the app's background notification task even when
 * backgrounded/killed; on iOS `_contentAvailable` requests a silent
 * background delivery. Used to wake a wearer's device for an on-demand
 * location fix. No-op if the target has no push token.
 */
export async function sendDataPushToUser(
  targetUserId: string,
  data: Record<string, string>
): Promise<void> {
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('fcm_token')
    .eq('id', targetUserId)
    .single();

  if (error || !profile?.fcm_token) return;

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: profile.fcm_token,
        data,
        priority: 'high',
        _contentAvailable: true,
      }),
    });
  } catch {
    // delivery failed silently
  }
}

/**
 * Send alert push to all linked caregivers.
 */
export async function notifyCaregivers(
  wearerId: string,
  wearerName: string,
  alertType: string,
  alertId: string
): Promise<void> {
  const { data: links, error } = await supabase
    .from('caregiver_links')
    .select('caregiver_id')
    .eq('wearer_id', wearerId)
    .eq('status', 'active');

  if (error || !links || links.length === 0) return;

  const titleMap: Record<string, string> = {
    sos: 'SOS Emergency!',
    fall: 'Fall Detected!',
    cardiac: 'Cardiac Alert!',
    geofence: 'Geofence Breach!',
    low_battery: 'Low Battery',
    inactivity: 'Inactivity Alert',
  };

  const bodyMap: Record<string, string> = {
    sos: `${wearerName} triggered an SOS emergency alert!`,
    fall: `A fall was detected for ${wearerName}!`,
    cardiac: `Cardiac anomaly detected for ${wearerName}`,
    geofence: `${wearerName} left all safe zones`,
    low_battery: `${wearerName}'s device battery is low`,
    inactivity: `${wearerName} has been inactive for an extended period`,
  };

  const title = titleMap[alertType] || 'Health Alert';
  const body = bodyMap[alertType] || `Alert for ${wearerName}`;

  const promises = links.map((link) =>
    sendPushToUser(link.caregiver_id, title, body, {
      alertId,
      alertType,
      wearerId,
      screen: 'alert-detail',
    })
  );

  await Promise.allSettled(promises);
}
