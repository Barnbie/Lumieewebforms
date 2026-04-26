import { supabase } from './_lib/supabase.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // ── GET — fetch dashboard data ──────────────────────
  if (event.httpMethod === 'GET') {
    const type = event.queryStringParameters?.type;

    try {
      if (type === 'enquiries') {
        const { data, error } = await supabase
          .from('enquiries')
          .select('*')
          .order('created_at', { ascending: false });
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ data }) };
      }

      if (type === 'approvals') {
        const { data, error } = await supabase
          .from('approval_queue')
          .select('*, enquiries(*)')
          .order('created_at', { ascending: false });
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ data }) };
      }

      if (type === 'clients') {
        const { data, error } = await supabase
          .from('clients')
          .select('*, enquiry:enquiries(service)')
          .order('created_at', { ascending: false });
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ data }) };
      }

      if (type === 'projects') {
        const { data, error } = await supabase
          .from('projects')
          .select('*')
          .order('created_at', { ascending: false });
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ data }) };
      }

      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown type' }) };

    } catch (err) {
      console.error('Dashboard GET error:', err.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST — mutations ────────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);
      const { type } = body;

      // create client manually
      if (type === 'create_client') {
        const { full_name, email, whatsapp, business_name, service, notes } = body;
        if (!full_name || !whatsapp) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Full name and WhatsApp required' }) };
        }
        const { data: client, error: cErr } = await supabase
          .from('clients')
          .insert({ full_name, email: email || null, whatsapp, business_name: business_name || null, notes: notes || null, onboarding_complete: true })
          .select().single();
        if (cErr) throw cErr;

        const SERVICE_NAMES = { website:'Website Development', mobile:'Mobile App Development', design:'Product Design', seo:'SEO Optimization' };
        const serviceName = SERVICE_NAMES[service] || service || 'Project';
        await supabase.from('projects').insert({
          client_id: client.id,
          title: serviceName + ' for ' + full_name,
          service: service || 'website',
          stage: 'onboarding',
          notes: notes || null
        });
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, data: client }) };
      }

      if (type === 'create_project') {
        const { title, client_name, service, stage, notes } = body;
        if (!title || !client_name) {
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Title and client name required' }) };
        }
        const { data, error } = await supabase
          .from('projects')
          .insert({ title, service, stage: stage || 'onboarding', notes: notes || null })
          .select()
          .single();
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, data }) };
      }

      if (type === 'update_project_stage') {
        const { project_id, stage } = body;
        const { error } = await supabase
          .from('projects')
          .update({ stage })
          .eq('id', project_id);
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
      }

      if (type === 'delete_project') {
        const { project_id } = body;
        const { error } = await supabase
          .from('projects')
          .delete()
          .eq('id', project_id);
        if (error) throw error;
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
      }

      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action type' }) };

    } catch (err) {
      console.error('Dashboard POST error:', err.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};