// netlify/functions/_lib/termii.js
// Handles all SMS notifications via Termii

import axios from 'axios';
import { logNotification } from './supabase.js';

// ── Send SMS via Termii ─────────────────────────────
export async function sendSMS({ to, message, enquiry_id, client_id, recipient = 'owner' }) {
  try {
    // Termii expects number without + sign
    const cleanNumber = to.replace('+', '');

    const response = await axios.post('https://api.ng.termii.com/api/sms/send', {
      to: cleanNumber,
      from: process.env.TERMII_SENDER_ID || 'N-Alert',
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: process.env.TERMII_API_KEY
    });

    await logNotification({
      type: 'sms',
      recipient,
      to_number: to,
      message,
      status: 'sent',
      enquiry_id,
      client_id
    });

    return { success: true, data: response.data };
  } catch (err) {
    console.error('Termii SMS failed:', err?.response?.data || err.message);

    await logNotification({
      type: 'sms',
      recipient,
      to_number: to,
      message,
      status: 'failed',
      error_message: err.message,
      enquiry_id,
      client_id
    });

    return { success: false, error: err.message };
  }
}

// ── Notify owner via SMS ────────────────────────────
export async function notifyOwner({ message, enquiry_id, client_id }) {
  return sendSMS({
    to: process.env.OWNER_WHATSAPP,
    message,
    enquiry_id,
    client_id,
    recipient: 'owner'
  });
}
