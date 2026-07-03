import { useState } from 'react';
import {
  View, ScrollView, KeyboardAvoidingView, Platform,
  SafeAreaView, Text, Pressable,
} from 'react-native';
import {
  Button, Avatar, IconButton, Chip,
} from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import { useAuthStore } from '@/stores/auth.store';
import { updateProfile, ageFromDob } from '@/services/auth.service';
import { supabase } from '@/services/supabase';
import { PhoneInput } from '@/components/PhoneInput';
import { DobCalendarDialog } from '@/components/DobCalendarDialog';
import { AuthInput, AuthSegment, AuthIcon } from '@/components/AuthControls';
import type { BiologicalSex } from '@/types/user.types';
import {
  useDesignTokens, Card, SectionTitle, Toast, useToast,
} from '@/design';
import { fontFamily, radius } from '@/design/tokens';

const MIN_DOB = new Date(1900, 0, 1);
const MAX_DOB = new Date();

function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function isoToDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export default function EditProfileScreen() {
  const { palette } = useDesignTokens();
  const router = useRouter();
  const { t } = useTranslation();
  const profile = useAuthStore((s) => s.profile);
  const setProfile = useAuthStore((s) => s.setProfile);

  const [fullName, setFullName] = useState(profile?.full_name || '');
  const [phone, setPhone] = useState(profile?.phone || '');
  const [phoneValid, setPhoneValid] = useState(true);
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatar_url || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  // DOB drives `age` (derived on save). Caregivers also have these
  // now since the registration flow collects them for every user;
  // medical-specific fields (conditions, meds) below stay wearer-only.
  const [dob, setDob] = useState<Date | null>(isoToDate(profile?.date_of_birth ?? null));
  const [dobPickerOpen, setDobPickerOpen] = useState(false);
  const [sex, setSex] = useState<BiologicalSex | ''>(profile?.sex ?? '');
  const [conditions, setConditions] = useState<string[]>(profile?.conditions ?? []);
  const [medications, setMedications] = useState<string[]>(profile?.medications ?? []);
  // Step goal lives on the Home tab now — tap the "Goal · 6,000"
  // pill on the Steps card to edit. It was here previously but
  // sat awkwardly next to medical fields.
  const [newCondition, setNewCondition] = useState('');
  const [newMedication, setNewMedication] = useState('');
  const { snack, show: showToast, dismiss: dismissToast } = useToast();

  const addCondition = () => {
    const v = newCondition.trim();
    if (!v) return;
    if (conditions.some((c) => c.toLowerCase() === v.toLowerCase())) { setNewCondition(''); return; }
    setConditions([...conditions, v]); setNewCondition('');
  };
  const removeCondition = (c: string) => setConditions(conditions.filter((x) => x !== c));
  const addMedication = () => {
    const v = newMedication.trim();
    if (!v) return;
    if (medications.some((m) => m.toLowerCase() === v.toLowerCase())) { setNewMedication(''); return; }
    setMedications([...medications, v]); setNewMedication('');
  };
  const removeMedication = (m: string) => setMedications(medications.filter((x) => x !== m));

  const handlePickAvatar = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showToast(t('profileEdit.permissionDesc'), 'error');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.5,
    });
    if (result.canceled || !result.assets[0]) return;
    setUploading(true);
    try {
      const asset = result.assets[0];
      const fileExt = asset.uri.split('.').pop() || 'jpg';
      const fileName = `${profile?.id}/avatar.${fileExt}`;
      const response = await fetch(asset.uri);
      const blob = await response.blob();
      const arrayBuffer = await new Response(blob).arrayBuffer();
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, arrayBuffer, { contentType: `image/${fileExt}`, upsert: true });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(fileName);
      setAvatarUrl(urlData.publicUrl);
    } catch (err) {
      console.error('Avatar upload failed:', err);
      showToast(t('profileEdit.uploadFailedDesc'), 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!profile?.id) return;
    if (!fullName.trim()) { showToast(t('profileEdit.nameRequired'), 'error'); return; }
    if (!phoneValid) { showToast(t('profileEdit.invalidPhoneDesc'), 'error'); return; }
    // DOB drives age — derive on save so the clinical assistant API
    // (which reads patient.age) stays in sync without a contract change.
    const dobIso = dob ? dateToIso(dob) : null;
    const ageValue = dobIso ? ageFromDob(dobIso) : null;
    setSaving(true);
    try {
      const isWearer = profile.role === 'wearer';
      const updated = await updateProfile(profile.id, {
        full_name: fullName.trim(),
        phone: phone.trim() || null,
        avatar_url: avatarUrl || null,
        date_of_birth: dobIso,
        age: ageValue,
        sex: sex || null,
        // Medical-specific fields stay wearer-only — caregivers don't
        // have a "my conditions" surface and shouldn't accidentally
        // overwrite a wearer-shaped row. (step_goal moved to Home.)
        ...(isWearer ? { conditions, medications } : {}),
      });
      setProfile(updated);
      router.back();
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; details?: string; hint?: string };
      console.error('[edit-profile] Save failed:', JSON.stringify(e, null, 2));
      let detail = t('profileEdit.saveFailedDesc');
      if (e?.code === '42703') { detail = 'Database schema out of date. Run migration 006_profile_medical_fields.sql.'; }
      else if (e?.code === '42501') { detail = 'Permission denied. RLS blocked the update.'; }
      else if (e?.message) { detail = e.message + (e.hint ? ` (hint: ${e.hint})` : ''); }
      showToast(detail, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Avatar */}
          <View style={{ alignItems: 'center', marginVertical: 16 }}>
            {avatarUrl
              ? <Avatar.Image size={88} source={{ uri: avatarUrl }} />
              : <Avatar.Icon size={88} icon="account-outline" style={{ backgroundColor: palette.accentSoft }} color={palette.accentInk} />}
            <Button
              mode="text"
              icon="camera"
              onPress={handlePickAvatar}
              loading={uploading}
              disabled={uploading}
              style={{ marginTop: 6 }}
              textColor={palette.accentInk}
              labelStyle={{ fontFamily: fontFamily.sansMedium, fontWeight: '500' }}
            >
              {uploading ? t('profileEdit.uploading') : t('profileEdit.changePhoto')}
            </Button>
          </View>

          {/* Basic info — all rows use AuthInput / custom Pressables
              so the visual language matches the registration screen. */}
          <Card>
            <View style={{ gap: 12 }}>
              <AuthInput
                icon="user"
                value={fullName}
                onChangeText={setFullName}
                placeholder={t('profileEdit.fullName')}
                autoCapitalize="words"
                autoComplete="name"
              />
              <PhoneInput
                value={phone} onChangeText={setPhone} onValidation={setPhoneValid}
                label={t('profileEdit.phone')}
              />
              <AuthInput
                icon="mail"
                value={useAuthStore.getState().session?.user?.email || ''}
                placeholder={t('profileEdit.email')}
                editable={false}
              />
              <AuthInput
                icon={profile?.role === 'wearer' ? 'watch' : 'users'}
                value={profile?.role === 'wearer' ? t('auth.wearer') : t('auth.caregiver')}
                placeholder={t('profileEdit.role')}
                editable={false}
              />

              {/* DOB — tappable row mirroring AuthInput dimensions,
                  opens DobCalendarDialog (same as registration). */}
              <Pressable
                onPress={() => setDobPickerOpen(true)}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  height: 52,
                  backgroundColor: palette.surface,
                  borderRadius: radius.md,
                  borderWidth: 1, borderColor: palette.border,
                  paddingHorizontal: 16,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <AuthIcon name="calendar" color={palette.text3} size={20} />
                <Text style={{
                  flex: 1,
                  fontFamily: fontFamily.sans, fontSize: 14,
                  color: dob ? palette.text : palette.text3,
                }}>
                  {dob
                    ? dob.toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' })
                    : t('auth.dobPlaceholder')}
                </Text>
              </Pressable>

              {/* Sex — AuthSegment matches the registration screen.
                  Male/Female only; empty state allowed for legacy
                  users without a sex field (they pick one to save). */}
              <AuthSegment<BiologicalSex | ''>
                value={sex}
                onChange={(v) => setSex(v as BiologicalSex)}
                options={[
                  { value: 'M', label: t('profileEdit.sexMale'),   icon: 'male' },
                  { value: 'F', label: t('profileEdit.sexFemale'), icon: 'female' },
                ]}
              />

            </View>
          </Card>

          {/* Medical profile — wearer-only. */}
          {profile?.role === 'wearer' && (
            <>
              <View style={{ gap: 4 }}>
                <SectionTitle>{t('profileEdit.medicalProfile')}</SectionTitle>
                <Text style={{ fontFamily: fontFamily.sans, fontSize: 12, color: palette.text3 }}>
                  {t('profileEdit.medicalProfileHelp')}
                </Text>
              </View>

              <Card>
                <View style={{ gap: 14 }}>
                  <View style={{ gap: 8 }}>
                    <Text style={{ fontFamily: fontFamily.sansMedium, fontSize: 12, color: palette.text2 }}>
                      {t('profileEdit.conditions')}
                    </Text>
                    {conditions.length > 0 && (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {conditions.map((c) => (
                          <Chip key={c} onClose={() => removeCondition(c)} icon="medical-bag">{c}</Chip>
                        ))}
                      </View>
                    )}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{ flex: 1 }}>
                        <AuthInput
                          icon="check"
                          value={newCondition}
                          onChangeText={setNewCondition}
                          placeholder={t('profileEdit.addConditionPlaceholder')}
                          returnKeyType="done"
                          onSubmitEditing={addCondition}
                        />
                      </View>
                      <IconButton icon="plus-circle" onPress={addCondition} disabled={!newCondition.trim()} size={28} iconColor={palette.accentInk} />
                    </View>
                  </View>

                  <View style={{ gap: 8 }}>
                    <Text style={{ fontFamily: fontFamily.sansMedium, fontSize: 12, color: palette.text2 }}>
                      {t('profileEdit.medications')}
                    </Text>
                    {medications.length > 0 && (
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {medications.map((m) => (
                          <Chip key={m} onClose={() => removeMedication(m)} icon="pill">{m}</Chip>
                        ))}
                      </View>
                    )}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <View style={{ flex: 1 }}>
                        <AuthInput
                          icon="check"
                          value={newMedication}
                          onChangeText={setNewMedication}
                          placeholder={t('profileEdit.addMedicationPlaceholder')}
                          returnKeyType="done"
                          onSubmitEditing={addMedication}
                        />
                      </View>
                      <IconButton icon="plus-circle" onPress={addMedication} disabled={!newMedication.trim()} size={28} iconColor={palette.accentInk} />
                    </View>
                  </View>
                </View>
              </Card>
            </>
          )}

          {/* DOB picker dialog — mounted once, opens on Pressable tap. */}
          <DobCalendarDialog
            visible={dobPickerOpen}
            value={dob}
            minDate={MIN_DOB}
            maxDate={MAX_DOB}
            onPick={(d) => { setDob(d); setDobPickerOpen(false); }}
            onCancel={() => setDobPickerOpen(false)}
          />

          <Button
            mode="contained"
            onPress={handleSave}
            loading={saving}
            disabled={saving}
            style={{ marginTop: 8, borderRadius: radius.pill }}
            contentStyle={{ height: 52 }}
            buttonColor={palette.accent2}
            textColor={palette.textOnAccent}
            labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15 }}
          >
            {t('profileEdit.saveChanges')}
          </Button>
          <Button mode="text" onPress={() => router.back()} textColor={palette.text2}>
            {t('common.cancel')}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
      <Toast snack={snack} onDismiss={dismissToast} />
    </SafeAreaView>
  );
}
