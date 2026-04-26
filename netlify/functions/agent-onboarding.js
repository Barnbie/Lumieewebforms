import { supabase, logAgentAction } from './_lib/supabase.js';
import { notifyOwner, sendEmail } from './_lib/notify.js';

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
    const { enquiry_id } = body;

    if (!enquiry_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing enquiry_id' }) };

    console.log('Agent 3 started for enquiry:', enquiry_id);

    // ── Step 1: Fetch enquiry and client ──────────────
    const { data: enquiry, error: eErr } = await supabase
      .from('enquiries')
      .select('*')
      .eq('id', enquiry_id)
      .single();

    if (eErr || !enquiry) throw new Error('Enquiry not found');

    const { data: client, error: cErr } = await supabase
      .from('clients')
      .select('*')
      .eq('enquiry_id', enquiry_id)
      .single();

    if (cErr || !client) throw new Error('Client not found');

    const { data: project } = await supabase
      .from('projects')
      .select('*')
      .eq('enquiry_id', enquiry_id)
      .single();

    await logAgentAction({ agent: 'onboarding', action: 'started', status: 'success', enquiry_id, client_id: client.id });

    // ── Step 2: Generate project brief with Groq ──────
    console.log('Generating project brief...');
    let projectBrief = '';

    try {
      const { default: Groq } = await import('groq-sdk');
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const serviceName = SERVICE_NAMES[enquiry.service] || enquiry.service;
      const formData = { ...enquiry.form_data, ...(client.onboarding_data || {}) };

      const formSummary = Object.entries(formData)
        .filter(([k, v]) => v && String(v).trim())
        .map(([k, v]) => `${k.replace(/_/g,' ')}: ${v}`)
        .join('\n');

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are a project manager at Lumiee Web Studio. Create a clear, structured project brief based on client information. 
The brief should be professional and cover: project overview, goals, scope, deliverables, and any important notes.
Write in clear prose, no bullet points, use short paragraphs with clear headings.`
          },
          {
            role: 'user',
            content: `Create a project brief for this ${serviceName} project:\n\nClient: ${client.full_name}\nBusiness: ${client.business_name || 'N/A'}\nService: ${serviceName}\n\nProject Details:\n${formSummary}\n\nWrite a professional project brief covering the overview, goals, scope and key deliverables.`
          }
        ],
        temperature: 0.5,
        max_tokens: 1200
      });

      projectBrief = completion.choices[0]?.message?.content || '';
      console.log('Project brief generated, length:', projectBrief.length);

    } catch (groqErr) {
      console.error('Groq brief generation failed:', groqErr.message);
      projectBrief = `Project Brief — ${SERVICE_NAMES[enquiry.service]}\nClient: ${client.full_name}\nBusiness: ${client.business_name || 'N/A'}\n\nProject details have been collected and are ready for review. Please check the client onboarding form data for full information.`;
    }

    // ── Step 3: Update client as onboarded ────────────
    await supabase.from('clients').update({
      onboarding_complete: true,
      onboarding_data: enquiry.form_data || {},
      onboarded_at: new Date().toISOString(),
      business_name: enquiry.form_data?.business_name || client.business_name,
      brand_colors: enquiry.form_data?.brand_colors || null,
      brand_fonts: enquiry.form_data?.brand_fonts || null,
      social_handles: enquiry.form_data?.social_handles || null,
      has_logo: enquiry.form_data?.has_logo === 'Yes I will upload it'
    }).eq('id', client.id);

    // ── Step 4: Update project with brief and stage ───
    if (project) {
      await supabase.from('projects').update({
        stage: 'in_progress',
        project_brief: projectBrief,
        brief_generated_at: new Date().toISOString()
      }).eq('id', project.id);
    }

    // ── Step 5: Update enquiry status ─────────────────
    await supabase.from('enquiries').update({ status: 'onboarded' }).eq('id', enquiry_id);

    // ── Step 6: Notify owner ──────────────────────────
    const serviceName = SERVICE_NAMES[enquiry.service] || enquiry.service;
    const dashboardUrl = `${process.env.BASE_URL}/admin.html`;

    await notifyOwner({
      subject: `${client.full_name} has completed onboarding — ${serviceName} is ready to start`,
      message: `${client.full_name} has submitted their onboarding form. Project brief generated. Project moved to In Progress. Check your dashboard.`,
      html: `
        <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f4f4f8;">
          <div style="background:#050507;border-radius:12px;padding:24px 28px;margin-bottom:20px;">
            <span style="color:#fff;font-size:18px;font-weight:800;">Lumiee <span style="color:#DD4290;">Web Studio</span></span>
          </div>
          <div style="background:#fff;border-radius:12px;padding:28px;">
            <h2 style="margin:0 0 16px;color:#050507;font-size:20px;">Onboarding Complete</h2>
            <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Client:</strong> ${client.full_name}</p>
            <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Service:</strong> ${serviceName}</p>
            <p style="color:#444;font-size:16px;margin:0 0 8px;"><strong>Business:</strong> ${client.business_name || 'N/A'}</p>
            <p style="color:#444;font-size:16px;margin:0 0 24px;">The client has filled their onboarding form. A project brief has been generated and the project is now In Progress.</p>
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:24px;">
              <p style="color:#166534;font-size:14px;font-weight:600;margin:0 0 8px;">Project Brief Summary</p>
              <p style="color:#166534;font-size:14px;margin:0;line-height:1.6;">${projectBrief.substring(0, 300)}...</p>
            </div>
            <a href="${dashboardUrl}" style="display:inline-block;background:#DD4290;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;">Open Dashboard</a>
          </div>
        </div>`,
      enquiry_id,
      client_id: client.id
    });

    // ── Step 7: Send welcome email to client ─────────
    const clientEmail = client.email;
    if (clientEmail) {
      const firstName = client.full_name.split(' ')[0];
      await sendEmail({
        to_email: clientEmail,
        to_name: client.full_name,
        subject: `Welcome to Lumiee Web Studio — Here is what you need to send us`,
        html_content: `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
            <div style="background:#050507;padding:28px 32px;">
              <span style="color:#fff;font-size:20px;font-weight:800;">Lumiee <span style="color:#DD4290;">Web Studio</span></span>
            </div>
            <div style="padding:36px 32px;">
              <h2 style="margin:0 0 16px;color:#050507;font-size:22px;">You are all set, ${firstName}!</h2>
              <p style="color:#444;font-size:16px;line-height:1.75;margin:0 0 16px;">Thank you for completing your onboarding form. Your project is now active and we are ready to get started.</p>
              <p style="color:#444;font-size:16px;line-height:1.75;margin:0 0 24px;">All further communication will be through <strong>WhatsApp</strong>. Please reach out to us at <strong>+2348143329373</strong> and we will continue the conversation there.</p>

              <div style="background:#f8f8fc;border-radius:12px;padding:24px;margin-bottom:24px;">
                <p style="color:#050507;font-size:16px;font-weight:700;margin:0 0 16px;">To get started, please send the following via WhatsApp:</p>

                <p style="color:#444;font-size:15px;font-weight:600;margin:0 0 8px;">For your website:</p>
                <p style="color:#666;font-size:14px;line-height:1.75;margin:0 0 16px;">Your website content (text for each page), images you want used, your logo file (PNG or SVG preferred), and your brand colors and fonts if you have them.</p>

                <p style="color:#444;font-size:15px;font-weight:600;margin:0 0 8px;">For your Paystack account setup:</p>
                <p style="color:#666;font-size:14px;line-height:1.75;margin:0 0 16px;">If you need a Paystack payment gateway on your site, you will need to provide the following documents. These are required by Paystack for account verification:</p>

                <div style="background:#fff;border-radius:8px;padding:16px;border:1px solid #e8e8f0;">
                  <p style="color:#444;font-size:14px;margin:0 0 8px;"><strong>Business registration certificate</strong> (CAC documents if registered)</p>
                  <p style="color:#444;font-size:14px;margin:0 0 8px;"><strong>Tax identification number</strong> (TIN certificate)</p>
                  <p style="color:#444;font-size:14px;margin:0 0 8px;"><strong>Address verification</strong> — a recent utility bill or bank statement showing your address</p>
                  <p style="color:#444;font-size:14px;margin:0 0 8px;"><strong>Your business email address</strong></p>
                  <p style="color:#444;font-size:14px;margin:0;"><strong>Your business phone number</strong></p>
                </div>
                <p style="color:#999;font-size:12px;margin:10px 0 0;line-height:1.6;">Note: If your business is not registered, Paystack also accepts personal verification documents. We will guide you through this on WhatsApp.</p>
              </div>

              <p style="color:#444;font-size:16px;line-height:1.75;margin:0 0 24px;">Once we receive everything, we will get to work immediately. We are excited to build something great with you.</p>

              <a href="https://wa.me/2348143329373" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;">Chat with us on WhatsApp</a>
            </div>
            <div style="padding:20px 32px;background:#f9f9f9;border-top:1px solid #eee;text-align:center;">
              <p style="margin:0;font-size:13px;color:#999;">Lumiee Web Studio &nbsp;|&nbsp; lumieewebstudio@gmail.com &nbsp;|&nbsp; wa.me/2348143329373</p>
            </div>
          </div>`,
        text_content: `Hi ${firstName}, your onboarding is complete. All further communication will be via WhatsApp at +2348143329373. Please send your website content, images, logo, and Paystack documents (business registration, TIN, utility bill, email and phone number) via WhatsApp to get started.`,
        enquiry_id,
        client_id: client.id,
        recipient: 'client'
      });
      console.log('Welcome email sent to client');
    }

    await logAgentAction({ agent: 'onboarding', action: 'completed', status: 'success', enquiry_id, client_id: client.id, details: { brief_length: projectBrief.length } });

    console.log('Agent 3 completed successfully');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.error('Agent 3 error:', err.message);
    await logAgentAction({ agent: 'onboarding', action: 'failed', status: 'error', error_message: err.message });
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};