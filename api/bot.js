// api/bot.js — Bot de WhatsApp para La Sodería ATR
// Sesiones persistidas en Supabase (tabla: bot_sesiones)

const PRECIO_SIFON = 6.00;
const PRECIO_CAJON = 5.50; // por sifón cuando es cajón completo (6)
const PRECIO_ENVIO = 5.00;
const SIFONES_POR_CAJON = 6;

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// ─────────────────────────────────────────────
// HELPERS GENERALES
// ─────────────────────────────────────────────

function calcularPrecio(cantidad) {
  if (cantidad % SIFONES_POR_CAJON === 0) {
    return cantidad * PRECIO_CAJON;
  }
  const cajones = Math.floor(cantidad / SIFONES_POR_CAJON);
  const sueltos = cantidad % SIFONES_POR_CAJON;
  return (cajones * SIFONES_POR_CAJON * PRECIO_CAJON) + (sueltos * PRECIO_SIFON);
}

function formatearPrecio(n) {
  return `S/ ${n.toFixed(2)}`;
}

function twimlResponse(mensaje) {
  // Escapar caracteres XML para evitar romper el TwiML
  const escapado = mensaje
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapado}</Message>\n</Response>`;
}

// ─────────────────────────────────────────────
// SUPABASE — cliente HTTP liviano (sin SDK)
// ─────────────────────────────────────────────

function sb(sbUrl, sbKey) {
  const headers = {
    'apikey': sbKey,
    'Authorization': `Bearer ${sbKey}`,
    'Content-Type': 'application/json',
  };

  return {
    async get(tabla, query = '') {
      const r = await fetch(`${sbUrl}/rest/v1/${tabla}${query ? '?' + query : ''}`, { headers });
      if (!r.ok) throw new Error(`GET ${tabla}: ${await r.text()}`);
      return r.json();
    },
    async post(tabla, body, prefer = '') {
      const h = { ...headers };
      if (prefer) h['Prefer'] = prefer;
      const r = await fetch(`${sbUrl}/rest/v1/${tabla}`, {
        method: 'POST', headers: h, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`POST ${tabla}: ${await r.text()}`);
      return prefer.includes('return=representation') ? r.json() : null;
    },
    async patch(tabla, query, body) {
      const r = await fetch(`${sbUrl}/rest/v1/${tabla}?${query}`, {
        method: 'PATCH', headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`PATCH ${tabla}: ${await r.text()}`);
    },
    async upsert(tabla, body, onConflict) {
      const h = { ...headers, 'Prefer': 'resolution=merge-duplicates' };
      const url = `${sbUrl}/rest/v1/${tabla}${onConflict ? `?on_conflict=${onConflict}` : ''}`;
      const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`UPSERT ${tabla}: ${await r.text()}`);
    },
    async rpc(fn, body) {
      const r = await fetch(`${sbUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`RPC ${fn}: ${await r.text()}`);
      return r.json();
    },
  };
}

// ─────────────────────────────────────────────
// SESIONES EN SUPABASE
// Tabla: bot_sesiones (telefono TEXT PK, datos JSONB, actualizado_en TIMESTAMPTZ)
// ─────────────────────────────────────────────

async function getSesion(api, telefono) {
  const rows = await api.get('bot_sesiones', `telefono=eq.${encodeURIComponent(telefono)}&select=datos`);
  return rows.length > 0 ? rows[0].datos : { paso: 'menu' };
}

async function setSesion(api, telefono, datos) {
  await api.upsert('bot_sesiones', {
    telefono,
    datos,
    actualizado_en: new Date().toISOString(),
  }, 'telefono');
}

// ─────────────────────────────────────────────
// TWILIO — enviar mensaje saliente
// ─────────────────────────────────────────────

async function enviarMensaje(accountSid, authToken, from, to, body) {
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }),
    }
  );
  const data = await r.json();
  if (data.error_code) console.error('Twilio error:', data);
  return data;
}

