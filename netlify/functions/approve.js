import { supabase, logAgentAction } from './_lib/supabase.js';
import { sendEmail, notifyOwner } from './_lib/notify.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  // GET — fetch draft for approval page
  if (event.httpMethod === 'GET') {
    const token = event.queryStringParameters?.token;
    if (!token) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing token' }) };

    try {
      const { data: approval, error } = await supabase
        .from('approval_queue').select('*, enquiries(*)').eq('approval_token', token).single();

      if (error || !approval) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Approval not found' }) };

      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          success: true,
          approval: {
            id: approval.id,
            token: approval.approval_token,
            status: approval.status,
            draft_reply: approval.draft_reply,
            paystack_link: approval.paystack_link,
            enquiry: {
              id: approval.enquiries.id,
              full_name: approval.enquiries.full_name,
              email: approval.enquiries.email,
              whatsapp: approval.enquiries.whatsapp,
              service: approval.enquiries.service,
              stage: approval.enquiries.stage,
              form_data: approval.enquiries.form_data
            }
          }
        })
      };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // POST — process approval
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);
      const { token, action, edited_reply } = body;

      if (!token || !action) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing token or action' }) };

      const { data: approval, error } = await supabase
        .from('approval_queue').select('*, enquiries(*)').eq('approval_token', token).single();

      if (error || !approval) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Approval not found' }) };
      if (approval.status !== 'pending') return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Already processed' }) };

      const enquiry = approval.enquiries;
      const finalReply = (action === 'edit_and_approve' && edited_reply) ? edited_reply : approval.draft_reply;

      // rejection
      if (action === 'reject') {
        await supabase.from('approval_queue').update({ status: 'rejected', resolved_at: new Date().toISOString() }).eq('id', approval.id);
        await supabase.from('enquiries').update({ status: 'rejected' }).eq('id', enquiry.id);
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: 'Rejected' }) };
      }

      // approval
      if (!enquiry.email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Client has no email address' }) };

      const serviceName = SERVICE_NAMES[enquiry.service];
      const htmlContent = buildEmailHTML({ reply: finalReply, paystackLink: approval.paystack_link, serviceName, stage: enquiry.stage });

      const emailResult = await sendEmail({
        to_email: enquiry.email,
        to_name: enquiry.full_name,
        subject: enquiry.stage === 'enquiry'
          ? `Your ${serviceName} enquiry — Lumiee Web Studio`
          : `Welcome to Lumiee Web Studio — Your project is starting`,
        html_content: htmlContent,
        text_content: finalReply,
        enquiry_id: enquiry.id,
        recipient: 'client'
      });

      if (!emailResult.success) throw new Error(`Email failed: ${emailResult.error}`);

      await supabase.from('approval_queue').update({
        status: action === 'edit_and_approve' ? 'edited_and_approved' : 'approved',
        edited_reply: action === 'edit_and_approve' ? edited_reply : null,
        resolved_at: new Date().toISOString()
      }).eq('id', approval.id);

      await supabase.from('enquiries').update({
        status: 'reply_sent',
        approved_by_owner: true,
        approved_at: new Date().toISOString(),
        reply_sent_at: new Date().toISOString(),
        agent_reply: finalReply
      }).eq('id', enquiry.id);

      await notifyOwner({
        subject: `Reply sent to ${enquiry.full_name} — ${serviceName}`,
        message: `Your reply to ${enquiry.full_name} for ${serviceName} has been sent. Waiting for payment.`,
        enquiry_id: enquiry.id
      });

      await logAgentAction({ agent: 'intake', action: 'reply_sent_to_client', status: 'success', enquiry_id: enquiry.id, details: { action } });

      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, message: `Reply sent to ${enquiry.full_name}` }) };

    } catch (err) {
      console.error('Approve error:', err);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};

function buildEmailHTML({ reply, paystackLink, serviceName, stage }) {
  const replyHtml = reply.split('\n').filter(l => l.trim())
    .map(l => `<p style="margin:0 0 16px 0;line-height:1.7;color:#1a1a2e;font-size:16px;">${l}</p>`).join('');

  const paymentSection = stage === 'enquiry' && paystackLink ? `
    <div style="margin:32px 0;padding:28px;background:#fdf0f6;border-radius:12px;text-align:center;border:1px solid #f0c0d8;">
      <p style="margin:0 0 16px 0;font-weight:600;color:#050507;font-size:16px;">Ready to get started?</p>
      <a href="${paystackLink}" style="display:inline-block;background:#DD4290;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-weight:700;font-size:16px;">
        Make Payment
      </a>
      <p style="margin:12px 0 0 0;font-size:13px;color:#999;">Secure payment powered by Paystack</p>
    </div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:#050507;padding:28px 32px;">
      <span style="color:#fff;font-size:20px;font-weight:800;">Lumiee <span style="color:#DD4290;">Web Studio</span></span>
    </div>
    <div style="padding:36px 32px;">
      ${replyHtml}
      ${paymentSection}
    </div>
    <div style="padding:20px 32px;background:#f9f9f9;border-top:1px solid #eee;text-align:center;">
      <p style="margin:0;font-size:13px;color:#999;">Lumiee Web Studio &nbsp;|&nbsp; lumieewebstudio@gmail.com</p>
    </div>
  </div>
</body></html>`;
}