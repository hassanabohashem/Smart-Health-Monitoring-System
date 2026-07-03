import { supabase } from './supabase';
import type { CaregiverLink } from '@/types/user.types';

/**
 * Send an invitation to a caregiver by email.
 * Wearer provides the caregiver's email → we look up their profile → create a pending link.
 */
export async function sendInvitation(wearerId: string, caregiverEmail: string): Promise<void> {
  const email = caregiverEmail.trim().toLowerCase();

  // Look up the caregiver's profile by email via auth
  const { data: authUser, error: lookupError } = await supabase
    .rpc('get_user_id_by_email', { email_input: email });

  if (lookupError) {
    if (lookupError.message?.includes('NOT_CAREGIVER')) {
      throw new Error('That email belongs to a wearer, not a caregiver.');
    }
    throw lookupError;
  }
  if (!authUser) throw new Error('No account found with that email address.');

  const caregiverId = authUser;

  // Can't link to yourself
  if (caregiverId === wearerId) {
    throw new Error('You cannot send an invitation to yourself.');
  }

  // Check if there's already a link (any status)
  const { data: existingLink } = await supabase
    .from('caregiver_links')
    .select('id, status')
    .eq('wearer_id', wearerId)
    .eq('caregiver_id', caregiverId)
    .maybeSingle();

  if (existingLink?.status === 'active') {
    throw new Error('Already linked with this caregiver.');
  }
  if (existingLink?.status === 'pending') {
    throw new Error('Invitation already sent to this caregiver.');
  }

  if (existingLink?.status === 'revoked') {
    // Re-activate the existing revoked link as pending
    const { error } = await supabase
      .from('caregiver_links')
      .update({ status: 'pending' })
      .eq('id', existingLink.id);
    if (error) throw error;
    return;
  }

  // Create new pending link
  const { error } = await supabase.from('caregiver_links').insert({
    wearer_id: wearerId,
    caregiver_id: caregiverId,
    status: 'pending',
  });

  if (error) throw error;
}

/**
 * Get pending invitations for a caregiver (invitations they need to accept/decline).
 */
export async function getPendingInvitations(caregiverId: string) {
  const { data, error } = await supabase
    .from('caregiver_links')
    .select('*, wearer:profiles!wearer_id(id, full_name, phone, avatar_url, role)')
    .eq('caregiver_id', caregiverId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

/**
 * Accept an invitation.
 */
export async function acceptInvitation(linkId: string): Promise<CaregiverLink> {
  const { data, error } = await supabase
    .from('caregiver_links')
    .update({ status: 'active' })
    .eq('id', linkId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Decline an invitation.
 */
export async function declineInvitation(linkId: string): Promise<void> {
  const { error } = await supabase
    .from('caregiver_links')
    .update({ status: 'revoked' })
    .eq('id', linkId);

  if (error) throw error;
}

/**
 * Get all wearers linked to a caregiver (with profile info).
 */
export async function getLinkedWearers(caregiverId: string) {
  const { data, error } = await supabase
    .from('caregiver_links')
    .select('*, wearer:profiles!wearer_id(id, full_name, phone, avatar_url, role)')
    .eq('caregiver_id', caregiverId)
    .eq('status', 'active');

  if (error) throw error;
  return data || [];
}

/**
 * Get all caregivers linked to a wearer (with profile info).
 */
export async function getLinkedCaregivers(wearerId: string) {
  const { data, error } = await supabase
    .from('caregiver_links')
    .select('*, caregiver:profiles!caregiver_id(id, full_name, phone, avatar_url, role)')
    .eq('wearer_id', wearerId)
    .eq('status', 'active');

  if (error) throw error;
  return data || [];
}

/**
 * Get pending invitations sent by a wearer (to see status).
 */
export async function getSentInvitations(wearerId: string) {
  const { data, error } = await supabase
    .from('caregiver_links')
    .select('*, caregiver:profiles!caregiver_id(id, full_name, phone, avatar_url, role)')
    .eq('wearer_id', wearerId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

/**
 * Remove a link between wearer and caregiver.
 */
export async function unlinkWearer(linkId: string): Promise<void> {
  const { error } = await supabase
    .from('caregiver_links')
    .update({ status: 'revoked' })
    .eq('id', linkId);

  if (error) throw error;
}
