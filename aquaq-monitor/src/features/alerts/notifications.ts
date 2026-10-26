// Browser notifications for alerts.
// Supabase mode: a real web-push subscription (VAPID) is stored server-side and the `alerts`
// Edge Function sends pushes, so they arrive even when the app is closed.
// Demo mode: there is no push server, so the open app shows local notifications through
// the service worker instead.

import type { Profile } from '@shared/types.ts';
import type { DataSource } from '@/data/source';

const LS_KEY = 'aquaq.notifications';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
}

export function notificationsEnabled(): boolean {
  try {
    return notificationsSupported() && Notification.permission === 'granted' && localStorage.getItem(LS_KEY) === 'on';
  } catch {
    return false;
  }
}

function setPref(on: boolean) {
  try {
    if (on) localStorage.setItem(LS_KEY, 'on');
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* per-device convenience only */
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function enableNotifications(source: DataSource, user: Profile): Promise<string> {
  if (!notificationsSupported()) throw new Error('This browser does not support notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser settings.');
  const reg = await navigator.serviceWorker.ready;
  if (source.kind === 'supabase') {
    const key = import.meta.env.VITE_VAPID_PUBLIC_KEY;
    if (!key) throw new Error('Web push is not configured (VITE_VAPID_PUBLIC_KEY is missing).');
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
    await source.savePushSubscription(user, sub.toJSON(), true);
  } else {
    await source.savePushSubscription(user, {}, true);
  }
  setPref(true);
  return source.kind === 'supabase' ? 'Push notifications enabled on this device.' : 'Notifications enabled on this device while the app is open (demo mode has no push server).';
}

export async function disableNotifications(source: DataSource, user: Profile): Promise<void> {
  setPref(false);
  if (!notificationsSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await source.savePushSubscription(user, sub.toJSON(), false);
    await sub.unsubscribe();
  } else if (source.kind === 'demo') {
    await source.savePushSubscription(user, {}, false);
  }
}

/** Show a notification from the open app (demo mode). */
export async function showLocalNotification(title: string, body: string, tag: string, critical: boolean, url: string) {
  if (!notificationsEnabled()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag, icon: '/icon.svg', requireInteraction: critical, data: { url } });
    else new Notification(title, { body, tag, icon: '/icon.svg' });
  } catch {
    /* ignore: notifications are best-effort on top of the in-app centre */
  }
}
