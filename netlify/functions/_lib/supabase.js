import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

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
