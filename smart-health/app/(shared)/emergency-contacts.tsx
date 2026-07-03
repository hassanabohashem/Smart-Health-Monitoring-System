import { useState, useEffect } from 'react';
import { View, ScrollView, Alert, SafeAreaView, Text, Pressable } from 'react-native';
import { Portal, Dialog, IconButton } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { PhoneInput } from '@/components/PhoneInput';
import { AuthInput } from '@/components/AuthControls';
import { useAuthStore } from '@/stores/auth.store';
import { updateProfile } from '@/services/auth.service';
import { getLinkedCaregivers } from '@/services/link.service';
import type { EmergencyContact } from '@/types/user.types';
import { samePhone } from '@/utils/phone';
import {
  useDesignTokens, Card, IconDot, Eyebrow, BtnTonal, Toast, useToast,
} from '@/design';
import { fontFamily, radius } from '@/design/tokens';

export default function EmergencyContactsScreen() {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const profile = useAuthStore((s) => s.profile);
  const setProfile = useAuthStore((s) => s.setProfile);

  const [contacts, setContacts] = useState<EmergencyContact[]>(
    (profile?.emergency_contacts as EmergencyContact[]) || []
  );
  // Linked caregivers are emergency contacts automatically: read-only here,
  // removed only by unlinking. Fetched live so a new/removed link reflects.
  const [caregivers, setCaregivers] = useState<{ name: string; phone: string }[]>([]);
  useEffect(() => {
    if (!profile?.id) return;
    getLinkedCaregivers(profile.id)
      .then((links) => {
        const list = (links as Array<{ caregiver?: { full_name?: string; phone?: string } }>)
          .map((l) => ({ name: l.caregiver?.full_name || t('auth.caregiver'), phone: l.caregiver?.phone || '' }))
          .filter((c) => c.phone);
        setCaregivers(list);
      })
      .catch((err) => console.warn('[emergency-contacts] caregiver fetch failed', err));
  }, [profile?.id]);
  const [showDialog, setShowDialog] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneValid, setPhoneValid] = useState(true);
  const [relation, setRelation] = useState('');
  const [, setSaving] = useState(false);
  const { snack, show: showToast, dismiss: dismissToast } = useToast();

  const resetForm = () => {
    setName('');
    setPhone('');
    setPhoneValid(true);
    setRelation('');
    setEditingIndex(null);
  };

  const handleAdd = () => {
    resetForm();
    setShowDialog(true);
  };

  const handleEdit = (index: number) => {
    const contact = contacts[index];
    setName(contact.name);
    setPhone(contact.phone);
    setRelation(contact.relation);
    setEditingIndex(index);
    setShowDialog(true);
  };

  const handleDelete = (index: number) => {
    Alert.alert(
      t('emergencyContacts.removeContact'),
      t('emergencyContacts.removeConfirm', { name: contacts[index].name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('emergencyContacts.remove'),
          style: 'destructive',
          onPress: () => {
            const updated = contacts.filter((_, i) => i !== index);
            setContacts(updated);
            saveContacts(updated);
          },
        },
      ]
    );
  };

  const handleSaveContact = () => {
    if (!name.trim() || !phone.trim()) {
      showToast(t('emergencyContacts.required'), 'error');
      return;
    }
    if (!phoneValid) {
      showToast(t('profileEdit.invalidPhoneDesc'), 'error');
      return;
    }

    const newContact: EmergencyContact = {
      name: name.trim(),
      phone: phone.trim(),
      relation: relation.trim() || t('emergencyContacts.relationOther'),
    };

    const updated: EmergencyContact[] = editingIndex !== null
      ? contacts.map((c, i) => (i === editingIndex ? newContact : c))
      : [...contacts, newContact];

    setContacts(updated);
    setShowDialog(false);
    resetForm();
    saveContacts(updated);
  };

  const saveContacts = async (contactList: EmergencyContact[]) => {
    if (!profile?.id) return;
    setSaving(true);
    try {
      const updated = await updateProfile(profile.id, {
        emergency_contacts: contactList,
      });
      setProfile(updated);
    } catch (err) {
      console.error('Failed to save contacts:', err);
      showToast(t('emergencyContacts.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  // The "main" emergency contact (called first on a fall) can be ANY manual
  // contact OR ANY caregiver. It's tracked by phone on the profile
  // (`primary_emergency_phone`) so the choice syncs across the wearer's devices.
  const mainPhone = profile?.primary_emergency_phone ?? undefined;

  // Resolve the effective main exactly like the fall-call path: the stored
  // phone if it still matches a current contact/caregiver, else the first
  // caregiver, else the first manual contact. Guarantees one starred row that
  // matches who actually gets called.
  const allPhones = [...caregivers.map((c) => c.phone), ...contacts.map((c) => c.phone)];
  const effectiveMain =
    (mainPhone && allPhones.find((p) => samePhone(p, mainPhone))) ||
    caregivers[0]?.phone ||
    contacts[0]?.phone ||
    undefined;
  const isMain = (phone: string) => !!effectiveMain && samePhone(phone, effectiveMain);

  /** Tap a star → make that contact/caregiver the single main. Optimistic:
   *  reflect it immediately, then persist to the synced profile column and
   *  revert on failure. No-op if it's already the effective main. */
  const handleSetMain = async (phone: string) => {
    if (!profile?.id || samePhone(phone, effectiveMain)) return;
    const prev = profile;
    setProfile({ ...profile, primary_emergency_phone: phone });
    try {
      const updated = await updateProfile(profile.id, { primary_emergency_phone: phone });
      setProfile(updated);
    } catch (err) {
      console.error('Failed to set main contact:', err);
      setProfile(prev);
      showToast(t('emergencyContacts.saveFailed'), 'error');
    }
  };

  const maxReached = contacts.length >= 5;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}>
        {/* Intro card */}
        <Card tint="accent" padding={20}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <IconDot icon="shield-account" variant="accent" size={40} />
            <View style={{ flex: 1 }}>
              <Text style={{
                fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.accentInk,
              }}>
                {t('emergencyContacts.title')}
              </Text>
              <Text style={{
                fontFamily: fontFamily.sans, fontSize: 12, color: palette.accentInk, marginTop: 3, opacity: 0.85,
              }}>
                {t('emergencyContacts.desc')}
              </Text>
            </View>
          </View>
        </Card>

        {/* Contacts list */}
        <Card padding={14}>
          <Eyebrow style={{ marginBottom: 10 }}>{t('emergencyContacts.title')}</Eyebrow>

          {caregivers.length === 0 && contacts.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 24, gap: 10 }}>
              <MaterialCommunityIcons name="contacts-outline" size={40} color={palette.text3} />
              <Text style={{
                fontFamily: fontFamily.sans, fontSize: 13, color: palette.text2, textAlign: 'center',
              }}>
                {t('emergencyContacts.noContacts')}
              </Text>
            </View>
          ) : (
            <>
              {/* Linked caregivers — auto emergency contacts, locked (no
                  edit/delete). Removed only by unlinking the caregiver. */}
              {caregivers.map((cg, index) => (
                <View key={`cg-${index}`}>
                  {index > 0 && <View style={{ height: 1, backgroundColor: palette.divider, marginVertical: 4 }} />}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
                    <IconDot icon="shield-account-outline" variant="accent" size={36} />
                    <View style={{ flex: 1 }}>
                      <Text style={{
                        fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.text,
                      }}>
                        {cg.name}
                      </Text>
                      <Text style={{
                        fontFamily: fontFamily.sans, fontSize: 12, color: palette.text2, marginTop: 2,
                      }}>
                        {t('emergencyContacts.caregiverRelation')}
                      </Text>
                      <Text style={{
                        fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginTop: 2,
                      }}>
                        {cg.phone}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <IconButton
                        icon={isMain(cg.phone) ? 'star' : 'star-outline'}
                        size={18}
                        iconColor={isMain(cg.phone) ? palette.warning : palette.text3}
                        onPress={() => handleSetMain(cg.phone)}
                      />
                      <MaterialCommunityIcons name="lock-outline" size={18} color={palette.text3} style={{ marginRight: 8 }} />
                    </View>
                  </View>
                </View>
              ))}
              {caregivers.length > 0 && contacts.length > 0 && (
                <View style={{ height: 1, backgroundColor: palette.divider, marginVertical: 8 }} />
              )}
              {contacts.map((contact, index) => (
                <View key={`m-${index}`}>
                  {index > 0 && <View style={{ height: 1, backgroundColor: palette.divider, marginVertical: 4 }} />}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
                    <IconDot icon="account-outline" variant="accent" size={36} />
                    <View style={{ flex: 1 }}>
                      <Text style={{
                        fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.text,
                      }}>
                        {contact.name}
                      </Text>
                      <Text style={{
                        fontFamily: fontFamily.sans, fontSize: 12, color: palette.text2, marginTop: 2,
                      }}>
                        {contact.relation}
                      </Text>
                      <Text style={{
                        fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginTop: 2,
                      }}>
                        {contact.phone}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row' }}>
                      <IconButton
                        icon={isMain(contact.phone) ? 'star' : 'star-outline'}
                        size={18}
                        iconColor={isMain(contact.phone) ? palette.warning : palette.text3}
                        onPress={() => handleSetMain(contact.phone)}
                      />
                      <IconButton
                        icon="pencil-outline"
                        size={18}
                        iconColor={palette.text2}
                        onPress={() => handleEdit(index)}
                      />
                      <IconButton
                        icon="delete-outline"
                        size={18}
                        iconColor={palette.danger}
                        onPress={() => handleDelete(index)}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </>
          )}
        </Card>

        {/* Add button — full-width soft sage pill matching the design
            system's tonal CTA convention (BtnTonal is auto-width, so
            we hand-roll a full-width variant here using the same
            tokens: accentSoft bg + accentInk text + pill radius). */}
        <Pressable
          onPress={handleAdd}
          disabled={maxReached}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            height: 52,
            borderRadius: radius.pill,
            backgroundColor: maxReached ? palette.surface2 : palette.accentSoft,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <MaterialCommunityIcons
            name="plus"
            size={18}
            color={maxReached ? palette.text3 : palette.accentInk}
          />
          <Text style={{
            fontFamily: fontFamily.sansSemibold,
            fontWeight: '600',
            fontSize: 14,
            color: maxReached ? palette.text3 : palette.accentInk,
          }}>
            {t('emergencyContacts.addContact')}
          </Text>
        </Pressable>

        <Text style={{
          fontFamily: fontFamily.sans, fontSize: 11, color: palette.text3, textAlign: 'center',
        }}>
          {maxReached
            ? t('emergencyContacts.maxContacts')
            : t('emergencyContacts.addedCount', { n: contacts.length })}
        </Text>
      </ScrollView>

      {/* Add/Edit Dialog */}
      <Portal>
        <Dialog
          visible={showDialog}
          onDismiss={() => { setShowDialog(false); resetForm(); }}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
        >
          <Dialog.Title style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text }}>
            {editingIndex !== null ? t('emergencyContacts.editContact') : t('emergencyContacts.addContact')}
          </Dialog.Title>
          <Dialog.Content style={{ gap: 10 }}>
            <AuthInput
              icon="user"
              value={name}
              onChangeText={setName}
              placeholder={t('emergencyContacts.name')}
              autoCapitalize="words"
            />
            <PhoneInput
              value={phone}
              onChangeText={setPhone}
              onValidation={setPhoneValid}
              label={t('emergencyContacts.phone')}
            />
            <AuthInput
              icon="users"
              value={relation}
              onChangeText={setRelation}
              placeholder={t('emergencyContacts.relationPlaceholder')}
              autoCapitalize="words"
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Pressable
              onPress={() => { setShowDialog(false); resetForm(); }}
              hitSlop={6}
              style={{ paddingHorizontal: 12, paddingVertical: 8 }}
            >
              <Text style={{
                fontFamily: fontFamily.sansMedium, fontSize: 14, fontWeight: '500',
                color: palette.text2,
              }}>
                {t('common.cancel')}
              </Text>
            </Pressable>
            <BtnTonal size="sm" onPress={handleSaveContact}>
              {editingIndex !== null ? t('emergencyContacts.update') : t('emergencyContacts.add')}
            </BtnTonal>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Toast snack={snack} onDismiss={dismissToast} />
    </SafeAreaView>
  );
}
