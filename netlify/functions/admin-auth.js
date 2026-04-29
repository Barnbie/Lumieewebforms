// netlify/functions/admin-auth.js
// Handles admin login securely
// Password lives in Netlify environment variables, never in frontend code

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
    const { password } = JSON.parse(event.body);
    const correctPassword = process.env.ADMIN_PASSWORD;

    if (!correctPassword) {
      console.error('ADMIN_PASSWORD environment variable is not set');
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error' }) };
    }

    if (!password || password !== correctPassword) {
      // small delay to slow down brute force attempts
      await new Promise(r => setTimeout(r, 500));
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Incorrect password' }) };
    }

    // generate a simple session token
    // this token is stored in sessionStorage on the frontend
    const token = Buffer.from(`lws-${Date.now()}-${Math.random().toString(36)}`).toString('base64');

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, token })
    };

  } catch (err) {
    console.error('Auth error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Something went wrong' }) };
  }
};