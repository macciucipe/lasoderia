export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: 'Teléfono requerido' });

  const numLimpio = telefono.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  const numWA = numLimpio.startsWith('+') ? numLimpio : `+51${numLimpio}`;
  const codigo = Math.floor(100000 + Math.random() * 900000).toString();
  const expira = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Guardar código en Supabase
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;

  const upsert = await fetch(`${sbUrl}/rest/v1/otp_verificaciones`, {
    method: 'POST',
    headers: {
      'apikey': sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ telefono: numWA, codigo, expira })
  });

  if (!upsert.ok) {
    const err = await upsert.text();
    console.error('Supabase error:', err);
    return res.status(500).json({ error: 'Error guardando código' });
  }

  // Enviar por WhatsApp usando template de autenticación
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const contentSid = process.env.TWILIO_OTP_TEMPLATE_SID;

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: from,
        To: `whatsapp:${numWA}`,
        ContentSid: contentSid,
        ContentVariables: JSON.stringify({ 1: codigo }),
      }),
    }
  );

  const data = await response.json();
  if (data.error_code) {
    console.error('Twilio error:', data);
    return res.status(400).json({ error: 'No se pudo enviar el mensaje. Verificá el número.' });
  }

  return res.status(200).json({ ok: true });
}
