import { supabase, logAgentAction } from './_lib/supabase.js';
import { notifyOwner } from './_lib/notify.js';
import { v4 as uuidv4 } from 'uuid';

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
    const body = JSON.parse(event.body);
    const { service, stage, full_name, whatsapp, email, submitted_at, ...formFields } = body;

    if (!service || !stage || !full_name || !whatsapp) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // ── Step 1: Save enquiry ──────────────────────────
    console.log('Saving enquiry to Supabase...');
    const { data: enquiry, error } = await supabase
      .from('enquiries')
      .insert({ service, stage, full_name, whatsapp, email: email || null, form_data: formFields, status: 'new' })
      .select()
      .single();

    if (error) throw new Error(`Database error: ${error.message}`);
    console.log('Enquiry saved:', enquiry.id);

    await logAgentAction({ agent: 'system', action: 'form_submitted', status: 'success', enquiry_id: enquiry.id, details: { service, stage, full_name } });

    // ── Step 2: Generate AI reply ─────────────────────
    console.log('Starting Agent 1...');
    await supabase.from('enquiries').update({ status: 'processing' }).eq('id', enquiry.id);

    let aiReply = '';
    try {
      console.log('Calling Groq API...');
      const { default: Groq } = await import('groq-sdk');
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const firstName = full_name.split(' ')[0];
      const isEnquiry = stage === 'enquiry';
      const serviceName = SERVICE_NAMES[service] || service;

      const formSummary = buildFormSummary({ full_name, whatsapp, email, service, stage, ...formFields });

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are the AI assistant for Lumiee Web Studio, a professional web development, mobile development, product design and SEO studio based in Nigeria.
Write a warm, professional and personalised email reply to a client.
Style: warm but professional, confident, clear, address client by first name (${firstName}), no hyphens connecting words, short paragraphs, no bullet points.
${isEnquiry
  ? 'This client is making an enquiry. Address their needs, build confidence, guide them toward payment. Mention invoice is attached.'
  : 'This client has paid. Welcome them warmly, confirm project is active, explain next steps.'}`
          },
          {
            role: 'user',
            content: `Write a professional email reply:\n\n${formSummary}\n\nStart with "Hi ${firstName}," and end with a sign off from Lumiee Web Studio. No subject line.`
          }
        ],
        temperature: 0.7,
        max_tokens: 800
      });

      aiReply = completion.choices[0]?.message?.content || '';
      console.log('Groq reply generated, length:', aiReply.length);

    } catch (groqErr) {
      console.error('Groq failed:', groqErr.message);
      aiReply = `Hi ${full_name.split(' ')[0]},\n\nThank you for reaching out to Lumiee Web Studio. We have received your enquiry and will get back to you shortly with full details.\n\nWarm regards,\nLumiee Web Studio`;
    }

    // ── Step 3: Create Paystack link ──────────────────
    let paystackLink = null;
    let paystackAmount = null;

    try {
      if (stage === 'enquiry' && service === 'website') {
        const budget = formFields.budget_range || '';
        if (budget.includes('150,000')) paystackAmount = 150000;
        else if (budget.includes('300,000')) paystackAmount = 300000;

        if (paystackAmount) {
          console.log('Creating Paystack link for amount:', paystackAmount);
          const { default: axios } = await import('axios');
          const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
              email: email || `${full_name.replace(/\s+/g,'').toLowerCase()}@client.lumiee`,
              amount: paystackAmount * 100,
              currency: 'NGN',
              reference: `LWS-${enquiry.id.substring(0, 8).toUpperCase()}`,
              metadata: { enquiry_id: enquiry.id, full_name, service: SERVICE_NAMES[service] }
            },
            { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
          );
          paystackLink = response.data.data.authorization_url;
          console.log('Paystack link created');
        }
      }
    } catch (psErr) {
      console.error('Paystack failed:', psErr.message);
    }

    // ── Step 4: Save to approval queue ───────────────
    const approvalToken = uuidv4();
    console.log('Saving to approval queue...');

    const { error: aqError } = await supabase.from('approval_queue').insert({
      enquiry_id: enquiry.id,
      draft_reply: aiReply,
      paystack_link: paystackLink,
      status: 'pending',
      approval_token: approvalToken
    });

    if (aqError) console.error('Approval queue error:', aqError.message);
    else console.log('Approval queue saved');

    // ── Step 5: Update enquiry ────────────────────────
    await supabase.from('enquiries').update({
      status: 'awaiting_approval',
      agent_reply: aiReply,
      paystack_link: paystackLink,
      paystack_amount: paystackAmount ? paystackAmount * 100 : null
    }).eq('id', enquiry.id);

    // ── Step 6: Send owner notification email ─────────
    const approvalUrl = `${process.env.BASE_URL}/admin.html?approve=${approvalToken}`;
    const serviceName = SERVICE_NAMES[service];
    console.log('Sending owner notification email...');

    const emailResult = await notifyOwner({
      subject: `New ${stage === 'enquiry' ? 'Enquiry' : 'Onboarding'} from ${full_name} — ${serviceName}`,
      message: `New ${stage} from ${full_name} for ${serviceName}. Review: ${approvalUrl}`,
      html: `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f4f4f8;">
        <div style="background:#050507;border-radius:12px;padding:24px 28px;margin-bottom:20px;">
          <span style="color:#fff;font-size:18px;font-weight:800;">Lumiee <span style="color:#DD4290;">Web Studio</span></span>
        </div>
        <div style="background:#fff;border-radius:12px;padding:28px;">
          <h2 style="margin:0 0 16px;color:#050507;font-size:20px;">New ${stage === 'enquiry' ? 'Enquiry' : 'Onboarding'}</h2>
          <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Client:</strong> ${full_name}</p>
          <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Service:</strong> ${serviceName}</p>
          <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>WhatsApp:</strong> ${whatsapp}</p>
          ${email ? `<p style="color:#444;font-size:16px;margin:0 0 24px;"><strong>Email:</strong> ${email}</p>` : ''}
          <p style="color:#444;font-size:16px;margin:0 0 24px;">Agent has drafted a reply. Review and approve below.</p>
          <a href="${approvalUrl}" style="display:inline-block;background:#DD4290;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;">Review and Approve</a>
        </div>
      </div>`,
      enquiry_id: enquiry.id
    });

    console.log('Email result:', emailResult);
    await logAgentAction({ agent: 'intake', action: 'completed', status: 'success', enquiry_id: enquiry.id });

    // if paid stage trigger Agent 3
    if (stage === 'paid') {
      console.log('Paid stage — triggering Agent 3...');
      try {
        const { handler: onboardingHandler } = await import('./agent-onboarding.js');
        await onboardingHandler({ httpMethod: 'POST', body: JSON.stringify({ enquiry_id: enquiry.id }), headers: {} });
        console.log('Agent 3 done');
      } catch (a3Err) {
        console.error('Agent 3 failed:', a3Err.message);
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, message: 'Submission received', enquiry_id: enquiry.id })
    };

  } catch (err) {
    console.error('submit-form fatal error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
  }
};

function buildFormSummary({ full_name, whatsapp, email, service, stage, ...fields }) {
  const lines = [
    `Client Name: ${full_name}`,
    `WhatsApp: ${whatsapp}`,
    email ? `Email: ${email}` : null,
    `Service: ${SERVICE_NAMES[service] || service}`,
    `Stage: ${stage === 'enquiry' ? 'Making an enquiry' : 'Has paid'}`,
    '',
    'Form Details:'
  ].filter(Boolean);

  Object.entries(fields).forEach(([key, value]) => {
    if (value && String(value).trim() && key !== 'submitted_at') {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      lines.push(`${label}: ${value}`);
    }
  });

  return lines.join('\n');
}