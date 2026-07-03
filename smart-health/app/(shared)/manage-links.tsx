import { useState, useEffect, useCallback } from 'react';
import { View, RefreshControl, ScrollView, SafeAreaView, Text, Pressable } from 'react-native';
import { Avatar, Portal, Dialog } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { ManageLinksSkeleton } from '@/components/Skeleton';
import { useAuthStore } from '@/stores/auth.store';
import {
  getLinkedWearers, getLinkedCaregivers, getSentInvitations, unlinkWearer,
  getPendingInvitations, acceptInvitation, declineInvitation,
} from '@/services/link.service';
import {
  useDesignTokens, Card, IconDot, BtnTonal, Eyebrow, Toast, useToast, EmptyState,
} from '@/design';
import { fontFamily, radius } from '@/design/tokens';

interface LinkItem {
  id: string;
  name: string;
  phone: string | null;
  role: 'wearer' | 'caregiver';
}

interface PendingItem {
  id: string;
  name: string;
  /** ISO string of when the invite was sent, for the "Sent on …" sub-line. */
  createdAt: string;
}

/** Raw row shape returned by `caregiver_links` join queries. */
interface LinkedRecord {
  id: string;
  created_at?: string;
  caregiver?: { full_name: string | null; phone: string | null };
  wearer?: { full_name: string | null; phone: string | null };
}

/** Localised "May 27" / "27 مايو" — keeps the pending-invite cards
 *  compact without exposing the raw ISO timestamp. */
function fmtShortDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function ManageLinksScreen() {
  const { palette } = useDesignTokens();
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en';
  const profile = useAuthStore((s) => s.profile);
  const [links, setLinks] = useState<LinkItem[]>([]);
  /** Pending invitations the WEARER has sent (awaiting caregiver
   *  acceptance). Caregiver side uses `pendingReceived` below. */
  const [pending, setPending] = useState<PendingItem[]>([]);
  /** Pending invitations the CAREGIVER has received (wearers who
   *  invited them) — accept/decline inline. Empty for wearers. */
  const [pendingReceived, setPendingReceived] = useState<PendingItem[]>([]);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const isWearer = profile?.role === 'wearer';
  const { snack, show: showToast, dismiss: dismissToast } = useToast();
  /** Themed destructive-confirm dialog state. One slot, two modes:
   *  `unlink` for an active linked caregiver, `cancelInvite` for a
   *  pending sent invitation. Both call `unlinkWearer` under the hood
   *  (same DB op — flips status to revoked) but show different copy
   *  and update different local lists on success. */
  const [confirm, setConfirm] = useState<
    | { kind: 'unlink'; item: LinkItem }
    | { kind: 'cancelInvite'; item: PendingItem }
    | { kind: 'declineInvite'; item: PendingItem }
    | null
  >(null);
  const [confirming, setConfirming] = useState(false);

  const loadLinks = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      if (isWearer) {
        // Run both fetches in parallel — they hit different rows and
        // neither blocks the other.
        const [active, sent] = await Promise.all([
          getLinkedCaregivers(profile.id) as unknown as Promise<LinkedRecord[]>,
          getSentInvitations(profile.id) as unknown as Promise<LinkedRecord[]>,
        ]);
        setLinks(active.map((d) => ({
          id: d.id, name: d.caregiver?.full_name || t('alerts.unknown'),
          phone: d.caregiver?.phone || null, role: 'caregiver',
        })));
        setPending(sent.map((d) => ({
          id: d.id,
          name: d.caregiver?.full_name || t('alerts.unknown'),
          createdAt: d.created_at ?? new Date().toISOString(),
        })));
      } else {
        // Caregiver: active linked wearers + pending RECEIVED invites
        // (wearers who invited this caregiver, awaiting accept/decline).
        const [active, received] = await Promise.all([
          getLinkedWearers(profile.id) as unknown as Promise<LinkedRecord[]>,
          getPendingInvitations(profile.id) as unknown as Promise<LinkedRecord[]>,
        ]);
        setLinks(active.map((d) => ({
          id: d.id, name: d.wearer?.full_name || t('alerts.unknown'),
          phone: d.wearer?.phone || null, role: 'wearer',
        })));
        setPendingReceived(received.map((d) => ({
          id: d.id,
          name: d.wearer?.full_name || t('alerts.unknown'),
          createdAt: d.created_at ?? new Date().toISOString(),
        })));
        setPending([]); // caregivers don't send invites
      }
    } catch (err) {
      console.error('Failed to load links:', err);
    } finally {
      setLoading(false);
    }
  }, [profile?.id, isWearer, t]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadLinks();
    setRefreshing(false);
  };

  const handleUnlink = (link: LinkItem) => setConfirm({ kind: 'unlink', item: link });
  const handleCancelInvite = (item: PendingItem) => setConfirm({ kind: 'cancelInvite', item });
  const handleDeclineInvite = (item: PendingItem) => setConfirm({ kind: 'declineInvite', item });

  /** Accept a received invitation — non-destructive, runs inline
   *  (no confirm). Moves the row from pending-received → active links. */
  const handleAcceptInvite = async (item: PendingItem) => {
    setAcceptingId(item.id);
    try {
      await acceptInvitation(item.id);
      setPendingReceived((prev) => prev.filter((p) => p.id !== item.id));
      setLinks((prev) => [...prev, { id: item.id, name: item.name, phone: null, role: 'wearer' }]);
      showToast(t('manageLinks.inviteAccepted'), 'success');
    } catch (err) {
      console.error('Accept failed:', err);
      showToast(t('manageLinks.acceptFailed'), 'error');
    } finally {
      setAcceptingId(null);
    }
  };

  const closeConfirm = () => { if (!confirming) setConfirm(null); };
  const runConfirm = async () => {
    if (!confirm) return;
    setConfirming(true);
    try {
      if (confirm.kind === 'declineInvite') {
        await declineInvitation(confirm.item.id);
        setPendingReceived((prev) => prev.filter((p) => p.id !== confirm.item.id));
        showToast(t('manageLinks.inviteDeclined'), 'success');
      } else {
        // unlink + cancelInvite are the same DB op (status → revoked).
        await unlinkWearer(confirm.item.id);
        if (confirm.kind === 'unlink') {
          setLinks((prev) => prev.filter((l) => l.id !== confirm.item.id));
        } else {
          setPending((prev) => prev.filter((p) => p.id !== confirm.item.id));
          showToast(t('manageLinks.inviteCancelled'), 'success');
        }
      }
      setConfirm(null);
    } catch (err) {
      console.error('Confirm action failed:', err);
      const failKey = confirm.kind === 'unlink'
        ? 'manageLinks.unlinkFailed'
        : confirm.kind === 'declineInvite'
          ? 'manageLinks.declineFailed'
          : 'manageLinks.cancelInviteFailed';
      setConfirm(null);
      showToast(t(failKey), 'error');
    } finally {
      setConfirming(false);
    }
  };

  /** Copy + icon for the active confirm dialog mode. */
  const confirmCopy = confirm?.kind === 'unlink'
    ? {
        icon: 'account-remove-outline' as const,
        title: t('manageLinks.unlinkTitle'),
        body: t('manageLinks.unlinkConfirm', { name: confirm.item.name }),
        action: t('manageLinks.unlink'),
      }
    : confirm?.kind === 'cancelInvite'
    ? {
        icon: 'email-remove-outline' as const,
        title: t('manageLinks.cancelInviteTitle'),
        body: t('manageLinks.cancelInviteConfirm', { name: confirm.item.name }),
        action: t('manageLinks.cancelInviteTitle'),
      }
    : confirm?.kind === 'declineInvite'
    ? {
        icon: 'email-remove-outline' as const,
        title: t('manageLinks.declineInviteTitle'),
        body: t('manageLinks.declineInviteConfirm', { name: confirm.item.name }),
        action: t('manageLinks.decline'),
      }
    : null;

  if (loading && !refreshing) return <ManageLinksSkeleton />;

  // Full-page empty state only when every list is empty (active links,
  // wearer's sent-pending, caregiver's received-pending).
  const totallyEmpty = links.length === 0 && pending.length === 0 && pendingReceived.length === 0;

  if (!loading && totallyEmpty) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
        {/* Card-less, centered — matches the alerts empty state. */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
          <EmptyState
            icon="link-off"
            title={t('manageLinks.noLinks')}
            description={isWearer ? t('manageLinks.noCaregiversLinked') : t('manageLinks.noWearersLinked')}
          />
        </View>
        <Toast snack={snack} onDismiss={dismissToast} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={palette.accent} />}
      >
        <Text style={{ fontFamily: fontFamily.sans, color: palette.text2, fontSize: 13, marginBottom: 4 }}>
          {isWearer ? t('manageLinks.caregiversDesc') : t('manageLinks.wearersDesc')}
        </Text>

        {/* Pending invitations (wearer only). Section is hidden entirely
            when there are no pending invites — no need for an empty
            "no pending" line on a screen that's already light. */}
        {isWearer && pending.length > 0 && (
          <>
            <View style={{ marginTop: 8 }}>
              <Eyebrow>{t('manageLinks.pendingSentTitle')}</Eyebrow>
              <Text style={{
                fontFamily: fontFamily.sans, color: palette.text3, fontSize: 11,
                marginTop: 2,
              }}>
                {t('manageLinks.pendingSentDesc')}
              </Text>
            </View>
            {pending.map((item) => (
              <Card key={item.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Avatar.Icon
                    size={40}
                    icon="email-clock-outline"
                    style={{ backgroundColor: palette.warningSoft }}
                    color={palette.warningInk}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{
                      fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.text,
                    }}>{item.name}</Text>
                    <Text style={{
                      fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginTop: 2,
                    }}>
                      {t('manageLinks.sentOn', { date: fmtShortDate(item.createdAt, locale) })}
                    </Text>
                  </View>
                  <BtnTonal size="xs" tone="danger" onPress={() => handleCancelInvite(item)}>
                    {t('manageLinks.cancel')}
                  </BtnTonal>
                </View>
              </Card>
            ))}
          </>
        )}

        {/* Pending RECEIVED invitations (caregiver only) — wearers who
            invited this caregiver. Accept (sage) / Decline (red). */}
        {!isWearer && pendingReceived.length > 0 && (
          <>
            <View style={{ marginTop: 8 }}>
              <Eyebrow>{t('manageLinks.pendingReceivedTitle')}</Eyebrow>
              <Text style={{
                fontFamily: fontFamily.sans, color: palette.text3, fontSize: 11,
                marginTop: 2,
              }}>
                {t('manageLinks.pendingReceivedDesc')}
              </Text>
            </View>
            {pendingReceived.map((item) => (
              <Card key={item.id}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Avatar.Icon
                    size={40}
                    icon="account-clock-outline"
                    style={{ backgroundColor: palette.warningSoft }}
                    color={palette.warningInk}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{
                      fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.text,
                    }}>{item.name}</Text>
                    <Text style={{
                      fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginTop: 2,
                    }}>
                      {t('manageLinks.invitedYou', { date: fmtShortDate(item.createdAt, locale) })}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <View style={{ opacity: acceptingId === item.id ? 0.5 : 1 }}>
                      <BtnTonal
                        size="xs"
                        onPress={acceptingId === item.id ? undefined : () => handleAcceptInvite(item)}
                      >
                        {acceptingId === item.id ? '…' : t('manageLinks.accept')}
                      </BtnTonal>
                    </View>
                    <BtnTonal size="xs" tone="danger" onPress={() => handleDeclineInvite(item)}>
                      {t('manageLinks.decline')}
                    </BtnTonal>
                  </View>
                </View>
              </Card>
            ))}
          </>
        )}

        {/* Active links section eyebrow — shown when a pending section
            sits above (wearer sent-pending OR caregiver received-pending). */}
        {((isWearer && pending.length > 0) || (!isWearer && pendingReceived.length > 0)) && links.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <Eyebrow>{isWearer ? t('settings.linkedCaregivers') : t('settings.linkedWearers')}</Eyebrow>
          </View>
        )}

        {links.map((link) => (
          <Card key={link.id}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Avatar.Icon
                size={40}
                icon={link.role === 'caregiver' ? 'account-heart-outline' : 'account-outline'}
                style={{ backgroundColor: palette.accentSoft }}
                color={palette.accentInk}
              />
              <View style={{ flex: 1 }}>
                <Text style={{
                  fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.text,
                }}>{link.name}</Text>
                <Text style={{
                  fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginTop: 2,
                }}>{link.phone || t('manageLinks.noPhone')}</Text>
              </View>
              <BtnTonal size="xs" tone="danger" onPress={() => handleUnlink(link)}>
                {t('manageLinks.unlink')}
              </BtnTonal>
            </View>
          </Card>
        ))}
      </ScrollView>

      {/* Themed destructive-confirm dialog — handles both "unlink an
          active caregiver" and "cancel a pending invite". Mounted
          inside the conditional so Paper's Dialog never renders with
          null children during the close animation (which throws). */}
      {confirmCopy && (
        <Portal>
          <Dialog
            visible
            onDismiss={closeConfirm}
            style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
          >
            <Dialog.Icon icon={confirmCopy.icon} color={palette.danger} size={36} />
            <Dialog.Title style={{
              fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text,
              textAlign: 'center',
            }}>
              {confirmCopy.title}
            </Dialog.Title>
            <Dialog.Content style={{ paddingBottom: 20 }}>
              <Text style={{
                fontFamily: fontFamily.sans, fontSize: 14, color: palette.text2,
                textAlign: 'center',
              }}>
                {confirmCopy.body}
              </Text>
            </Dialog.Content>
            <Dialog.Actions>
              <Pressable
                onPress={closeConfirm}
                hitSlop={6}
                style={{ paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <Text style={{
                  fontFamily: fontFamily.sansMedium, fontSize: 14, fontWeight: '500',
                  color: palette.text2,
                }}>
                  {t('manageLinks.keep')}
                </Text>
              </Pressable>
              <View style={{ opacity: confirming ? 0.5 : 1 }}>
                <BtnTonal
                  size="sm"
                  tone="danger"
                  onPress={confirming ? undefined : runConfirm}
                >
                  {confirming ? '…' : confirmCopy.action}
                </BtnTonal>
              </View>
            </Dialog.Actions>
          </Dialog>
        </Portal>
      )}

      <Toast snack={snack} onDismiss={dismissToast} />
    </SafeAreaView>
  );
}
