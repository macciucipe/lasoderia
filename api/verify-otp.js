export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { telefono, codigo } = req.body;
  if (!telefono || !codigo) return res.status(400).json({ error: 'Datos incompletos' });

  const numLimpio = telefono.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  const numWA = numLimpio.startsWith('+') ? numLimpio : `+51${numLimpio}`;

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;

  // Buscar código en Supabase
  const resp = await fetch(
    `${sbUrl}/rest/v1/otp_verificaciones?telefono=eq.${encodeURIComponent(numWA)}&select=codigo,expira`,
    {
      headers: {
        'apikey': sbKey,
        'Authorization': `Bearer ${sbKey}`
      }
    }
  );

  const registros = await resp.json();

  if (!registros || registros.length === 0) {
    return res.status(400).json({ error: 'No se encontró un código. Solicitá uno nuevo.' });
  }

  const registro = registros[0];

  if (new Date() > new Date(registro.expira)) {
    return res.status(400).json({ error: 'El código expiró. Solicitá uno nuevo.' });
  }

  if (registro.codigo !== codigo.trim()) {
    return res.status(400).json({ error: 'Código incorrecto. Verificá e intentá de nuevo.' });
  }

  // Eliminar el código usado
  await fetch(
    `${sbUrl}/rest/v1/otp_verificaciones?telefono=eq.${encodeURIComponent(numWA)}`,
    {
      method: 'DELETE',
      headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
    }
  );

  return res.status(200).json({ ok: true });
}
