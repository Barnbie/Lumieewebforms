// netlify/functions/agent-intake.js
// AGENT 1 — THE INTAKE AGENT
//
// Triggered automatically when a form is submitted
// This agent:
// 1. Reads the full form submission from Supabase
// 2. Uses Groq AI to write a personalised reply
// 3. Generates an invoice with Paystack payment link
// 4. Saves everything to the approval queue
// 5. Sends you an SMS with a link to review and approve

import Groq from 'groq-sdk';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { supabase, logAgentAction } from './_lib/supabase.js';
import { notifyOwner } from './_lib/termii.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Service display names ───────────────────────────
const SERVICE_NAMES = {
  website: 'Website Development',
  mobile: 'Mobile App Development',
  design: 'Product Design',
  seo: 'SEO Optimization'
};

// ── Base prices in Naira ────────────────────────────
const SERVICE_PRICES = {
  website: {
    '150,000 Naira (Starter site)': 150000,
    '300,000 Naira (Standard site)': 300000,
    'Custom budget (let us discuss)': null
  },
  mobile: null,
  design: null,
  seo: null
};

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let enquiry_id;

  try {
    const body = JSON.parse(event.body);
    enquiry_id = body.enquiry_id;

    if (!enquiry_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing enquiry_id' }) };
    }

    // ── Step 1: Fetch the enquiry from Supabase ──────
    const { data: enquiry, error: fetchError } = await supabase
      .from('enquiries')
      .select('*')
      .eq('id', enquiry_id)
      .single();

    if (fetchError || !enquiry) {
      throw new Error(`Could not fetch enquiry: ${fetchError?.message}`);
    }

    await logAgentAction({
      agent: 'intake',
      action: 'started',
      status: 'success',
      enquiry_id,
      details: { service: enquiry.service, stage: enquiry.stage }
    });

    // ── Step 2: Update status to processing ──────────
    await supabase
      .from('enquiries')
      .update({ status: 'processing' })
      .eq('id', enquiry_id);

    // ── Step 3: Build context for the AI ─────────────
    const formSummary = buildFormSummary(enquiry);

    // ── Step 4: Generate reply with Groq AI ──────────
    const aiReply = await generateReply(enquiry, formSummary);

    await logAgentAction({
      agent: 'intake',
      action: 'reply_generated',
      status: 'success',
      enquiry_id,
      details: { reply_length: aiReply.length }
    });

    // ── Step 5: Create Paystack payment link ──────────
    let paystackLink = null;
    let paystackAmount = null;

    if (enquiry.stage === 'enquiry') {
      const priceResult = determinePrice(enquiry);
      paystackAmount = priceResult.amount;

      if (paystackAmount) {
        const linkResult = await createPaystackLink({
          enquiry_id,
          full_name: enquiry.full_name,
          email: enquiry.email || `${enquiry.full_name.replace(/\s+/g, '').toLowerCase()}@lumiee.client`,
          amount: paystackAmount,
          service: SERVICE_NAMES[enquiry.service]
        });
        paystackLink = linkResult.link;
      }
    }

    // ── Step 6: Generate unique approval token ────────
    const approvalToken = uuidv4();

    // ── Step 7: Build invoice text ────────────────────
    const invoiceText = buildInvoiceText({
      enquiry,
      paystackLink,
      paystackAmount
    });

    // ── Step 8: Save to approval queue ───────────────
    const { data: approval, error: approvalError } = await supabase
      .from('approval_queue')
      .insert({
        enquiry_id,
        draft_reply: aiReply,
        invoice_url: null,
        paystack_link: paystackLink,
        status: 'pending',
        approval_token: approvalToken
      })
      .select()
      .single();

    if (approvalError) throw new Error(`Approval queue insert failed: ${approvalError.message}`);

    // ── Step 9: Update enquiry status ─────────────────
    await supabase
      .from('enquiries')
      .update({
        status: 'awaiting_approval',
        agent_reply: aiReply,
        paystack_link: paystackLink,
        paystack_amount: paystackAmount ? paystackAmount * 100 : null
      })
      .eq('id', enquiry_id);

    // ── Step 10: Notify owner via SMS ─────────────────
    const approvalUrl = `${process.env.BASE_URL}/admin.html?approve=${approvalToken}`;
    const serviceName = SERVICE_NAMES[enquiry.service];

    const smsMessage =
      `New ${enquiry.stage === 'enquiry' ? 'enquiry' : 'onboarding'} from ${enquiry.full_name}\n` +
      `Service: ${serviceName}\n` +
      `Agent has drafted a reply and invoice.\n` +
      `Review and approve here:\n${approvalUrl}`;

    await notifyOwner({
      message: smsMessage,
      enquiry_id
    });

    await logAgentAction({
      agent: 'intake',
      action: 'owner_notified',
      status: 'success',
      enquiry_id,
      details: { approval_token: approvalToken }
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'Agent 1 completed successfully',
        approval_token: approvalToken
      })
    };

  } catch (err) {
    console.error('Agent 1 error:', err);

    if (enquiry_id) {
      await supabase
        .from('enquiries')
        .update({ status: 'error' })
        .eq('id', enquiry_id);

      await logAgentAction({
        agent: 'intake',
        action: 'failed',
        status: 'error',
        enquiry_id,
        error_message: err.message
      });
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Agent 1 failed', details: err.message })
    };
  }
};