// ─────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method !== 'POST') {
    return res.status(405).send(twimlResponse('Método no permitido'));
  }

  const body = req.body;
  const telefono = (body.From || '').replace('whatsapp:', '').trim();
  const mensaje = (body.Body || '').trim();

  if (!telefono) {
    return res.send(twimlResponse('Error: teléfono no recibido'));
  }

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromWA = process.env.TWILIO_WHATSAPP_FROM;

  const api = sb(sbUrl, sbKey);

  // ── Buscar cliente por teléfono ──
  let cliente = null;
  try {
    const clientes = await api.rpc('buscar_cliente', { q: telefono.replace('+', '') });
    cliente = Array.isArray(clientes) && clientes.length > 0 ? clientes[0] : null;
  } catch (e) {
    console.error('Error buscando cliente:', e);
  }

  // ── Cliente no registrado ──
  if (!cliente) {
    return res.send(twimlResponse(
      `¡Hola! 👋 Aún no estás registrado como cliente de *La Sodería ATR*.\n\n` +
      `Para comenzar a recibir soda fresca en sifones, registrate acá:\n` +
      `🔗 lasoderia.pe/registro.html\n\n` +
      `Una vez aprobada tu cuenta, podés pedir cuando quieras por este chat. 🥤`
    ));
  }

  // ── Cliente pendiente de aprobación ──
  if (cliente.estado === 'pendiente') {
    return res.send(twimlResponse(
      `Hola ${cliente.nombre}! 👋\n\n` +
      `Tu cuenta está siendo verificada. En menos de 24 horas te confirmamos la activación.\n\n` +
      `¿Tenés alguna duda? Respondé este mensaje y te ayudamos.`
    ));
  }

  // ── Cliente suspendido ──
  if (cliente.estado !== 'activo') {
    return res.send(twimlResponse(
      `Hola ${cliente.nombre}! Tu cuenta está suspendida en este momento.\n\n` +
      `Para más información escribinos a hola@lasoderia.pe 📧`
    ));
  }

  // ── Cargar sesión desde Supabase ──
  let sesion = await getSesion(api, telefono);
  const msg = mensaje.toLowerCase().trim();

  // ── Palabras clave para reiniciar desde cualquier punto ──
  if (['hola', 'menu', 'menú', 'inicio', '0'].includes(msg)) {
    sesion = { paso: 'menu' };
  }

  // ════════════════════════════════════
  // PASO: MENÚ PRINCIPAL
  // ════════════════════════════════════
  if (sesion.paso === 'menu') {
    const nuevaSesion = { paso: 'esperando_menu' };
    await setSesion(api, telefono, nuevaSesion);
    return res.send(twimlResponse(
      `¡Hola, *${cliente.nombre}*! 🥤 Bienvenido a *La Sodería ATR*\n\n` +
      `¿Qué necesitás hoy?\n\n` +
      `1️⃣ Pedir recarga de soda\n` +
      `2️⃣ Mi cuenta\n` +
      `3️⃣ Hablar con alguien\n\n` +
      `_Respondé con el número de tu opción_`
    ));
  }

  // ════════════════════════════════════
  // PASO: RESPUESTA AL MENÚ
  // ════════════════════════════════════
  if (sesion.paso === 'esperando_menu') {

    if (msg === '1') {
      const dirs = [];
      if (cliente.direccion_1) dirs.push(cliente.direccion_1);
      if (cliente.direccion_2) dirs.push(cliente.direccion_2);

      if (dirs.length === 1) {
        const nuevaSesion = { paso: 'elegir_cantidad', direccion: dirs[0], distrito: cliente.distrito };
        await setSesion(api, telefono, nuevaSesion);
        return res.send(twimlResponse(
          `📍 Te entregamos en:\n*${dirs[0]}*\n\n` +
          `¿Cuántos sifones necesitás?\n\n` +
          `💡 Precios:\n` +
          `• 1-5 sifones: ${formatearPrecio(PRECIO_SIFON)} c/u\n` +
          `• Cajón completo (6): ${formatearPrecio(PRECIO_CAJON)} c/u\n\n` +
          `_Respondé con la cantidad (ej: 6)_`
        ));
      }

      // Tiene 2 direcciones — que elija
      let texto = `¿A qué dirección querés el pedido?\n\n`;
      dirs.forEach((d, i) => { texto += `${i + 1}️⃣ ${d}\n`; });
      await setSesion(api, telefono, { paso: 'eligiendo_direccion', dirs });
      return res.send(twimlResponse(texto + `\n_Respondé con el número_`));
    }

    if (msg === '2') {
      const dias = cliente.ultimo_pedido
        ? Math.floor((Date.now() - new Date(cliente.ultimo_pedido)) / 86400000)
        : null;
      await setSesion(api, telefono, { paso: 'menu' });
      return res.send(twimlResponse(
        `📋 *Tu cuenta*\n\n` +
        `👤 ${cliente.nombre} ${cliente.apellido}\n` +
        `📍 ${cliente.distrito}\n` +
        `📦 Cajones asignados: ${cliente.cajones_asignados}\n` +
        `🕐 Último pedido: ${dias !== null ? `hace ${dias} días` : 'sin pedidos aún'}\n\n` +
        `Para volver al menú escribí *menu*`
      ));
    }

    if (msg === '3') {
      await setSesion(api, telefono, { paso: 'menu' });
      return res.send(twimlResponse(
        `Te vamos a contactar a la brevedad. 📞\n\n` +
        `También podés escribirnos a *hola@lasoderia.pe*\n\n` +
        `Para volver al menú escribí *menu*`
      ));
    }

    return res.send(twimlResponse(
      `No entendí tu respuesta. 😅\n\nEscribí *1*, *2* o *3* para elegir una opción.`
    ));
  }

  // ════════════════════════════════════
  // PASO: ELIGIENDO DIRECCIÓN
  // ════════════════════════════════════
  if (sesion.paso === 'eligiendo_direccion') {
    const idx = parseInt(msg) - 1;
    if (isNaN(idx) || idx < 0 || idx >= sesion.dirs.length) {
      return res.send(twimlResponse(`Respondé con *1* o *2* según la dirección que querés.`));
    }
    const dir = sesion.dirs[idx];
    const nuevaSesion = { paso: 'elegir_cantidad', direccion: dir, distrito: cliente.distrito };
    await setSesion(api, telefono, nuevaSesion);
    return res.send(twimlResponse(
      `📍 *${dir}*\n\n` +
      `¿Cuántos sifones necesitás?\n\n` +
      `💡 Precios:\n` +
      `• 1-5 sifones: ${formatearPrecio(PRECIO_SIFON)} c/u\n` +
      `• Cajón completo (6): ${formatearPrecio(PRECIO_CAJON)} c/u\n\n` +
      `_Respondé con la cantidad (ej: 6)_`
    ));
  }

  // ════════════════════════════════════
  // PASO: ELEGIR CANTIDAD
  // ════════════════════════════════════
  if (sesion.paso === 'elegir_cantidad') {
    const cant = parseInt(msg);
    if (isNaN(cant) || cant < 1 || cant > 12) {
      return res.send(twimlResponse(`Por favor ingresá una cantidad válida entre 1 y 12 sifones.`));
    }
    await setSesion(api, telefono, { ...sesion, paso: 'elegir_cuando', cantidad: cant });
    return res.send(twimlResponse(
      `¿Cuándo necesitás la entrega?\n\n` +
      `1️⃣ Lo antes posible\n` +
      `2️⃣ Programar para otro día\n\n` +
      `_⚠️ El servicio está sujeto a disponibilidad del repartidor_`
    ));
  }

  // ════════════════════════════════════
  // PASO: ELEGIR CUÁNDO
  // ════════════════════════════════════
  if (sesion.paso === 'elegir_cuando') {
    if (msg === '1') {
      const cantidad = sesion.cantidad;
      const subtotal = calcularPrecio(cantidad);
      const total = subtotal + PRECIO_ENVIO;
      const esCajon = cantidad % SIFONES_POR_CAJON === 0;
      await setSesion(api, telefono, { ...sesion, paso: 'confirmar', dia: 'Lo antes posible', horario: 'Express', subtotal, total });
      return res.send(twimlResponse(
        `📋 *Resumen de tu pedido*\n\n` +
        `📍 ${sesion.direccion}\n` +
        `⚡ Entrega: *Lo antes posible*\n\n` +
        `🥤 ${cantidad} sifón${cantidad > 1 ? 'es' : ''} ${esCajon ? '(cajón completo)' : ''}\n` +
        `   ${esCajon ? `${cantidad} × ${formatearPrecio(PRECIO_CAJON)}` : `${cantidad} × ${formatearPrecio(PRECIO_SIFON)}`} = *${formatearPrecio(subtotal)}*\n` +
        `🚴 Envío: *${formatearPrecio(PRECIO_ENVIO)}*\n` +
        `──────────────────\n` +
        `💰 *TOTAL: ${formatearPrecio(total)}*\n\n` +
        `⚠️ _Sujeto a disponibilidad. Te confirmamos a la brevedad._\n\n` +
        `_El repartidor cobra en efectivo al entregar_\n\n` +
        `✅ Escribí *SI* para confirmar\n` +
        `❌ Escribí *NO* para cancelar`
      ));
    }
    if (msg === '2') {
      await setSesion(api, telefono, { ...sesion, paso: 'elegir_dia' });
      return res.send(twimlResponse(
        `¿Qué día preferís la entrega?\n\n` +
        DIAS.map((d, i) => `${i + 1}️⃣ ${d}`).join('\n') +
        `\n\n_Respondé con el número del día_`
      ));
    }
    return res.send(twimlResponse(`Respondé *1* para express o *2* para programar.`));
  }

  // ════════════════════════════════════
  // PASO: ELEGIR DÍA
  // ════════════════════════════════════
  if (sesion.paso === 'elegir_dia') {
    const idx = parseInt(msg) - 1;
    if (isNaN(idx) || idx < 0 || idx >= DIAS.length) {
      return res.send(twimlResponse(`Respondé con un número del 1 al ${DIAS.length}.`));
    }
    await setSesion(api, telefono, { ...sesion, paso: 'elegir_horario', dia: DIAS[idx] });
    return res.send(twimlResponse(
      `¿En qué horario?\n\n` +
      `1️⃣ 🌅 Mañana (9:00 - 12:00)\n` +
      `2️⃣ ☀️  Tarde (12:00 - 18:00)\n\n` +
      `_Respondé con 1 o 2_`
    ));
  }

  // ════════════════════════════════════
  // PASO: ELEGIR HORARIO
  // ════════════════════════════════════
  if (sesion.paso === 'elegir_horario') {
    const horarios = ['Mañana (9:00 - 12:00)', 'Tarde (12:00 - 18:00)'];
    const idx = parseInt(msg) - 1;
    if (isNaN(idx) || idx < 0 || idx > 1) {
      return res.send(twimlResponse(`Respondé con *1* para Mañana o *2* para Tarde.`));
    }
    const horario = horarios[idx];
    const cantidad = sesion.cantidad;
    const subtotal = calcularPrecio(cantidad);
    const total = subtotal + PRECIO_ENVIO;
    const esCajon = cantidad % SIFONES_POR_CAJON === 0;
    await setSesion(api, telefono, { ...sesion, paso: 'confirmar', horario, subtotal, total });
    return res.send(twimlResponse(
      `📋 *Resumen de tu pedido*\n\n` +
      `📍 ${sesion.direccion}\n` +
      `📅 ${sesion.dia} · ${horario}\n\n` +
      `🥤 ${cantidad} sifón${cantidad > 1 ? 'es' : ''} ${esCajon ? '(cajón completo)' : ''}\n` +
      `   ${esCajon ? `${cantidad} × ${formatearPrecio(PRECIO_CAJON)}` : `${cantidad} × ${formatearPrecio(PRECIO_SIFON)}`} = *${formatearPrecio(subtotal)}*\n` +
      `🚴 Envío: *${formatearPrecio(PRECIO_ENVIO)}*\n` +
      `──────────────────\n` +
      `💰 *TOTAL: ${formatearPrecio(total)}*\n\n` +
      `_El repartidor cobra en efectivo al entregar_\n\n` +
      `✅ Escribí *SI* para confirmar\n` +
      `❌ Escribí *NO* para cancelar`
    ));
  }

  // ════════════════════════════════════
  // PASO: CONFIRMAR PEDIDO
  // ════════════════════════════════════
  if (sesion.paso === 'confirmar') {

    if (msg === 'si' || msg === 'sí' || msg === 's') {

      // Buscar repartidor asignado a la zona
      let repartidorAsignado = null;
      try {
        const zonas = await api.get(
          'zonas_reparto',
          `activo=eq.true&select=*,repartidores(*)`
        );
        if (zonas && zonas.length > 0) {
          repartidorAsignado = zonas[0].repartidores;
        }
      } catch (e) {
        console.error('Error buscando repartidor:', e);
      }

      // Guardar pedido
      try {
        await api.post('pedidos', {
          cliente_id: cliente.id,
          repartidor_id: repartidorAsignado?.id || null,
          direccion_entrega: sesion.direccion,
          distrito: sesion.distrito || cliente.distrito,
          estado: 'confirmado',
          monto_cobrado: sesion.total,
          tipo_venta: 'delivery',
          notas: `Día: ${sesion.dia}. Horario: ${sesion.horario}. Sifones: ${sesion.cantidad}.`,
        }, 'return=minimal');

        // Actualizar último pedido del cliente
        await api.patch('clientes', `id=eq.${cliente.id}`, {
          ultimo_pedido: new Date().toISOString(),
        });
      } catch (e) {
        console.error('Error guardando pedido:', e);
        return res.send(twimlResponse(
          `Hubo un problema al guardar tu pedido. Por favor escribinos a *hola@lasoderia.pe* o intentá de nuevo con *menu*. 🙏`
        ));
      }

      // Notificar al repartidor
      if (repartidorAsignado?.telefono) {
        const msgRepartidor =
          `🥤 *NUEVO PEDIDO — La Sodería ATR*\n\n` +
          `👤 Cliente: ${cliente.nombre} ${cliente.apellido}\n` +
          `📞 Tel: ${cliente.telefono}\n` +
          `📍 ${sesion.direccion}\n` +
          `📅 ${sesion.dia} · ${sesion.horario}\n` +
          `🥤 Sifones: ${sesion.cantidad}\n` +
          `💰 Cobrar: *${formatearPrecio(sesion.total)}*\n` +
          `   (incluye envío ${formatearPrecio(PRECIO_ENVIO)})`;

        await enviarMensaje(accountSid, authToken, fromWA, `whatsapp:${repartidorAsignado.telefono}`, msgRepartidor).catch(e =>
          console.error('Error notificando repartidor:', e)
        );
      }

      await setSesion(api, telefono, { paso: 'menu' });
      return res.send(twimlResponse(
        `✅ *¡Pedido confirmado!*\n\n` +
        `📅 ${sesion.dia} · ${sesion.horario}\n` +
        `📍 ${sesion.direccion}\n` +
        `💰 Total a pagar: *${formatearPrecio(sesion.total)}*\n\n` +
        `El repartidor te va a contactar para coordinar. 🚴\n\n` +
        `_Escribí *menu* para hacer otro pedido_`
      ));
    }

    if (msg === 'no' || msg === 'n') {
      await setSesion(api, telefono, { paso: 'menu' });
      return res.send(twimlResponse(
        `Pedido cancelado. ❌\n\nEscribí *menu* cuando quieras hacer un pedido.`
      ));
    }

    return res.send(twimlResponse(`Respondé *SI* para confirmar o *NO* para cancelar.`));
  }

  // ── Fallback ──
  await setSesion(api, telefono, { paso: 'menu' });
  return res.send(twimlResponse(
    `Hola ${cliente.nombre}! 👋\n\nEscribí *menu* para ver las opciones.`
  ));
}
