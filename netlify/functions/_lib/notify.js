import axios from 'axios';
import { logNotification } from './supabase.js';

// ── Send email via Brevo ────────────────────────────
export async function sendEmail({ to_email, to_name, subject, html_content, text_content, enquiry_id, client_id, recipient = 'client' }) {
  try {
    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { name: 'Lumiee Web Studio', email: process.env.OWNER_EMAIL },
        to: [{ email: to_email, name: to_name || to_email }],
        subject,
        htmlContent: html_content,
        textContent: text_content
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    await logNotification({ type: 'email', recipient, to_email, subject, message: text_content || '', status: 'sent', enquiry_id, client_id });
    return { success: true };
  } catch (err) {
    console.error('Email failed:', err?.response?.data || err.message);
    await logNotification({ type: 'email', recipient, to_email, subject, message: text_content || '', status: 'failed', error_message: err.message, enquiry_id, client_id });
    return { success: false, error: err.message };
  }
}

// ── Notify owner via email ──────────────────────────
// Sends FROM OWNER_EMAIL (mzbarnbie@gmail.com)
// Sends TO NOTIFICATION_EMAIL (lumieewebstudio@gmail.com)
export async function notifyOwner({ subject, message, html, enquiry_id, client_id }) {
  return sendEmail({
    to_email: process.env.NOTIFICATION_EMAIL || process.env.OWNER_EMAIL,
    to_name: 'Lumiee Web Studio',
    subject,
    html_content: html || `<p style="font-family:sans-serif;font-size:16px;color:#1a1a2e;">${message}</p>`,
    text_content: message,
    enquiry_id,
    client_id,
    recipient: 'owner'
  });
}
