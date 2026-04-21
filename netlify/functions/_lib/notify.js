// netlify/functions/_lib/notify.js
// Handles all WhatsApp (Twilio) and Email (Brevo) notifications

import twilio from 'twilio';
import axios from 'axios';
import { logNotification } from './supabase.js';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Send WhatsApp message via Twilio ────────────────
export async function sendWhatsApp({ to, message, enquiry_id, client_id, recipient = 'owner' }) {
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body: message
    });

    await logNotification({
      type: 'whatsapp',
      recipient,
      to_number: to,
      message,
      status: 'sent',
      enquiry_id,
      client_id
    });

    return { success: true };
  } catch (err) {
    console.error('WhatsApp send failed:', err);
    await logNotification({
      type: 'whatsapp',
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

// ── Send email via Brevo ────────────────────────────
export async function sendEmail({ to_email, to_name, subject, html_content, text_content, enquiry_id, client_id, recipient = 'client' }) {
  try {
    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: {
          name: 'Lumiee Web Studio',
          email: process.env.OWNER_EMAIL
        },
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

    await logNotification({
      type: 'email',
      recipient,
      to_email,
      subject,
      message: text_content || html_content,
      status: 'sent',
      enquiry_id,
      client_id
    });

    return { success: true };
  } catch (err) {
    console.error('Email send failed:', err?.response?.data || err.message);
    await logNotification({
      type: 'email',
      recipient,
      to_email,
      subject,
      message: text_content || html_content,
      status: 'failed',
      error_message: err.message,
      enquiry_id,
      client_id
    });
    return { success: false, error: err.message };
  }
}

// ── Notify owner on WhatsApp ────────────────────────
export async function notifyOwner({ message, enquiry_id, client_id }) {
  return sendWhatsApp({
    to: process.env.OWNER_WHATSAPP,
    message,
    enquiry_id,
    client_id,
    recipient: 'owner'
  });
}
