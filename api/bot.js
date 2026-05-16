// api/bot.js — Bot de WhatsApp para La Sodería ATR
// Recibe mensajes de Twilio y responde según el estado de la conversación

const PRECIO_SIFON = 6.00;
const PRECIO_CAJON = 5.50; // por sifón cuando es cajón completo (6)
const PRECIO_ENVIO = 5.00;
const SIFONES_POR_CAJON = 6;

// Estado de conversaciones en memoria (por teléfono)
const sesiones = {};

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
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${mensaje}</Message>
</Response>`;
}

const DIAS = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method !== 'POST') {
    return res.status(405).send(twimlResponse('Método no permitido'));
  }

  const body = req.body;
  const telefono = (body.From || '').replace('whatsapp:','').trim();
  const mensaje = (body.Body || '').trim();

  if (!telefono) {
    return res.send(twimlResponse('Error: teléfono no recibido'));
  }

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;

  // ── Buscar cliente ──
  const clienteResp = await fetch(
    `${sbUrl}/rest/v1/rpc/buscar_cliente`,
    {
      method: 'POST',
      headers: {
        'apikey': sbKey,
        'Authorization': `Bearer ${sbKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: telefono.replace('+','') })
    }
  );
  const clientes = await clienteResp.json();
  const cliente = Array.isArray(clientes) && clientes.length > 0 ? clientes[0] : null;

  // ── Cliente no registrado ──
  if (!cliente) {
    return res.send(twimlResponse(
      `¡Hola! 👋 Aún no estás registrado como cliente de *La Sodería ATR*.\n\n` +
      `Para comenzar a recibir soda fresca en sifones, registrate acá:\n` +
      `🔗 lasoderia.pe/registro.html\n\n` +
      `Una vez aprobada tu cuenta, podés pedir cuando quieras por este chat. 🥤`
    ));
  }

  // ── Cliente pendiente ──
  if (cliente.estado === 'pendiente') {
    return res.send(twimlResponse(
      `Hola ${cliente.nombre}! 👋\n\n` +
      `Tu cuenta está siendo verificada. En menos de 24 horas te confirmamos la activación.\n\n` +
      `¿Tenés alguna duda? Respondé este mensaje y te ayudamos.`
    ));
  }

  // ── Cliente inactivo/suspendido ──
  if (cliente.estado !== 'activo') {
    return res.send(twimlResponse(
      `Hola ${cliente.nombre}! Tu cuenta está suspendida en este momento.\n\n` +
      `Para más información escribinos a hola@lasoderia.pe 📧`
    ));
  }

  // ── Sesión del cliente ──
  if (!sesiones[telefono]) sesiones[telefono] = { paso: 'menu' };
  const sesion = sesiones[telefono];
  const msg = mensaje.toLowerCase().trim();

  // ── Reiniciar en cualquier momento ──
  if (msg === 'hola' || msg === 'menu' || msg === 'inicio' || msg === '0') {
    sesiones[telefono] = { paso: 'menu' };
  }

  // ════════════════════════════════════
  // PASO: MENÚ PRINCIPAL
  // ════════════════════════════════════
  if (sesion.paso === 'menu') {
    sesiones[telefono] = { paso: 'esperando_menu' };
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
      // Construir lista de direcciones
      const dirs = [];
      if (cliente.direccion_1) dirs.push(cliente.direccion_1);
      if (cliente.direccion_2) dirs.push(cliente.direccion_2);

      if (dirs.length === 1) {
        sesiones[telefono] = { paso: 'elegir_cantidad', direccion: dirs[0], distrito: cliente.distrito };
        return res.send(twimlResponse(
          `📍 Te entregamos en:\n*${dirs[0]}*\n\n` +
          `¿Cuántos sifones necesitás?\n\n` +
          `💡 Precios:\n` +
          `• 1-5 sifones: ${formatearPrecio(PRECIO_SIFON)} c/u\n` +
          `• Cajón completo (6): ${formatearPrecio(PRECIO_CAJON)} c/u\n\n` +
          `_Respondé con la cantidad (ej: 6)_`
        ));
      } else {
        let texto = `¿A qué dirección querés el pedido?\n\n`;
        dirs.forEach((d,i) => texto += `${i+1}️⃣ ${d}\n`);
        sesiones[telefono] = { paso: 'eligiendo_direccion', dirs, cliente };
        return res.send(twimlResponse(texto + `\n_Respondé con el número_`));
      }
    }

    if (msg === '2') {
      const dias = cliente.ultimo_pedido
        ? Math.floor((Date.now() - new Date(cliente.ultimo_pedido)) / 86400000)
        : null;
      sesiones[telefono] = { paso: 'menu' };
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
      sesiones[telefono] = { paso: 'menu' };
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
    sesiones[telefono] = { ...sesion, paso: 'elegir_cantidad', direccion: dir, distrito: cliente.distrito };
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
    sesiones[telefono] = { ...sesion, paso: 'elegir_cuando', cantidad: cant };
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
      sesiones[telefono] = { ...sesion, paso: 'confirmar', dia: 'Lo antes posible', horario: 'Express', subtotal, total };
      return res.send(twimlResponse(
        `📋 *Resumen de tu pedido*\n\n` +
        `📍 ${sesion.direccion}\n` +
        `⚡ Entrega: *Lo antes posible*\n\n` +
        `🥤 ${cantidad} sifón${cantidad>1?'es':''} ${esCajon?'(cajón completo)':''}\n` +
        `   ${esCajon?`${cantidad} × ${formatearPrecio(PRECIO_CAJON)}`:`${cantidad} × ${formatearPrecio(PRECIO_SIFON)}`} = *${formatearPrecio(subtotal)}*\n` +
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
      sesiones[telefono] = { ...sesion, paso: 'elegir_dia' };
      return res.send(twimlResponse(
        `¿Qué día preferís la entrega?\n\n` +
        DIAS.map((d,i) => `${i+1}️⃣ ${d}`).join('\n') +
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
    sesiones[telefono] = { ...sesion, paso: 'elegir_horario', dia: DIAS[idx] };
    return res.send(twimlResponse(
      `¿En qué horario?\n\n` +
      `1️⃣ 🌅 Mañana (9:00 - 12:00)\n` +
      `2️⃣ ☀️ Tarde (12:00 - 18:00)\n\n` +
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

    sesiones[telefono] = { ...sesion, paso: 'confirmar', horario, subtotal, total };

    return res.send(twimlResponse(
      `📋 *Resumen de tu pedido*\n\n` +
      `📍 ${sesion.direccion}\n` +
      `📅 ${sesion.dia} · ${horario}\n\n` +
      `🥤 ${cantidad} sifón${cantidad>1?'es':''} ${esCajon?'(cajón completo)':''}\n` +
      `   ${esCajon?`${cantidad} × ${formatearPrecio(PRECIO_CAJON)}`:`${cantidad} × ${formatearPrecio(PRECIO_SIFON)}`} = *${formatearPrecio(subtotal)}*\n` +
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

      // Buscar repartidor por zona
      const zonasResp = await fetch(`${sbUrl}/rest/v1/zonas_reparto?activo=eq.true&select=*,repartidores(*)`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      const zonas = await zonasResp.json();

      let repartidorAsignado = null;
      if (zonas && zonas.length > 0 && cliente.latitud && cliente.longitud) {
        repartidorAsignado = zonas[0].repartidores; // Por ahora toma el primero
      } else if (zonas && zonas.length > 0) {
        repartidorAsignado = zonas[0].repartidores;
      }

      // Guardar pedido en Supabase
      const pedido = {
        cliente_id: cliente.id,
        repartidor_id: repartidorAsignado?.id || null,
        direccion_entrega: sesion.direccion,
        distrito: sesion.distrito || cliente.distrito,
        estado: 'confirmado',
        monto_cobrado: sesion.total,
        tipo_venta: 'delivery',
        notas: `Día: ${sesion.dia}. Horario: ${sesion.horario}. Sifones: ${sesion.cantidad}.`
      };

      await fetch(`${sbUrl}/rest/v1/pedidos`, {
        method: 'POST',
        headers: {
          'apikey': sbKey,
          'Authorization': `Bearer ${sbKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(pedido)
      });

      // Actualizar último pedido del cliente
      await fetch(`${sbUrl}/rest/v1/clientes?id=eq.${cliente.id}`, {
        method: 'PATCH',
        headers: {
          'apikey': sbKey,
          'Authorization': `Bearer ${sbKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ultimo_pedido: new Date().toISOString() })
      });

      // Notificar al repartidor por WhatsApp
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

        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const from = process.env.TWILIO_WHATSAPP_FROM;

        await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              From: from,
              To: `whatsapp:${repartidorAsignado.telefono}`,
              Body: msgRepartidor
            })
          }
        );
      }

      sesiones[telefono] = { paso: 'menu' };
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
      sesiones[telefono] = { paso: 'menu' };
      return res.send(twimlResponse(
        `Pedido cancelado. ❌\n\nEscribí *menu* cuando quieras hacer un pedido.`
      ));
    }

    return res.send(twimlResponse(`Respondé *SI* para confirmar o *NO* para cancelar.`));
  }

  // ── Fallback ──
  sesiones[telefono] = { paso: 'menu' };
  return res.send(twimlResponse(
    `Hola ${cliente.nombre}! 👋\n\nEscribí *menu* para ver las opciones.`
  ));
}
