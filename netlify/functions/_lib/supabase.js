// netlify/functions/_lib/supabase.js
// Shared Supabase client — used by all agents and functions
// Uses the SERVICE ROLE key so agents can read and write everything
// This file never touches the frontend

import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
}

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// ── helper: log every agent action ──────────────────
export async function logAgentAction({ agent, action, status, enquiry_id, client_id, project_id, details, error_message }) {
  try {
    await supabase.from('agent_logs').insert({
      agent,
      action,
      status,
      enquiry_id: enquiry_id || null,
      client_id: client_id || null,
      project_id: project_id || null,
      details: details || {},
      error_message: error_message || null
    });
  } catch (err) {
    console.error('Failed to write agent log:', err);
  }
}

// ── helper: log a notification ──────────────────────
export async function logNotification({ type, recipient, to_number, to_email, subject, message, status, error_message, enquiry_id, client_id }) {
  try {
    await supabase.from('notifications').insert({
      type,
      recipient,
      to_number: to_number || null,
      to_email: to_email || null,
      subject: subject || null,
      message,
      status,
      error_message: error_message || null,
      enquiry_id: enquiry_id || null,
      client_id: client_id || null
    });
  } catch (err) {
    console.error('Failed to log notification:', err);
  }
}
