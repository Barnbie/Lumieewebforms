import crypto from 'crypto';
import { supabase, logAgentAction } from './_lib/supabase.js';
import { notifyOwner } from './_lib/notify.js';
import { sendEmail } from './_lib/notify.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const SERVICE_NAMES = {
  website: 'Website Development',
  mobile: 'Mobile App Development',
  design: 'Product Design',
  seo: 'SEO Optimization'
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    // ── Step 1: Verify Paystack webhook signature ─────
    const signature = event.headers['x-paystack-signature'];
    const secret = process.env.PAYSTACK_SECRET_KEY;

    if (signature && secret) {
      const hash = crypto
        .createHmac('sha512', secret)
        .update(event.body)
        .digest('hex');

      if (hash !== signature) {
        console.error('Invalid Paystack signature');
        return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid signature' }) };
      }
    }

    const payload = JSON.parse(event.body);
    console.log('Paystack event:', payload.event);

    // ── Step 2: Only handle successful charges ────────
    if (payload.event !== 'charge.success') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ message: 'Event ignored' }) };
    }

    const { reference, amount, customer, metadata } = payload.data;
    const enquiry_id = metadata?.enquiry_id;
    const full_name = metadata?.full_name || customer?.name || 'Client';
    const email = customer?.email;

    console.log('Payment received:', reference, 'Amount:', amount, 'Enquiry:', enquiry_id);

    // ── Step 3: Find the enquiry ──────────────────────
    let enquiry = null;

    if (enquiry_id) {
      const { data } = await supabase
        .from('enquiries')
        .select('*')
        .eq('id', enquiry_id)
        .single();
      enquiry = data;
    }

    if (!enquiry) {
      // try finding by payment reference
      const { data } = await supabase
        .from('enquiries')
        .select('*')
        .eq('payment_ref', reference)
        .single();
      enquiry = data;
    }

    if (!enquiry) {
      console.error('No enquiry found for payment:', reference);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ message: 'No matching enquiry found' }) };
    }

    // ── Step 4: Mark enquiry as paid ──────────────────
    await supabase.from('enquiries').update({
      status: 'paid',
      payment_ref: reference,
      payment_verified: true,
      paid_at: new Date().toISOString()
    }).eq('id', enquiry.id);

    await logAgentAction({
      agent: 'payment',
      action: 'payment_confirmed',
      status: 'success',
      enquiry_id: enquiry.id,
      details: { reference, amount, email }
    });

    // ── Step 5: Create client record ──────────────────
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .insert({
        enquiry_id: enquiry.id,
        full_name: enquiry.full_name,
        email: enquiry.email || email,
        whatsapp: enquiry.whatsapp,
        business_name: enquiry.form_data?.business_name || null,
        onboarding_complete: false
      })
      .select()
      .single();

    if (clientError) {
      console.error('Client creation error:', clientError.message);
    } else {
      console.log('Client created:', client.id);
    }

    // ── Step 6: Create project record ─────────────────
    if (client) {
      const serviceName = SERVICE_NAMES[enquiry.service] || enquiry.service;
      const { error: projError } = await supabase
        .from('projects')
        .insert({
          client_id: client.id,
          enquiry_id: enquiry.id,
          title: `${serviceName} for ${enquiry.full_name}`,
          service: enquiry.service,
          stage: 'onboarding'
        });

      if (projError) console.error('Project creation error:', projError.message);
      else console.log('Project created');
    }

    // ── Step 7: Send onboarding form link to client ───
    const onboardingUrl = `${process.env.BASE_URL}?paid=true&service=${enquiry.service}`;
    const clientEmail = enquiry.email || email;
    const serviceName = SERVICE_NAMES[enquiry.service] || enquiry.service;
    const firstName = enquiry.full_name.split(' ')[0];

    if (clientEmail) {
      await sendEmail({
        to_email: clientEmail,
        to_name: enquiry.full_name,
        subject: `Payment confirmed — Let us get started, ${firstName}`,
        html_content: `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f4f4f8;padding:32px;">
            <div style="background:#050507;border-radius:12px;padding:24px 28px;margin-bottom:20px;">
              <span style="color:#fff;font-size:18px;font-weight:800;">Lumiee <span style="color:#DD4290;">Web Studio</span></span>
            </div>
            <div style="background:#fff;border-radius:12px;padding:28px;">
              <h2 style="margin:0 0 16px;color:#050507;font-size:22px;">Payment confirmed. Welcome aboard!</h2>
              <p style="color:#444;font-size:16px;line-height:1.7;margin:0 0 16px;">Hi ${firstName},</p>
              <p style="color:#444;font-size:16px;line-height:1.7;margin:0 0 16px;">Your payment for <strong>${serviceName}</strong> has been received and confirmed. We are excited to start working with you.</p>
              <p style="color:#444;font-size:16px;line-height:1.7;margin:0 0 24px;">To get started, please fill in your project onboarding form. This helps us collect everything we need to deliver the best possible result for you.</p>
              <a href="${onboardingUrl}" style="display:inline-block;background:#DD4290;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;">Fill Onboarding Form</a>
              <p style="color:#888;font-size:14px;margin:24px 0 0;">If you have any questions at any point, feel free to reach out on WhatsApp.</p>
            </div>
          </div>`,
        text_content: `Hi ${firstName}, your payment for ${serviceName} is confirmed. Please fill your onboarding form here: ${onboardingUrl}`,
        enquiry_id: enquiry.id,
        client_id: client?.id,
        recipient: 'client'
      });
      console.log('Onboarding email sent to client');
    }

    // ── Step 8: Notify owner ──────────────────────────
    await notifyOwner({
      subject: `Payment received from ${enquiry.full_name} — ${serviceName}`,
      message: `${enquiry.full_name} has paid for ${serviceName}. They have been moved to clients and an onboarding form link has been sent to them.`,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f4f4f8;">
          <div style="background:#050507;border-radius:12px;padding:24px 28px;margin-bottom:20px;">
            <span style="color:#fff;font-size:18px;font-weight:800;">Lumiee <span style="color:#DD4290;">Web Studio</span></span>
          </div>
          <div style="background:#fff;border-radius:12px;padding:28px;">
            <h2 style="margin:0 0 16px;color:#050507;font-size:20px;">Payment Received</h2>
            <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Client:</strong> ${enquiry.full_name}</p>
            <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Service:</strong> ${serviceName}</p>
            <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Amount:</strong> NGN ${(amount / 100).toLocaleString()}</p>
            <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Reference:</strong> ${reference}</p>
            <p style="color:#34d399;font-size:16px;margin:24px 0 0;font-weight:600;">Client record and project have been created automatically. Onboarding form sent to client.</p>
          </div>
        </div>`,
      enquiry_id: enquiry.id,
      client_id: client?.id
    });

    console.log('Owner notified of payment');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error('Paystack webhook error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};