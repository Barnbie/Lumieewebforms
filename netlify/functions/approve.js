// netlify/functions/approve.js
// Handles the approval flow
// When you tap the approval link in your SMS, this function:
// 1. Fetches the draft from the approval queue
// 2. If approved, sends the reply + invoice to the client via Brevo email
// 3. Updates all statuses in Supabase
// 4. Sends you a confirmation SMS

import { supabase, logAgentAction } from './_lib/supabase.js';
import { sendEmail } from './_lib/notify.js';
import { notifyOwner } from './_lib/termii.js';

const SERVICE_NAMES = {
  website: 'Website Development',
  mobile: 'Mobile App Development',
  design: 'Product Design',
  seo: 'SEO Optimization'
};

export const handler = async (event) => {

  // ── GET: fetch draft for the approval page ────────
  if (event.httpMethod === 'GET') {
    const token = event.queryStringParameters?.token;

    if (!token) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing token' }) };
    }

    try {
      const { data: approval, error } = await supabase
        .from('approval_queue')
        .select('*, enquiries(*)')
        .eq('approval_token', token)
        .single();

      if (error || !approval) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Approval not found' }) };
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
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
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST: process the approval or rejection ───────
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);
      const { token, action, edited_reply } = body;
      // action: 'approve' | 'edit_and_approve' | 'reject'

      if (!token || !action) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing token or action' }) };
      }

      // fetch approval + enquiry
      const { data: approval, error } = await supabase
        .from('approval_queue')
        .select('*, enquiries(*)')
        .eq('approval_token', token)
        .single();

      if (error || !approval) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Approval not found' }) };
      }

      if (approval.status !== 'pending') {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'This approval has already been processed' })
        };
      }

      const enquiry = approval.enquiries;
      const finalReply = action === 'edit_and_approve' && edited_reply
        ? edited_reply
        : approval.draft_reply;

      // ── Handle rejection ────────────────────────
      if (action === 'reject') {
        await supabase
          .from('approval_queue')
          .update({ status: 'rejected', resolved_at: new Date().toISOString() })
          .eq('id', approval.id);

        await supabase
          .from('enquiries')
          .update({ status: 'rejected' })
          .eq('id', enquiry.id);

        return {
          statusCode: 200,
          body: JSON.stringify({ success: true, message: 'Enquiry rejected' })
        };
      }

      // ── Handle approval ─────────────────────────
      const clientEmail = enquiry.email;
      const serviceName = SERVICE_NAMES[enquiry.service];
      const firstName = enquiry.full_name.split(' ')[0];

      if (!clientEmail) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Client has no email address to send to' })
        };
      }

      // build HTML email
      const htmlContent = buildEmailHTML({
        reply: finalReply,
        paystackLink: approval.paystack_link,
        clientName: firstName,
        serviceName,
        stage: enquiry.stage
      });

      // send email to client via Brevo
      const emailResult = await sendEmail({
        to_email: clientEmail,
        to_name: enquiry.full_name,
        subject: enquiry.stage === 'enquiry'
          ? `Your ${serviceName} enquiry — Lumiee Web Studio`
          : `Welcome to Lumiee Web Studio — Your project is starting`,
        html_content: htmlContent,
        text_content: finalReply,
        enquiry_id: enquiry.id,
        recipient: 'client'
      });

      if (!emailResult.success) {
        throw new Error(`Email send failed: ${emailResult.error}`);
      }

      // update approval queue
      await supabase
        .from('approval_queue')
        .update({
          status: action === 'edit_and_approve' ? 'edited_and_approved' : 'approved',
          edited_reply: action === 'edit_and_approve' ? edited_reply : null,
          resolved_at: new Date().toISOString()
        })
        .eq('id', approval.id);

      // update enquiry
      await supabase
        .from('enquiries')
        .update({
          status: 'reply_sent',
          approved_by_owner: true,
          approved_at: new Date().toISOString(),
          reply_sent_at: new Date().toISOString(),
          agent_reply: finalReply
        })
        .eq('id', enquiry.id);

      // notify owner via SMS
      await notifyOwner({
        message: `Reply sent to ${enquiry.full_name} for ${serviceName}. Waiting for payment.`,
        enquiry_id: enquiry.id
      });

      await logAgentAction({
        agent: 'intake',
        action: 'reply_sent_to_client',
        status: 'success',
        enquiry_id: enquiry.id,
        details: { action, client_email: clientEmail }
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          message: `Reply sent to ${enquiry.full_name} at ${clientEmail}`
        })
      };

    } catch (err) {
      console.error('Approve function error:', err);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: err.message })
      };
    }
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};

// ═══════════════════════════════════════════════════
// EMAIL HTML BUILDER
// ═══════════════════════════════════════════════════

function buildEmailHTML({ reply, paystackLink, clientName, serviceName, stage }) {
  const replyHtml = reply
    .split('\n')
    .filter(line => line.trim())
    .map(line => `<p style="margin:0 0 16px 0;line-height:1.7;">${line}</p>`)
    .join('');

  const paymentSection = stage === 'enquiry' && paystackLink ? `
    <div style="margin:32px 0;padding:24px;background:#f9f9f9;border-radius:12px;text-align:center;">
      <p style="margin:0 0 16px 0;font-weight:600;color:#050507;">Ready to get started?</p>
      <a href="${paystackLink}"
         style="display:inline-block;background:#DD4290;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:16px;">
        Make Payment
      </a>
      <p style="margin:12px 0 0 0;font-size:13px;color:#888;">Secure payment powered by Paystack</p>
    </div>
  ` : '';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f4f8;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <!-- header -->
    <div style="background:#050507;padding:28px 32px;display:flex;align-items:center;">
      <div style="width:36px;height:36px;background:#111118;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;margin-right:12px;">
        <span style="color:#DD4290;font-weight:800;font-size:18px;">L</span>
      </div>
      <span style="color:#ffffff;font-size:18px;font-weight:700;">Lumiee <span style="color:#DD4290;">Web Studio</span></span>
    </div>

    <!-- body -->
    <div style="padding:36px 32px;color:#050507;font-size:16px;">
      ${replyHtml}
      ${paymentSection}
    </div>

    <!-- footer -->
    <div style="padding:24px 32px;background:#f9f9f9;border-top:1px solid #eee;text-align:center;">
      <p style="margin:0;font-size:13px;color:#999;">
        Lumiee Web Studio &nbsp;|&nbsp; ${process.env.OWNER_EMAIL || 'lumieewebstudio@gmail.com'}
      </p>
    </div>

  </div>
</body>
</html>`;
}
