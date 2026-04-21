import Groq from 'groq-sdk';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { supabase, logAgentAction } from './_lib/supabase.js';
import { notifyOwner } from './_lib/termii.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SERVICE_NAMES = {
  website: 'Website Development',
  mobile: 'Mobile App Development',
  design: 'Product Design',
  seo: 'SEO Optimization'
};

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

  let enquiry_id;
  try {
    const body = JSON.parse(event.body);
    enquiry_id = body.enquiry_id;
    if (!enquiry_id) return { statusCode: 400, body: JSON.stringify({ error: 'Missing enquiry_id' }) };

    // fetch enquiry
    const { data: enquiry, error: fetchError } = await supabase
      .from('enquiries').select('*').eq('id', enquiry_id).single();
    if (fetchError || !enquiry) throw new Error(`Could not fetch enquiry: ${fetchError?.message}`);

    await logAgentAction({ agent: 'intake', action: 'started', status: 'success', enquiry_id, details: { service: enquiry.service, stage: enquiry.stage } });

    await supabase.from('enquiries').update({ status: 'processing' }).eq('id', enquiry_id);

    // build form summary
    const formSummary = buildFormSummary(enquiry);

    // generate AI reply
    const aiReply = await generateReply(enquiry, formSummary);
    await logAgentAction({ agent: 'intake', action: 'reply_generated', status: 'success', enquiry_id, details: { reply_length: aiReply.length } });

    // create Paystack link if enquiry with known price
    let paystackLink = null;
    let paystackAmount = null;

    if (enquiry.stage === 'enquiry') {
      const priceResult = determinePrice(enquiry);
      paystackAmount = priceResult.amount;
      if (paystackAmount) {
        const linkResult = await createPaystackLink({
          enquiry_id,
          full_name: enquiry.full_name,
          email: enquiry.email || `${enquiry.full_name.replace(/\s+/g, '').toLowerCase()}@client.lumiee`,
          amount: paystackAmount,
          service: SERVICE_NAMES[enquiry.service]
        });
        paystackLink = linkResult.link;
      }
    }

    // generate approval token
    const approvalToken = uuidv4();

    // save to approval queue
    const { error: approvalError } = await supabase.from('approval_queue').insert({
      enquiry_id,
      draft_reply: aiReply,
      paystack_link: paystackLink,
      status: 'pending',
      approval_token: approvalToken
    });
    if (approvalError) throw new Error(`Approval queue error: ${approvalError.message}`);

    // update enquiry
    await supabase.from('enquiries').update({
      status: 'awaiting_approval',
      agent_reply: aiReply,
      paystack_link: paystackLink,
      paystack_amount: paystackAmount ? paystackAmount * 100 : null
    }).eq('id', enquiry_id);

    // notify owner via SMS
    const approvalUrl = `${process.env.BASE_URL}/admin.html?approve=${approvalToken}`;
    const smsMessage =
      `New ${enquiry.stage === 'enquiry' ? 'enquiry' : 'onboarding'} from ${enquiry.full_name}\n` +
      `Service: ${SERVICE_NAMES[enquiry.service]}\n` +
      `Draft reply ready. Review and approve:\n${approvalUrl}`;

    await notifyOwner({ message: smsMessage, enquiry_id });
    await logAgentAction({ agent: 'intake', action: 'owner_notified', status: 'success', enquiry_id, details: { approval_token: approvalToken } });

    return { statusCode: 200, body: JSON.stringify({ success: true, approval_token: approvalToken }) };

  } catch (err) {
    console.error('Agent 1 error:', err);
    if (enquiry_id) {
      await supabase.from('enquiries').update({ status: 'error' }).eq('id', enquiry_id);
      await logAgentAction({ agent: 'intake', action: 'failed', status: 'error', enquiry_id, error_message: err.message });
    }
    return { statusCode: 500, body: JSON.stringify({ error: 'Agent 1 failed', details: err.message }) };
  }
};

function buildFormSummary(enquiry) {
  const data = enquiry.form_data || {};
  const lines = [
    `Client Name: ${enquiry.full_name}`,
    `WhatsApp: ${enquiry.whatsapp}`,
    enquiry.email ? `Email: ${enquiry.email}` : null,
    `Service: ${SERVICE_NAMES[enquiry.service]}`,
    `Stage: ${enquiry.stage === 'enquiry' ? 'Making an enquiry' : 'Has paid'}`,
    '',
    'Form Details:'
  ].filter(Boolean);

  Object.entries(data).forEach(([key, value]) => {
    if (value && String(value).trim()) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      lines.push(`${label}: ${value}`);
    }
  });

  return lines.join('\n');
}

async function generateReply(enquiry, formSummary) {
  const isEnquiry = enquiry.stage === 'enquiry';
  const serviceName = SERVICE_NAMES[enquiry.service];

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content: `You are the AI assistant for Lumiee Web Studio, a professional web development, mobile development, product design and SEO studio based in Nigeria.
Your job is to write a warm, professional and personalised email reply to a client who submitted a form.
Writing style: warm but professional, confident, clear, no jargon, address client by first name, no hyphens connecting words, short paragraphs, no bullet points in the body.
${isEnquiry
  ? 'This client is making an enquiry and has not paid. Reply should address their needs, build confidence, and guide them toward payment. Mention an invoice is attached.'
  : 'This client has paid. Reply should warmly welcome them, confirm their project is active, and explain next steps.'}`
      },
      {
        role: 'user',
        content: `Write a professional email reply for this submission:\n\n${formSummary}\n\nStart with "Hi [First Name]," and end with a sign off from Lumiee Web Studio. No subject line, just the email body.`
      }
    ],
    temperature: 0.7,
    max_tokens: 1000
  });

  return completion.choices[0]?.message?.content || 'Could not generate reply.';
}

function determinePrice(enquiry) {
  const budget = enquiry.form_data?.budget_range || '';
  if (enquiry.service === 'website') {
    if (budget.includes('150,000')) return { amount: 150000 };
    if (budget.includes('300,000')) return { amount: 300000 };
  }
  return { amount: null };
}

async function createPaystackLink({ enquiry_id, full_name, email, amount, service }) {
  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100,
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
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' } }
    );
    return { link: response.data.data.authorization_url };
  } catch (err) {
    console.error('Paystack link failed:', err?.response?.data || err.message);
    return { link: null };
  }
}
