import { supabase } from './_lib/supabase.js';

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
    const { client_name, client_email, amount, service, deposit_percent } = body;

    if (!client_email || !amount || !service) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'client_email, amount and service are required' }) };
    }

    const chargeAmount = parseInt(amount);
    if (isNaN(chargeAmount) || chargeAmount <= 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid amount' }) };
    }

    const ref = `LWS-MAN-${Date.now().toString(36).toUpperCase()}`;

    const { default: axios } = await import('axios');
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: client_email,
        amount: chargeAmount * 100, // convert to kobo
        currency: 'NGN',
        reference: ref,
        metadata: {
          client_name: client_name || 'Manual Invoice',
          service,
          deposit_percent: deposit_percent || 100,
          source: 'manual_invoice',
          custom_fields: [
            { display_name: 'Client Name', variable_name: 'client_name', value: client_name || '' },
            { display_name: 'Service', variable_name: 'service', value: service }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const paymentLink = response.data.data.authorization_url;
    const reference = response.data.data.reference;

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, payment_link: paymentLink, reference })
    };

  } catch (err) {
    console.error('Generate payment link error:', err?.response?.data || err.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Failed to generate payment link: ' + err.message })
    };
  }
};