// ═══════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════

function buildFormSummary(enquiry) {
  const data = enquiry.form_data || {};
  const lines = [];

  lines.push(`Client Name: ${enquiry.full_name}`);
  lines.push(`WhatsApp: ${enquiry.whatsapp}`);
  if (enquiry.email) lines.push(`Email: ${enquiry.email}`);
  lines.push(`Service: ${SERVICE_NAMES[enquiry.service]}`);
  lines.push(`Stage: ${enquiry.stage === 'enquiry' ? 'Making an enquiry' : 'Has paid'}`);
  lines.push('');
  lines.push('Form Details:');

  Object.entries(data).forEach(([key, value]) => {
    if (value && value.trim()) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      lines.push(`${label}: ${value}`);
    }
  });

  return lines.join('\n');
}

async function generateReply(enquiry, formSummary) {
  const isEnquiry = enquiry.stage === 'enquiry';
  const serviceName = SERVICE_NAMES[enquiry.service];

  const systemPrompt = `You are the AI assistant for Lumiee Web Studio, a professional web development, mobile development, product design and SEO studio based in Nigeria. 

Your job is to write a warm, professional and personalised email reply to a client who has just submitted a form.

Owner name: Lumiee Web Studio
Services offered: Website Development, Mobile App Development, Product Design, SEO Optimization

Writing style:
- Warm but professional
- Confident and knowledgeable
- Clear and easy to understand
- No jargon unless necessary
- Address the client by their first name
- Do not use hyphens to connect words
- Write in a way that feels personal, not templated
- Keep paragraphs short and readable
- Do not use bullet points in the email body, write in flowing prose

${isEnquiry
  ? 'This client is making an enquiry and has not paid yet. Your reply should answer their questions, explain the service clearly, build confidence in Lumiee Web Studio, and guide them toward making payment. An invoice will be attached separately.'
  : 'This client has already made payment. Your reply should welcome them warmly, confirm their project is now active, explain the next steps clearly, and let them know the team will be in touch to kick things off.'}`;

  const userPrompt = `Write a professional email reply for this client submission:

${formSummary}

${isEnquiry
  ? 'Write a reply that addresses their specific project needs, explains what Lumiee Web Studio will deliver, gives them confidence, and lets them know an invoice is attached with payment details.'
  : 'Write a warm welcome email confirming their project has started, summarising what was submitted, and outlining the next steps.'}

Start directly with "Hi [First Name]," and end with a professional sign off from Lumiee Web Studio. Do not add a subject line, just the email body.`;

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 1000
  });

  return completion.choices[0]?.message?.content || 'Could not generate reply.';
}

function determinePrice(enquiry) {
  const data = enquiry.form_data || {};
  const budget = data.budget_range || '';

  if (enquiry.service === 'website') {
    const prices = SERVICE_PRICES.website;
    for (const [key, value] of Object.entries(prices)) {
      if (budget.includes(key.split(' ')[0]) && value) {
        return { amount: value };
      }
    }
  }

  return { amount: null };
}

async function createPaystackLink({ enquiry_id, full_name, email, amount, service }) {
  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100, // convert to kobo
        currency: 'NGN',
        reference: `LWS-${enquiry_id.substring(0, 8).toUpperCase()}`,
        metadata: {
          enquiry_id,
          full_name,
          service,
          custom_fields: [
            { display_name: 'Client Name', variable_name: 'full_name', value: full_name },
            { display_name: 'Service', variable_name: 'service', value: service }
          ]
        },
        callback_url: `${process.env.BASE_URL}/api/paystack-webhook`
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      link: response.data.data.authorization_url,
      reference: response.data.data.reference
    };
  } catch (err) {
    console.error('Paystack link creation failed:', err?.response?.data || err.message);
    return { link: null, reference: null };
  }
}

function buildInvoiceText({ enquiry, paystackLink, paystackAmount }) {
  const serviceName = SERVICE_NAMES[enquiry.service];
  const date = new Date().toLocaleDateString('en-NG', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  let text = `INVOICE\n`;
  text += `Lumiee Web Studio\n`;
  text += `Date: ${date}\n`;
  text += `Client: ${enquiry.full_name}\n`;
  text += `Service: ${serviceName}\n\n`;

  if (paystackAmount) {
    text += `Amount Due: NGN ${paystackAmount.toLocaleString()}\n\n`;
    text += `Payment Link: ${paystackLink || 'To be provided'}\n\n`;
  } else {
    text += `Amount: To be discussed\n\n`;
  }

  text += `Thank you for choosing Lumiee Web Studio.`;
  return text;
}
