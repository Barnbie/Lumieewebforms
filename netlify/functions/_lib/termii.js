import axios from 'axios';
import { logNotification } from './supabase.js';

export async function sendSMS({ to, message, enquiry_id, client_id, recipient = 'owner' }) {
  try {
    const cleanNumber = to.replace('+', '');
    await axios.post('https://api.ng.termii.com/api/sms/send', {
      to: cleanNumber,
      from: process.env.TERMII_SENDER_ID || 'N-Alert',
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: process.env.TERMII_API_KEY
    });

    await logNotification({ type: 'sms', recipient, to_number: to, message, status: 'sent', enquiry_id, client_id });
    return { success: true };
  } catch (err) {
    console.error('Termii SMS failed:', err?.response?.data || err.message);
    await logNotification({ type: 'sms', recipient, to_number: to, message, status: 'failed', error_message: err.message, enquiry_id, client_id });
    return { success: false, error: err.message };
  }
}

export async function notifyOwner({ message, enquiry_id, client_id }) {
  return sendSMS({
    to: process.env.OWNER_WHATSAPP,
    message,
    enquiry_id,
    client_id,
    recipient: 'owner'
  });
}
