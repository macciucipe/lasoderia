const otps = {};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.lasoderia.pe');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { telefono, codigo } = req.body;
  if (!telefono || !codigo) return res.status(400).json({ error: 'Datos incompletos' });

  const numLimpio = telefono.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  const numWA = numLimpio.startsWith('+') ? numLimpio : `+51${numLimpio}`;

  const registro = otps[numWA];

  if (!registro) {
    return res.status(400).json({ error: 'No se encontró un código para este número. Solicitá uno nuevo.' });
  }

  if (Date.now() > registro.expira) {
    delete otps[numWA];
    return res.status(400).json({ error: 'El código expiró. Solicitá uno nuevo.' });
  }

  if (registro.codigo !== codigo.trim()) {
    return res.status(400).json({ error: 'Código incorrecto. Verificá e intentá de nuevo.' });
  }

  delete otps[numWA];
  return res.status(200).json({ ok: true, mensaje: 'Teléfono verificado correctamente' });
}
