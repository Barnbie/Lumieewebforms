import { supabase, logAgentAction } from './_lib/supabase.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { service, stage, full_name, whatsapp, email, submitted_at, ...formFields } = body;

    if (!service || !stage || !full_name || !whatsapp) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const { data: enquiry, error } = await supabase
      .from('enquiries')
      .insert({ service, stage, full_name, whatsapp, email: email || null, form_data: formFields, status: 'new' })
      .select()
      .single();

    if (error) throw new Error(`Database error: ${error.message}`);

    await logAgentAction({ agent: 'system', action: 'form_submitted', status: 'success', enquiry_id: enquiry.id, details: { service, stage, full_name } });

    // trigger Agent 1 in background
    fetch(`${process.env.BASE_URL}/.netlify/functions/agent-intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enquiry_id: enquiry.id })
    }).catch(err => console.error('Agent 1 trigger failed:', err));

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'Submission received', enquiry_id: enquiry.id }) };

  } catch (err) {
    console.error('submit-form error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
  }
};
