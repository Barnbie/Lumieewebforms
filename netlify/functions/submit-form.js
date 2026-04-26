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

// Base prices in Naira
const BASE_PRICES = {
  website: { '150,000': 150000, '300,000': 300000 },
  mobile:  { '500,000': 500000, '1,200,000': 1200000 },
  design:  { '80,000': 80000, '150,000': 150000 },
  seo:     { '80,000': 80000, '150,000': 150000 }
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
    console.log('Saving enquiry...');
    const { data: enquiry, error } = await supabase
      .from('enquiries')
      .insert({ service, stage, full_name, whatsapp, email: email || null, form_data: formFields, status: 'new' })
      .select()
      .single();

    if (error) throw new Error(`Database error: ${error.message}`);
    console.log('Enquiry saved:', enquiry.id);

    await logAgentAction({ agent: 'system', action: 'form_submitted', status: 'success', enquiry_id: enquiry.id, details: { service, stage, full_name } });

    // ── Step 2: Determine pricing ─────────────────────
    const budget = formFields.budget_range || '';
    const paymentPref = formFields.payment_preference || '60% now, 40% on delivery';
    const isCustomBudget = budget.toLowerCase().includes('custom') || budget.toLowerCase().includes('let\'s talk');
    const isFullPayment = paymentPref.includes('full') || paymentPref.includes('100');

    let basePrice = null;
    if (!isCustomBudget && BASE_PRICES[service]) {
      for (const [key, val] of Object.entries(BASE_PRICES[service])) {
        if (budget.includes(key)) { basePrice = val; break; }
      }
    }

    // amount to charge now based on payment preference
    let chargeAmount = null;
    let depositPercent = 60;
    if (basePrice) {
      chargeAmount = isFullPayment ? basePrice : Math.round(basePrice * 0.6);
      depositPercent = isFullPayment ? 100 : 60;
    }

    // ── Step 3: Generate AI reply ─────────────────────
    console.log('Calling Groq...');
    await supabase.from('enquiries').update({ status: 'processing' }).eq('id', enquiry.id);

    let aiReply = '';
    try {
      const { default: Groq } = await import('groq-sdk');
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const firstName = full_name.split(' ')[0];
      const isEnquiry = stage === 'enquiry';
      const formSummary = buildFormSummary({ full_name, whatsapp, email, service, stage, ...formFields });

      const paymentNote = basePrice && !isCustomBudget
        ? isFullPayment
          ? `The client has chosen to pay the full amount of NGN ${basePrice.toLocaleString()} upfront.`
          : `The client has chosen to pay 60% (NGN ${chargeAmount.toLocaleString()}) now and 40% (NGN ${(basePrice - chargeAmount).toLocaleString()}) on delivery.`
        : '';

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are the AI assistant for Lumiee Web Studio, a professional web development and design studio based in Nigeria. Owner WhatsApp: +2348143329373.
Write a warm, professional and personalised email reply to a client.
Style: warm but professional, confident, clear, address client by first name (${firstName}), no hyphens connecting words, short paragraphs, no bullet points in the body.
${isEnquiry
  ? isCustomBudget
    ? `This client has selected a Custom package. Do NOT mention any invoice or payment link. Let them know that Lumiee Web Studio will reach out to them on WhatsApp at +2348143329373 to discuss their specific requirements and prepare a custom quote. They can also reach out directly. Once payment is agreed and made, they will receive an onboarding form via email. All further communication will be through WhatsApp.`
    : `This client is making an enquiry and has not paid yet. Address their specific needs, build confidence in Lumiee Web Studio, and guide them toward payment. ${paymentNote} Let them know a detailed invoice is attached to this email with their payment link. After payment, they will receive an onboarding form via email and all further communication will be via WhatsApp at +2348143329373.`
  : `This client has already paid. Welcome them warmly and confirm their project is now active. Let them know they will receive an onboarding form via email shortly to provide all their project details. All further communication will be through WhatsApp at +2348143329373.`}`
          },
          {
            role: 'user',
            content: `Write a professional email reply:\n\n${formSummary}\n\nStart with "Hi ${firstName}," and end with a professional sign off from Lumiee Web Studio. No subject line, just the email body.`
          }
        ],
        temperature: 0.7,
        max_tokens: 900
      });

      aiReply = completion.choices[0]?.message?.content || '';
      console.log('Groq reply generated, length:', aiReply.length);

    } catch (groqErr) {
      console.error('Groq failed:', groqErr.message);
      aiReply = `Hi ${full_name.split(' ')[0]},\n\nThank you for reaching out to Lumiee Web Studio. We have received your enquiry and will get back to you shortly with full details.\n\nWarm regards,\nLumiee Web Studio`;
    }

    // ── Step 4: Create Paystack link ──────────────────
    let paystackLink = null;
    let paystackRef = null;

    if (chargeAmount && !isCustomBudget) {
      try {
        console.log('Creating Paystack link, amount:', chargeAmount);
        const { default: axios } = await import('axios');
        const response = await axios.post(
          'https://api.paystack.co/transaction/initialize',
          {
            email: email || `${full_name.replace(/\s+/g,'').toLowerCase()}@client.lumiee`,
            amount: chargeAmount * 100,
            currency: 'NGN',
            reference: `LWS-${enquiry.id.substring(0, 8).toUpperCase()}`,
            metadata: {
              enquiry_id: enquiry.id,
              full_name,
              service: SERVICE_NAMES[service],
              base_price: basePrice,
              charge_amount: chargeAmount,
              deposit_percent: depositPercent,
              payment_preference: paymentPref
            }
          },
          { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
        );
        paystackLink = response.data.data.authorization_url;
        paystackRef = response.data.data.reference;
        console.log('Paystack link created');
      } catch (psErr) {
        console.error('Paystack failed:', psErr.message);
      }
    }

    // ── Step 5: Build invoice text ────────────────────
    const invoiceText = buildInvoiceText({
      full_name, email, whatsapp, service,
      budget, basePrice, chargeAmount,
      depositPercent, isFullPayment, isCustomBudget,
      paystackLink, enquiry_id: enquiry.id
    });

    // ── Step 6: Save to approval queue ───────────────
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

    // ── Step 7: Update enquiry ────────────────────────
    await supabase.from('enquiries').update({
      status: 'awaiting_approval',
      agent_reply: aiReply,
      paystack_link: paystackLink,
      paystack_amount: chargeAmount ? chargeAmount * 100 : null,
      form_data: { ...formFields, _invoice: invoiceText, _base_price: basePrice, _charge_amount: chargeAmount, _deposit_percent: depositPercent }
    }).eq('id', enquiry.id);

    // ── Step 8: Notify owner ──────────────────────────
    const approvalUrl = `${process.env.BASE_URL}/admin.html?approve=${approvalToken}`;
    const serviceName = SERVICE_NAMES[service];
    console.log('Sending owner notification...');

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
          ${email ? `<p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Email:</strong> ${email}</p>` : ''}
          ${basePrice ? `<p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Package:</strong> ${budget}</p>
          <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Payment:</strong> ${paymentPref}</p>
          <p style="color:#444;font-size:16px;margin:0 0 24px;"><strong>Amount due now:</strong> NGN ${chargeAmount?.toLocaleString()}</p>` : ''}
          <p style="color:#444;font-size:16px;margin:0 0 24px;">Agent has drafted a reply and invoice. Review and approve below.</p>
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

// ── helpers ───────────────────────────────────────────

function buildFormSummary({ full_name, whatsapp, email, service, stage, ...fields }) {
  const SERVICE_NAMES = { website:'Website Development', mobile:'Mobile App Development', design:'Product Design', seo:'SEO Optimization' };
  const lines = [
    `Client Name: ${full_name}`,
    `WhatsApp: ${whatsapp}`,
    email ? `Email: ${email}` : null,
    `Service: ${SERVICE_NAMES[service] || service}`,
    `Stage: ${stage === 'enquiry' ? 'Making an enquiry' : 'Has paid'}`,
    '', 'Form Details:'
  ].filter(Boolean);

  Object.entries(fields).forEach(([key, value]) => {
    if (value && String(value).trim() && key !== 'submitted_at') {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      lines.push(`${label}: ${value}`);
    }
  });

  return lines.join('\n');
}

function buildInvoiceText({ full_name, email, whatsapp, service, budget, basePrice, chargeAmount, depositPercent, isFullPayment, isCustomBudget, paystackLink, enquiry_id }) {
  const SERVICE_NAMES = { website:'Website Development', mobile:'Mobile App Development', design:'Product Design', seo:'SEO Optimization' };
  const serviceName = SERVICE_NAMES[service] || service;
  const date = new Date().toLocaleDateString('en-NG', { day:'numeric', month:'long', year:'numeric' });
  const ref = `LWS-${enquiry_id.substring(0, 8).toUpperCase()}`;

  if (isCustomBudget || !basePrice) {
    return `LUMIEE WEB STUDIO — QUOTE REQUEST\nRef: ${ref}\nDate: ${date}\nClient: ${full_name}\nService: ${serviceName}\n\nThis project requires a custom quote. Lumiee Web Studio will reach out on WhatsApp to discuss your requirements and prepare a detailed invoice.\n\nWhatsApp: +2348143329373`;
  }

  const balance = basePrice - chargeAmount;
  const paymentStructure = isFullPayment
    ? `Full payment: NGN ${basePrice.toLocaleString()}`
    : `60% deposit now: NGN ${chargeAmount.toLocaleString()}\n40% balance on delivery: NGN ${balance.toLocaleString()}`;

  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LUMIEE WEB STUDIO — INVOICE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Invoice Ref: ${ref}
Date: ${date}

BILLED TO:
${full_name}
${email ? 'Email: ' + email + '\n' : ''}WhatsApp: ${whatsapp}

SERVICE:
${serviceName}
Package: ${budget}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOTAL PROJECT VALUE: NGN ${basePrice.toLocaleString()}

PAYMENT STRUCTURE:
${paymentStructure}

AMOUNT DUE NOW: NGN ${chargeAmount.toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${paystackLink ? `\nPAYMENT LINK:\n${paystackLink}\n` : ''}
After payment you will receive an onboarding form via email to provide all your project details. All further communication will be through WhatsApp at +2348143329373.

Thank you for choosing Lumiee Web Studio.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}